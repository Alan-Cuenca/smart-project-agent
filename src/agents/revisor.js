import dotenv from 'dotenv';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { loadProjectConfig } from '../config/index.js';

dotenv.config();

/**
 * Esquema Zod de validación estricta para la salida del Agente Revisor.
 * Garantiza que las correcciones y verificaciones sean deterministas y libres de alucinaciones.
 */
export const RevisionSchema = z.object({
  auditSummary: z.string().describe('Resumen ejecutivo de la auditoría de calidad realizada sobre la propuesta del Ejecutor.'),
  consistencyScore: z.number().min(0).max(100).describe('Puntaje de coherencia, veracidad y realismo técnico (0 a 100).'),
  detectedHallucinations: z.array(z.string()).describe(
    'Lista de inconsistencias, alucinaciones de fechas, IDs inexistentes o miembros ficticios detectados y corregidos.'
  ),
  verifiedActions: z.array(
    z.object({
      cardId: z.string().describe('ID real y verificado de la tarjeta en Trello'),
      taskName: z.string().describe('Nombre verificado de la tarea'),
      currentList: z.string().describe('Lista actual donde reside la tarjeta'),
      validationStatus: z.enum(['APROBADO', 'CORREGIDO', 'RECHAZADO']).describe(
        'Estado de validación de la acción propuesta'
      ),
      actionType: z.enum(['REPROGRAMACION', 'REASIGNACION', 'CAMBIO_PRIORIDAD', 'DESGLOSE', 'SEGUIMIENTO']).describe(
        'Tipo de acción correctiva validada'
      ),
      suggestedDueDate: z.string().nullable().describe('Fecha límite corregida/validada en formato ISO'),
      suggestedAssignee: z.string().nullable().describe('Responsable sugerido verificado existente en el equipo'),
      technicalRationale: z.string().describe('Justificación técnica de la viabilidad de la acción'),
      reviewCorrectionNotes: z.string().nullable().describe('Nota explicativa si la acción requirió corrección o si fue descartada'),
    })
  ).describe('Acciones correctivas filtradas, contrastadas con los datos reales y técnicamente validadas.'),
  qualityVerdict: z.enum(['APROBADO_PARA_GESTION', 'REQUIERE_AJUSTES_MENORES', 'RECHAZADO']).describe(
    'Dictamen global de calidad del Revisor antes de pasar al Aprobador.'
  ),
});

/**
 * Instancia el modelo ChatOpenAI configurado con baja temperatura.
 * @param {Object} [customConfig={}]
 * @returns {ChatOpenAI}
 */
export const obtenerModeloRevisor = (customConfig = {}) => {
  const apiKey = customConfig.apiKey || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('[AgenteRevisor] OPENAI_API_KEY no configurada en las variables de entorno.');
  }

  return new ChatOpenAI({
    openAIApiKey: apiKey,
    modelName: customConfig.modelName || process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: 0.1, // Temperatura muy baja para máxima rigurosidad y detección de errores
    ...customConfig,
  });
};

/**
 * Agente Revisor: Actúa como filtro de calidad y consistencia técnica.
 * Contrasta la propuesta del Agente Ejecutor contra los datos reales de Trello
 * para eliminar alucinaciones y validar que las fechas y asignaciones sean realistas.
 * 
 * @param {string|Object} propuestaEjecutor - Salida textual o estructurada del Agente Ejecutor.
 * @param {Object} datosTrello - Snapshot verídico de Trello (Ground Truth).
 * @param {Object} [configProyecto] - Configuración general del proyecto.
 * @returns {Promise<Object>} Resultado validado y corregido por el Revisor.
 */
export async function revisarPropuesta(propuestaEjecutor, datosTrello, configProyecto = null) {
  try {
    if (!propuestaEjecutor) {
      throw new Error('[AgenteRevisor] Se requiere la propuesta generada por el Agente Ejecutor.');
    }
    if (!datosTrello || typeof datosTrello !== 'object') {
      throw new Error('[AgenteRevisor] Se requiere el snapshot original de Trello como fuente de verdad.');
    }

    const config = configProyecto || (() => {
      try {
        return loadProjectConfig();
      } catch {
        return { projectName: 'Proyecto Genérico' };
      }
    })();

    const projectName = config?.projectName || 'Proyecto Genérico';
    const fechaActual = new Date().toISOString();

    const systemPrompt = `
Eres un **Agente Revisor Senior de Calidad y Validación Técnica** para proyectos de software.
Estás auditando el proyecto: **"${projectName}"**.

Tu misión es actuar como el **filtro de calidad y consistencia**:
1. **Control de Alucinaciones (Ground Truth):** Contrasta cada afirmación del Agente Ejecutor contra el JSON real de Trello.
   - Verifica que los IDs de tarjeta (\`id\`), nombres de tarea y listas pertenezcan estrictamente al tablero auditado.
   - Verifica que los miembros sugeridos para reasignación realmente existan en la lista de \`members\` del tablero.
2. **Coherencia Matemática y Realismo Temporal:**
   - Fecha actual del sistema: **${fechaActual}**.
   - Ninguna fecha sugerida de reprogramación puede ser anterior o igual a la fecha actual.
   - Los plazos de reprogramación deben ser viables (evitar reprogramar tareas complejas para el mismo día).
3. **Depuración y Ajuste:**
   - Si una recomendación del Ejecutor es viable y veraz, márcala como \`APROBADO\`.
   - Si contiene datos erróneos pero la intención es válida, corrígela y márcala como \`CORREGIDO\` detallando la corrección en \`reviewCorrectionNotes\`.
   - Si es absurda, alucinada o inviable, márcala como \`RECHAZADO\`.

Tu dictamen debe ser quirúrgico, objetivo e implacable contra las alucinaciones.
`.trim();

    const systemMessage = new SystemMessage(systemPrompt);

    // Contexto de contraste: Ground Truth + Propuesta a auditar
    const payloadRevision = {
      timestampRevision: fechaActual,
      groundTruthTrello: {
        board: datosTrello.board,
        lists: datosTrello.lists,
        members: datosTrello.members,
        cardsResumen: (datosTrello.cards || []).map(c => ({
          id: c.id,
          name: c.name,
          listName: c.list?.name,
          dueDate: c.dueDate,
          dueComplete: c.dueComplete,
          assignees: (c.assignees || []).map(a => a.fullName || a.username),
        })),
      },
      propuestaEjecutor: typeof propuestaEjecutor === 'string' ? propuestaEjecutor : JSON.stringify(propuestaEjecutor, null, 2),
    };

    const humanMessage = new HumanMessage(
      `Audita rigurosamente la propuesta del Ejecutor frente al estado real de Trello:\n\n` +
      `\`\`\`json\n${JSON.stringify(payloadRevision, null, 2)}\n\`\`\`\n\n` +
      `Valida cada acción, corrige cualquier alucinación y genera el dictamen estructurado.`
    );

    console.log(`[AgenteRevisor] Auditando calidad y consistencia para el proyecto "${projectName}"...`);

    const modelo = obtenerModeloRevisor();
    const modeloEstructurado = modelo.withStructuredOutput(RevisionSchema, {
      name: 'AuditoriaCalidadRevisor',
    });

    const resultado = await modeloEstructurado.invoke([systemMessage, humanMessage]);

    console.log(
      `[AgenteRevisor] Auditoría completada. Veredicto: ${resultado.qualityVerdict} | Coherencia: ${resultado.consistencyScore}/100 | Acciones validadas: ${resultado.verifiedActions.length}`
    );

    return resultado;

  } catch (error) {
    console.error('[AgenteRevisor] Error al revisar la propuesta:', error.message);
    throw new Error(`[AgenteRevisor Falló]: ${error.message}`);
  }
}

export default {
  revisarPropuesta,
  obtenerModeloRevisor,
  RevisionSchema,
};
