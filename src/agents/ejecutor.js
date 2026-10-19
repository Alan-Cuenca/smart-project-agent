import dotenv from 'dotenv';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { loadProjectConfig } from '../config/index.js';

dotenv.config();

/**
 * Zod Schema for Structured Planning Audit Output.
 * Ensures the LLM response is strictly typed, deterministic, and immediately actionable
 * for downstream notification systems (Mailer) and workflow engines.
 */
export const PlanningAuditSchema = z.object({
  projectHealth: z.enum(['HEALTHY', 'ON_TRACK', 'AT_RISK', 'CRITICAL']).describe(
    'Estado general de salud de la planificación del proyecto basado en retrasos y carga de trabajo.'
  ),
  summary: z.string().describe(
    'Resumen ejecutivo conciso del estado de la planificación y principales hallazgos.'
  ),
  overdueTasks: z.array(
    z.object({
      cardId: z.string().describe('ID único de la tarjeta en Trello'),
      taskName: z.string().describe('Nombre de la tarea'),
      listName: z.string().describe('Nombre de la lista donde se encuentra'),
      dueDate: z.string().nullable().describe('Fecha de vencimiento en formato ISO'),
      daysOverdue: z.number().describe('Días exactos de retraso calculados matemáticamente frente a la fecha actual'),
      assignees: z.array(z.string()).describe('Responsables asignados a la tarea'),
      riskLevel: z.enum(['BAJO', 'MEDIO', 'ALTO', 'CRITICO']).describe('Nivel de riesgo del retraso'),
      correctiveAction: z.object({
        actionType: z.enum(['REPROGRAMACION', 'REASIGNACION', 'CAMBIO_PRIORIDAD', 'DESGLOSE_TAREA', 'ELIMINACION_BLOQUEO']),
        suggestedDueDate: z.string().nullable().describe('Nueva fecha límite sugerida si aplica'),
        suggestedAssignee: z.string().nullable().describe('Nuevo responsable sugerido si aplica'),
        priorityChange: z.string().nullable().describe('Cambio de prioridad sugerido'),
        recommendation: z.string().describe('Explicación detallada de la acción correctiva recomendada'),
      }),
    })
  ).describe('Listado detallado de tareas con fecha de vencimiento expirada y sus medidas correctivas.'),
  upcomingCriticalTasks: z.array(
    z.object({
      cardId: z.string().describe('ID de la tarjeta'),
      taskName: z.string().describe('Nombre de la tarea'),
      dueDate: z.string().describe('Fecha de vencimiento'),
      daysRemaining: z.number().describe('Días u horas restantes para el vencimiento'),
      assignees: z.array(z.string()).describe('Responsables'),
      proactiveMitigation: z.string().describe('Medida preventiva recomendada para asegurar su entrega a tiempo'),
    })
  ).describe('Tareas próximas a vencer en los siguientes 3 a 5 días con alto riesgo.'),
  workloadObservations: z.array(
    z.object({
      member: z.string().describe('Nombre del miembro del equipo'),
      activeTasksCount: z.number().describe('Total de tareas asignadas activas'),
      overdueTasksCount: z.number().describe('Total de tareas retrasadas'),
      observation: z.string().describe('Diagnóstico sobre sobrecarga o desbalance de trabajo'),
    })
  ).describe('Análisis de distribución de carga de trabajo entre los miembros del equipo.'),
  executiveRecommendations: z.array(
    z.string().describe('Punto de acción directo y concreto para el Project Manager')
  ).describe('Lista de acciones inmediatas recomendadas para el PM.'),
  markdownReport: z.string().describe(
    'Reporte completo redactado profesionalmente en Markdown con formato claro, tablas y emojis, listo para enviarse por correo.'
  ),
});

/**
 * Initializes and configures the OpenAI Chat Model.
 * @param {Object} [customConfig={}]
 * @returns {ChatOpenAI}
 */
export const createChatModel = (customConfig = {}) => {
  const apiKey = customConfig.apiKey || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      '[AgenteEjecutor] OPENAI_API_KEY no está configurada en las variables de entorno ni en la inicialización.'
    );
  }

  return new ChatOpenAI({
    modelName: customConfig.modelName || process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: customConfig.temperature ?? 0.2, // Baja temperatura para análisis matemático y determinista
    apiKey,
    timeout: 30000,
    ...customConfig,
  });
};

/**
 * Agente Ejecutor: Analiza el estado actual de Trello para detectar retrasos,
 * calcular diferencias temporales exactas y generar propuestas de acciones correctivas.
 *
 * @param {Object} datosTrello - JSON limpio y estructurado proveniente de src/integrations/trello.js.
 * @param {Object} [configProyecto] - Configuración del proyecto (projectName, projectManagerEmail, etc.).
 * @param {Object} [options={}] - Opciones adicionales (rawTextOnly, modelOverrides, etc.).
 * @returns {Promise<Object>} Resultado del análisis estructurado (incluye markdownReport y métricas de acción).
 */
export const analizarPlanificacion = async (datosTrello, configProyecto = null, options = {}) => {
  try {
    // 1. Validar entrada de datos
    if (!datosTrello || typeof datosTrello !== 'object') {
      throw new Error('[AgenteEjecutor] Se requieren los datos estructurados de Trello (datosTrello) para el análisis.');
    }

    // 2. Resolver configuración del proyecto (fallback automático si no se provee)
    let projectConfig = configProyecto;
    if (!projectConfig) {
      try {
        projectConfig = loadProjectConfig();
      } catch {
        projectConfig = { projectName: 'Proyecto Genérico' };
      }
    }

    const projectName = projectConfig.projectName || datosTrello.board?.name || 'Proyecto Sin Nombre';
    const currentDateISO = new Date().toISOString();

    // 3. Prompt Engineering: Construcción del SystemMessage Dinámico
    const systemPromptContent = `
Eres un **Agente Ejecutor Senior** experto en auditoría técnica, métricas ágiles y gestión de proyectos (Scrum/Kanban).
Tu tarea es auditar y analizar rigurosamente el estado del proyecto **"${projectName}"**.

**Contexto Temporal Crítico:**
- La fecha y hora actual exacta del sistema es: **${currentDateISO}**.
- Todas las comparaciones de fechas límite (\`dueDate\`) deben realizarse de forma estricta y matemática contra este momento temporal exacto.

**Objetivos del Análisis:**
1. **Identificación de Retrasos:** Identifica de forma inequívoca qué tareas tienen fecha de vencimiento (\`dueDate\`) anterior a la fecha actual y aún no están completadas (\`dueComplete: false\`). Calcula los días exactos de retraso.
2. **Tareas en Riesgo Inminente:** Detecta tareas que vencen en los próximos 3 a 5 días y evalúa si su lista o asignación pone en peligro la entrega.
3. **Distribución de Carga:** Evalúa si algún miembro tiene un cuello de botella o sobrecarga de tareas vencidas.
4. **Propuestas de Acción Correctiva Concretas:**
   - Proponer **reprogramación** con fechas realistas basadas en el desfase.
   - Proponer **cambios de prioridad** o traspaso de tarjetas.
   - Proponer **reasignación de responsable** en caso de sobrecarga demostrada.

Debes entregar un análisis profesional, objetivo, sin ambigüedades y orientado a la toma de decisiones inmediata por parte del Project Manager.
`.trim();

    const systemMessage = new SystemMessage(systemPromptContent);

    // 4. Inyección de datosTrello en el HumanMessage
    const humanPromptPayload = {
      auditTimestamp: currentDateISO,
      projectContext: {
        projectName,
        repositoryUrl: projectConfig.repositoryUrl || null,
        projectManagerEmail: projectConfig.projectManagerEmail || null,
      },
      trelloData: datosTrello,
    };

    const humanMessage = new HumanMessage(
      `A continuación tienes el volcado JSON estructurado del tablero de Trello del proyecto:\n\n` +
      `\`\`\`json\n${JSON.stringify(humanPromptPayload, null, 2)}\n\`\`\`\n\n` +
      `Realiza la auditoría de planificación completa, calculando los desfases matemáticos y formulando las acciones correctivas.`
    );

    // 5. Instanciar el modelo de OpenAI
    const model = createChatModel(options.modelConfig);

    console.log(`[AgenteEjecutor] Iniciando análisis de planificación para el proyecto: "${projectName}"...`);

    // 6. Ejecutar llamada con Function Calling / Structured Output
    if (options.rawTextOnly) {
      // Modo texto plano si se solicita explícitamente
      const response = await model.invoke([systemMessage, humanMessage]);
      console.log(`[AgenteEjecutor] Análisis completado con éxito (formato texto plano).`);
      return {
        format: 'text',
        content: response.content,
      };
    }

    // Modo estructurado (garantizado con Zod Schema)
    const structuredModel = model.withStructuredOutput(PlanningAuditSchema, {
      name: 'AuditoriaPlanificacionProyecto',
    });

    const analysisResult = await structuredModel.invoke([systemMessage, humanMessage]);

    console.log(
      `[AgenteEjecutor] Análisis completado con éxito. Estado: ${analysisResult.projectHealth} | Retrasos detectados: ${analysisResult.overdueTasks.length}`
    );

    return {
      format: 'structured',
      projectName,
      auditedAt: currentDateISO,
      ...analysisResult,
    };
  } catch (error) {
    console.error('[AgenteEjecutor] Error durante el análisis de planificación con OpenAI:', error.message);

    // Manejo de errores específicos de OpenAI / Red
    let friendlyMessage = error.message;
    if (error.status === 401 || error.message.includes('401')) {
      friendlyMessage = 'Credenciales de OpenAI no válidas (Verifica OPENAI_API_KEY en .env).';
    } else if (error.status === 429 || error.message.includes('429')) {
      friendlyMessage = 'Límite de tasa o cuota excedida en la API de OpenAI (Rate Limit / Quota Exceeded).';
    }

    throw new Error(`[AgenteEjecutor Falló]: ${friendlyMessage}`);
  }
};

export default {
  analizarPlanificacion,
  createChatModel,
  PlanningAuditSchema,
};
