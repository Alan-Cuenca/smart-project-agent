import dotenv from 'dotenv';
import { z } from 'zod';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { loadProjectConfig } from '../config/index.js';

dotenv.config();

/**
 * Esquema Zod de salida para el Agente Aprobador.
 * Contiene el dictamen de gobernanza, la clasificación de impacto
 * y los parámetros técnicos exactos de Trello para su ejecución posterior.
 * Compatible con la especificación de tipos Protobuf de Google Gemini.
 */
export const AprobadorVerdictSchema = z.object({
  projectMetadata: z.object({
    projectName: z.string().describe('Nombre del proyecto auditado'),
    projectManagerEmail: z.string().optional().describe('Correo del Gestor del Proyecto'),
    repositoryUrl: z.string().optional().describe('URL del repositorio'),
    trelloBoardId: z.string().optional().describe('ID del tablero auditado'),
  }),
  governancePolicy: z.string().describe('Declaración inmutable de la regla de oro de gobernanza.'),
  overallRisk: z.enum(['BAJO', 'MEDIO', 'ALTO', 'CRITICO']).describe(
    'Nivel de riesgo global del proyecto tras evaluar retrasos e impactos.'
  ),
  executiveSummary: z.string().describe(
    'Resumen ejecutivo directo y claro para que el Gestor del Proyecto tome decisiones rápidas.'
  ),
  actionItems: z.array(
    z.object({
      itemCode: z.string().describe('Código único de la propuesta de cambio (ej: SOL-01)'),
      cardId: z.string().describe('ID exacto de la tarjeta en Trello'),
      cardName: z.string().describe('Nombre de la tarjeta en Trello'),
      detectedProblem: z.string().describe('Problema detectado (ej: 5 días de retraso sin avance)'),
      recommendedAction: z.string().describe('Acción recomendada específica'),
      technicalJustification: z.string().describe('Justificación técnica de la recomendación'),
      impactLevel: z.enum(['BAJO', 'MEDIO', 'ALTO', 'CRITICO']).describe(
        'Nivel de impacto en el cronograma y recursos'
      ),
      requiresApproval: z.boolean().default(true).describe('Indica obligatoriamente la necesidad de confirmación humana'),
      trelloExecutionParams: z.object({
        idCard: z.string().describe('ID de la tarjeta a actualizar en la API de Trello'),
        due: z.string().optional().describe('Nueva fecha límite ISO para la API de Trello o vacio si no aplica'),
        idMembers: z.array(z.string()).default([]).describe('IDs de miembros para la API de Trello o vacío si no cambia'),
        idList: z.string().optional().describe('ID de la lista destino en Trello si aplica mover la tarjeta'),
      }).describe('Parámetros exactos preparados para consumir por la API de Trello si el Gestor autoriza.'),
    })
  ).describe('Paquete de solicitudes de cambio estructuradas para autorización del PM.'),
  emailSubject: z.string().describe('Asunto formal para la notificación por correo electrónico al Gestor.'),
  emailBodyMarkdown: z.string().describe(
    'Cuerpo completo del reporte en Markdown estructurado, con tablas, justificaciones y llamadas a la acción para el Gestor.'
  ),
});

/**
 * Resuelve el nombre del modelo Gemini adecuado.
 * @param {string} [customModel]
 * @returns {string}
 */
const resolverModeloGemini = (customModel) => {
  const rawModel = customModel || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  if (rawModel.includes('1.5') || rawModel.includes('2.5')) {
    return 'gemini-3.8-flash';
  }
  return rawModel;
};

/**
 * Instancia el modelo ChatGoogleGenerativeAI para el Agente Aprobador.
 * @param {Object} [customConfig={}]
 * @returns {ChatGoogleGenerativeAI}
 */
export const obtenerModeloAprobador = (customConfig = {}) => {
  const apiKey = customConfig.apiKey || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('[AgenteAprobador] GEMINI_API_KEY no configurada en las variables de entorno.');
  }

  const selectedModel = resolverModeloGemini(customConfig.model || customConfig.modelName);

  return new ChatGoogleGenerativeAI({
    apiKey: apiKey,
    model: selectedModel,
    modelName: selectedModel,
    temperature: 0.1, // Baja temperatura para estricta gobernanza
    ...customConfig,
  });
};

/**
 * Agente Aprobador: Evalúa las acciones previamente depuradas por el Revisor,
 * clasifica su impacto/riesgo y estructura el dictamen final con la regla de oro:
 * "Ningún cambio en Trello puede ejecutarse sin la autorización del Gestor del Proyecto".
 * 
 * @param {Object} propuestaRevisada - Objeto estructurado validado por el Agente Revisor.
 * @param {Object} [datosTrello] - Snapshot de Trello para mapear IDs exactos si se requiere.
 * @param {Object} [configProyecto] - Configuración del proyecto (project.config.json).
 * @returns {Promise<Object>} Dictamen final estructurado listo para enviar por correo al Gestor.
 */
export async function evaluarAprobacion(propuestaRevisada, datosTrello = null, configProyecto = null) {
  try {
    if (!propuestaRevisada) {
      throw new Error('[AgenteAprobador] Se requieren las acciones validadas del Agente Revisor.');
    }

    const config = configProyecto || (() => {
      try {
        return loadProjectConfig();
      } catch {
        return { projectName: 'Proyecto Genérico' };
      }
    })();

    const projectName = config?.projectName || 'Proyecto Genérico';
    const projectManagerEmail = config?.projectManagerEmail || 'No especificado';
    const trelloBoardId = config?.trelloBoardId || datosTrello?.board?.id || null;

    const systemPrompt = `
Eres el **Agente Aprobador y Oficial de Gobernanza de Proyectos**.
Estás evaluando la auditoría técnica del proyecto: **"${projectName}"**.

**REGLA DE ORO DE GOBERNANZA (OBLIGATORIA E INQUEBRANTABLE):**
"Ninguna modificación que afecte la planificación, las fechas o las tarjetas de Trello puede ejecutarse automáticamente sin la autorización humana previa y explícita del Gestor del Proyecto (${projectManagerEmail})."

**Tus responsabilidades:**
1. **Clasificación de Riesgo e Impacto:**
   - **BAJO:** Ajustes menores de reprogramación (1-2 días) en tareas no críticas.
   - **MEDIO:** Reasignación de miembros o reprogramación de 3-5 días.
   - **ALTO/CRITICO:** Retrasos significativos que comprometen hitos clave, cuellos de botella severos o tareas bloqueadas.
2. **Determinación de Acciones Solicitables:**
   - Filtra únicamente las acciones que aporten valor real y no generen desestabilización en el equipo.
3. **Estructuración de Parámetros de Trello:**
   - Provee en \`trelloExecutionParams\` los parámetros exactos (ID de tarjeta, fecha ISO nueva, lista destino, IDs de miembros) para que, en caso de que el Gestor apruebe, el sistema pueda ejecutar la actualización en la API de Trello sin necesidad de volver a consultar a la IA.
4. **Redacción del Informe para el Gestor:**
   - Genera un asunto claro (\`emailSubject\`) y un reporte en Markdown profesional (\`emailBodyMarkdown\`) que presente de forma transparente: el problema detectado, la acción recomendada, la justificación técnica, el impacto y cómo autorizar el cambio.
`.trim();

    const systemMessage = new SystemMessage(systemPrompt);

    const payloadEvaluacion = {
      projectConfig: {
        projectName,
        projectManagerEmail,
        repositoryUrl: config?.repositoryUrl || null,
        trelloBoardId,
      },
      propuestaRevisada,
      trelloContext: datosTrello ? {
        boardName: datosTrello.board?.name,
        totalCards: datosTrello.metrics?.totalCards,
        overdueCards: datosTrello.metrics?.overdueCards,
        members: datosTrello.members,
      } : null,
    };

    const humanMessage = new HumanMessage(
      `Evalúa las siguientes acciones validadas por el Revisor y emite el dictamen final para el Gestor:\n\n` +
      `\`\`\`json\n${JSON.stringify(payloadEvaluacion, null, 2)}\n\`\`\`\n\n` +
      `Aplica estrictamente la regla de gobernanza (HITL) y genera el paquete de aprobación.`
    );

    const modelo = obtenerModeloAprobador();
    console.log(`[AgenteAprobador] Evaluando impacto y gobernanza con Gemini (${modelo.model}) para el proyecto "${projectName}"...`);

    const modeloEstructurado = modelo.withStructuredOutput(AprobadorVerdictSchema, {
      name: 'DictamenAprobacionGobernanza',
    });

    const dictamen = await modeloEstructurado.invoke([systemMessage, humanMessage]);

    console.log(
      `[AgenteAprobador] Dictamen emitido. Riesgo: ${dictamen.overallRisk} | Solicitudes de cambio: ${dictamen.actionItems?.length || 0} | Requiere aprobación humana: SÍ`
    );

    return dictamen;

  } catch (error) {
    console.error('[AgenteAprobador] Error al evaluar aprobación con Google Gemini:', error.message);
    throw new Error(`[AgenteAprobador Falló]: ${error.message}`);
  }
}

export default {
  evaluarAprobacion,
  obtenerModeloAprobador,
  AprobadorVerdictSchema,
};
