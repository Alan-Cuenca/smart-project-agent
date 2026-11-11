import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { loadProjectConfig } from '../config/index.js';
import { invocarGemini } from './modelo.js';
import { equipoParaPrompt } from './ejecutor.js';

/**
 * Esquema Zod de validación estricta para la salida del Agente Revisor.
 * Garantiza que las correcciones y verificaciones sean deterministas y libres de alucinaciones.
 * Compatible con la especificación de tipos Protobuf de Google Gemini.
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
      actionType: z.enum(['ASIGNACION', 'REPROGRAMACION', 'COMENTARIO', 'SEGUIMIENTO']).describe(
        'Tipo de acción correctiva validada'
      ),
      suggestedDueDate: z.string().optional().describe('Fecha límite corregida/validada en formato ISO'),
      suggestedAssigneeIds: z.array(z.string()).optional().describe(
        'trelloMemberId de los responsables sugeridos (solo miembros con puedeRecibirTareas: true)'
      ),
      suggestedComment: z.string().optional().describe('Texto del comentario a publicar en la tarjeta, si la acción es COMENTARIO'),
      technicalRationale: z.string().describe('Justificación técnica de la viabilidad de la acción'),
      reviewCorrectionNotes: z.string().optional().describe('Nota explicativa si la acción requirió corrección o si fue descartada'),
    })
  ).describe('Acciones correctivas filtradas, contrastadas con los datos reales y técnicamente validadas.'),
  qualityVerdict: z.enum(['APROBADO_PARA_GESTION', 'REQUIERE_AJUSTES_MENORES', 'RECHAZADO']).describe(
    'Dictamen global de calidad del Revisor antes de pasar al Aprobador.'
  ),
});

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
export async function revisarPropuesta(propuestaEjecutor, datosTrello, configProyecto = null, metricas = null) {
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
Eres un **Agente Revisor Senior de Calidad y Validación Técnica** para proyectos de software con fecha de entrega fija.
Estás auditando el proyecto: **"${projectName}"**.

Tu misión es actuar como el **filtro de calidad y consistencia**:
1. **Control de Alucinaciones (Ground Truth):** Contrasta cada afirmación del Agente Ejecutor contra los datos reales.
   - Verifica que los IDs de tarjeta, nombres de tarea y fases pertenezcan al tablero auditado y que la tarea esté PENDIENTE.
   - Verifica que los responsables sugeridos existan en \`equipo\` y tengan \`puedeRecibirTareas: true\`. Rechaza o corrige cualquier asignación a revisores.
   - Verifica que las cifras citadas coincidan con las métricas calculadas por el sistema.
2. **Coherencia Temporal:**
   - Fecha actual del sistema: **${fechaActual}**.${metricas?.entrega ? `\n   - Fecha de entrega del proyecto: **${metricas.entrega.fecha}**. Ninguna fecha puede superarla.` : ''}
   - Ninguna fecha sugerida puede ser anterior o igual a la fecha actual, y los plazos deben ser viables.
3. **Coherencia de Roles:** las asignaciones deben corresponder al rol de cada persona (p. ej. documentación → rol de documentación; despliegue/backend → roles técnicos) y considerar su carga actual.
4. **Comentarios:** deben ser concretos, accionables y basados en hechos de los datos (alertas, CI, commits). Rechaza comentarios genéricos.
5. **Depuración y Ajuste:**
   - Si una recomendación del Ejecutor es viable y veraz, márcala como \`APROBADO\`.
   - Si contiene datos erróneos pero la intención es válida, corrígela y márcala como \`CORREGIDO\` detallando la corrección en \`reviewCorrectionNotes\`.
   - Si es absurda, alucinada o inviable, márcala como \`RECHAZADO\`.

Tu dictamen debe ser quirúrgico, objetivo e implacable contra las alucinaciones.
`.trim();

    const systemMessage = new SystemMessage(systemPrompt);

    // Contexto de contraste: Ground Truth + Propuesta a auditar
    const payloadRevision = {
      timestampRevision: fechaActual,
      groundTruth: metricas
        ? {
            entrega: metricas.entrega,
            faseActual: metricas.faseActual,
            fases: metricas.fases.map(({ id, nombre, avance, pendientes, inicio, fin }) => ({ id, nombre, avance, pendientes, inicio, fin })),
            tareasPendientes: metricas.tareasPendientes,
            equipo: equipoParaPrompt(metricas),
            alertas: metricas.alertas,
            ci: metricas.repositorio?.ci || null,
          }
        : {
            lists: datosTrello.lists,
            members: datosTrello.members,
            cardsResumen: (datosTrello.cards || []).map((c) => ({
              id: c.id,
              name: c.name,
              listName: c.list?.name,
              dueDate: c.dueDate,
              dueComplete: c.dueComplete,
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

    const { resultado } = await invocarGemini({
      agente: 'AgenteRevisor',
      mensajes: [systemMessage, humanMessage],
      temperature: 0.1, // Temperatura muy baja para máxima rigurosidad y detección de errores
      schema: RevisionSchema,
      schemaName: 'AuditoriaCalidadRevisor',
    });

    console.log(
      `[AgenteRevisor] Auditoría completada. Veredicto: ${resultado.qualityVerdict} | Coherencia: ${resultado.consistencyScore}/100 | Acciones validadas: ${resultado.verifiedActions?.length || 0}`
    );

    return resultado;

  } catch (error) {
    console.error('[AgenteRevisor] Error al procesar la auditoría con Google Gemini:', error.message);
    throw new Error(`[AgenteRevisor Falló]: ${error.message}`);
  }
}

export default {
  revisarPropuesta,
  RevisionSchema,
};
