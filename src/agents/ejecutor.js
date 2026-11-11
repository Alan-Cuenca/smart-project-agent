import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { loadProjectConfig } from '../config/index.js';
import { invocarGemini } from './modelo.js';

/**
 * Agente Ejecutor: Analiza el estado de las actividades de Trello,
 * detecta desviaciones temporales frente a la fecha actual y genera
 * una propuesta textual con medidas de acción correctiva.
 * 
 * @param {Object} datosTrello - JSON estructurado con listas, tarjetas, miembros y fechas de Trello.
 * @param {Object} [configProyecto] - Configuración del proyecto (projectName, projectManagerEmail, etc.).
 * @returns {Promise<string>} Propuesta textual elaborada por la IA para el Agente Revisor.
 */
export async function analizarPlanificacion(datosTrello, configProyecto = null) {
  try {
    // Validar datos de entrada
    if (!datosTrello || typeof datosTrello !== 'object') {
      throw new Error('[AgenteEjecutor] Se requiere el objeto JSON estructurado de Trello (datosTrello).');
    }

    // Resolver configuración del proyecto (utiliza el archivo local si no se provee como argumento)
    const config = configProyecto || (() => {
      try {
        return loadProjectConfig();
      } catch {
        return { projectName: 'Proyecto Genérico' };
      }
    })();

    const projectName = config?.projectName || 'Proyecto Genérico';
    const fechaActual = new Date().toISOString();

    // 1. Prompt Engineering: Definición del SystemMessage parametrizado
    const promptSistema = 
      `Eres un Agente Ejecutor experto en gestión ágil auditando el proyecto ${projectName}. ` +
      `Analiza el siguiente estado de actividades. ` +
      `Identifica matemáticamente qué tareas están retrasadas o próximas a vencer basándote en la fecha límite (dueDate) frente a la fecha actual (${fechaActual}). ` +
      `Para cada problema detectado, genera alternativas de acción correctiva (reprogramación, cambio de prioridad o reasignación). ` +
      `Presenta tu propuesta en un formato claro, estructurado y analítico, listo para ser revisado por el Agente Revisor y el Project Manager.`;

    const systemMessage = new SystemMessage(promptSistema);

    // 3. Inyección de Datos: HumanMessage con el JSON de Trello
    const contenidoUsuario = 
      `A continuación se presenta el estado actual de actividades del tablero en formato JSON:\n\n` +
      `\`\`\`json\n${JSON.stringify(datosTrello, null, 2)}\n\`\`\`\n\n` +
      `Por favor, elabora tu diagnóstico analítico y tu propuesta de acciones correctivas.`;

    const humanMessage = new HumanMessage(contenidoUsuario);

    console.log(`[AgenteEjecutor] Analizando planificación del proyecto "${projectName}"...`);

    // 3. Llamada a la IA (con tiempo límite y modelos de respaldo) y retorno de la propuesta textual
    const { resultado } = await invocarGemini({
      agente: 'AgenteEjecutor',
      mensajes: [systemMessage, humanMessage],
      temperature: 0.2, // Temperatura baja para respuestas analíticas y no creativas
    });

    console.log(`[AgenteEjecutor] Propuesta de planificación generada exitosamente.`);
    return resultado.content;

  } catch (error) {
    console.error('[AgenteEjecutor] Error al procesar la auditoría con Google Gemini:', error.message);
    throw new Error(`[AgenteEjecutor Falló]: ${error.message}`);
  }
}

export default {
  analizarPlanificacion,
};
