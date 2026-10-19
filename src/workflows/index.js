import { fetchTrelloBoardSnapshot } from '../integrations/trello.js';
import { analizarPlanificacion } from '../agents/ejecutor.js';
import { revisarPropuesta } from '../agents/revisor.js';
import { evaluarAprobacion } from '../agents/aprobador.js';
import { loadProjectConfig } from '../config/index.js';
import { sendProjectAlert, enviarSolicitudAprobacion } from '../notifications/mailer.js';

/**
 * Registra un mensaje formateado con marca de tiempo ISO en consola.
 * @param {string} etapa 
 * @param {string} mensaje 
 */
const logEtapa = (etapa, mensaje) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${etapa}] ${mensaje}`);
};

/**
 * Orquestador Principal del Sistema Multiagente (Smart Project Agent).
 * Ejecuta en secuencia estricta el pipeline:
 * Paso A: Extracción de datos de Trello (Integración)
 * Paso B: Detección analítica y propuesta inicial (Agente Ejecutor)
 * Paso C: Filtro de calidad y control de alucinaciones (Agente Revisor)
 * Paso D: Evaluación de impacto, gobernanza HITL y dictamen final (Agente Aprobador)
 * 
 * @param {Object} [opciones={}]
 * @param {string} [opciones.boardId] - ID específico del tablero de Trello (opcional).
 * @param {Object} [opciones.configProyecto] - Sobreescritura opcional de la configuración del proyecto.
 * @param {boolean} [opciones.notificarPM=false] - Si es true, envía automáticamente el correo al Gestor vía Mailer.
 * @returns {Promise<Object>} Paquete integral con las salidas trazables de cada etapa y el dictamen final.
 */
export async function ejecutarFlujoSeguimiento(opciones = {}) {
  const inicioTimestamp = new Date().toISOString();
  logEtapa('INICIO_FLUJO', '=======================================================');
  logEtapa('INICIO_FLUJO', 'Iniciando Flujo Secuencial: Ejecutor -> Revisor -> Aprobador');
  logEtapa('INICIO_FLUJO', '=======================================================');

  try {
    // 0. Cargar configuración agnóstica del proyecto
    const config = opciones.configProyecto || loadProjectConfig();
    const projectName = config?.projectName || 'Proyecto Genérico';
    logEtapa('CONFIGURACION', `Proyecto cargado: "${projectName}" | PM: ${config?.projectManagerEmail || 'No asignado'}`);

    // =========================================================================
    // PASO A: INTEGRACIÓN TRELLO (Snapshot Ground Truth)
    // =========================================================================
    logEtapa('PASO_A_TRELLO', 'Consultando snapshot del tablero de Trello...');
    const snapshotTrello = await fetchTrelloBoardSnapshot(opciones.boardId);
    
    logEtapa(
      'PASO_A_TRELLO',
      `Snapshot obtenido con éxito: Tablero "${snapshotTrello.board?.name}" | ` +
      `Total tarjetas: ${snapshotTrello.metrics?.totalCards} | ` +
      `Vencidas: ${snapshotTrello.metrics?.overdueCards} | ` +
      `En progreso: ${snapshotTrello.metrics?.pendingCards}`
    );

    // =========================================================================
    // PASO B: AGENTE EJECUTOR (Detección y Propuesta Inicial)
    // =========================================================================
    logEtapa('PASO_B_EJECUTOR', 'Ejecutando Agente Ejecutor para detección matemática de desviaciones...');
    const salidaEjecutor = await analizarPlanificacion(snapshotTrello, config);
    
    logEtapa('PASO_B_EJECUTOR', 'Propuesta analítica generada exitosamente por el Agente Ejecutor.');

    // =========================================================================
    // PASO C: AGENTE REVISOR (Filtro de Calidad y Anti-Alucinaciones)
    // =========================================================================
    logEtapa('PASO_C_REVISOR', 'Ejecutando Agente Revisor para contrastar contra Ground Truth...');
    const salidaRevisor = await revisarPropuesta(salidaEjecutor, snapshotTrello, config);

    logEtapa(
      'PASO_C_REVISOR',
      `Revisión finalizada. Dictamen: ${salidaRevisor.qualityVerdict} | ` +
      `Puntaje de coherencia: ${salidaRevisor.consistencyScore}/100 | ` +
      `Acciones verificadas: ${salidaRevisor.verifiedActions?.length || 0} | ` +
      `Alucinaciones corregidas: ${salidaRevisor.detectedHallucinations?.length || 0}`
    );

    // =========================================================================
    // PASO D: AGENTE APROBADOR (Gobernanza HITL y Paquete de Autorización)
    // =========================================================================
    logEtapa('PASO_D_APROBADOR', 'Ejecutando Agente Aprobador para evaluación de impacto y gobernanza...');
    const dictamenAprobador = await evaluarAprobacion(salidaRevisor, snapshotTrello, config);

    logEtapa(
      'PASO_D_APROBADOR',
      `Dictamen de gobernanza emitido con éxito. Riesgo Global: ${dictamenAprobador.overallRisk} | ` +
      `Solicitudes de cambio preparadas: ${dictamenAprobador.actionItems?.length || 0} | ` +
      `Regla HITL activa: SÍ`
    );

    // =========================================================================
    // PASO OPCIONAL: NOTIFICACIÓN DINÁMICA AL PM
    // =========================================================================
    let notificacionResultado = null;
    if (opciones.notificarPM) {
      logEtapa('NOTIFICACION', `Enviando solicitud de aprobación interactiva al Gestor (${config.projectManagerEmail})...`);
      try {
        notificacionResultado = await enviarSolicitudAprobacion(dictamenAprobador, config);
        logEtapa('NOTIFICACION', `Correo de aprobación interactivo enviado exitosamente (Acciones: ${notificacionResultado.registeredActionsCount}).`);
      } catch (mailError) {
        logEtapa('NOTIFICACION_WARN', `No se pudo enviar el correo: ${mailError.message}`);
      }
    }

    const finTimestamp = new Date().toISOString();
    logEtapa('FIN_FLUJO', `Flujo de seguimiento completado exitosamente a las ${finTimestamp}.`);

    return {
      success: true,
      metadata: {
        projectName,
        inicioTimestamp,
        finTimestamp,
        boardId: snapshotTrello.board?.id,
      },
      trelloSnapshot: snapshotTrello,
      ejecutorOutput: salidaEjecutor,
      revisorOutput: salidaRevisor,
      aprobadorVerdict: dictamenAprobador,
      notificacion: notificacionResultado,
    };

  } catch (error) {
    logEtapa('ERROR_FATAL', `Fallo durante el flujo de seguimiento: ${error.message}`);
    throw error;
  }
}

export default {
  ejecutarFlujoSeguimiento,
};
