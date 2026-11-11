import { fetchTrelloBoardSnapshot } from '../integrations/trello.js';
import { analizarPlanificacion } from '../agents/ejecutor.js';
import { revisarPropuesta } from '../agents/revisor.js';
import { evaluarAprobacion } from '../agents/aprobador.js';
import { loadProjectConfig } from '../config/index.js';
import { enviarSolicitudAprobacion } from '../notifications/mailer.js';
import { validarAccionesContraTrello } from './validacion.js';
import { obtenerActividadRepositorio } from '../integrations/github.js';
import { calcularMetricas } from '../analysis/metricas.js';

const DIAS_VENTANA_GITHUB = 14;

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
    console.log('📋 [Trello] Extrayendo datos y métricas del tablero...');
    logEtapa('PASO_A_TRELLO', 'Consultando snapshot del tablero de Trello...');
    const snapshotTrello = await fetchTrelloBoardSnapshot(opciones.boardId || config.trelloBoardId);

    logEtapa(
      'PASO_A_TRELLO',
      `Snapshot obtenido con éxito: Tablero "${snapshotTrello.board?.name}" | ` +
      `Total tarjetas: ${snapshotTrello.metrics?.totalCards} | ` +
      `Vencidas: ${snapshotTrello.metrics?.overdueCards} | ` +
      `En progreso: ${snapshotTrello.metrics?.pendingCards}`
    );

    // =========================================================================
    // PASO A2: GITHUB + MÉTRICAS DETERMINISTAS (sin IA)
    // =========================================================================
    let actividadGithub = null;
    if (config.repository) {
      logEtapa('PASO_A2_GITHUB', `Consultando actividad de ${config.repository.owner}/${config.repository.name}...`);
      actividadGithub = await obtenerActividadRepositorio(config.repository, {
        desde: new Date(Date.now() - DIAS_VENTANA_GITHUB * 24 * 60 * 60 * 1000),
      });
      logEtapa(
        'PASO_A2_GITHUB',
        actividadGithub.disponible
          ? `Commits en los últimos ${DIAS_VENTANA_GITHUB} días: ${actividadGithub.commits.length} | CI: ${actividadGithub.ci?.resultado || 'sin datos'}`
          : `GitHub no disponible: ${actividadGithub.error}`
      );
    }

    const metricas = calcularMetricas({ snapshot: snapshotTrello, config, github: actividadGithub });
    logEtapa(
      'PASO_A2_METRICAS',
      `Avance global: ${metricas.avanceGlobal}% | Fase actual: ${metricas.faseActual} | ` +
      `${metricas.entrega ? `Días para la entrega: ${metricas.entrega.diasRestantes} | ` : ''}` +
      `Alertas: ${metricas.alertas.map((a) => `${a.severidad}:${a.codigo}`).join(', ') || 'ninguna'}`
    );

    // =========================================================================
    // PASO B: AGENTE EJECUTOR (Detección y Propuesta Inicial)
    // =========================================================================
    console.log('🤖 [Ejecutor] Analizando tareas...');
    logEtapa('PASO_B_EJECUTOR', 'Ejecutando Agente Ejecutor sobre las métricas del proyecto...');
    const salidaEjecutor = await analizarPlanificacion(snapshotTrello, config, metricas);
    
    logEtapa('PASO_B_EJECUTOR', 'Propuesta analítica generada exitosamente por el Agente Ejecutor.');

    // =========================================================================
    // PASO C: AGENTE REVISOR (Filtro de Calidad y Anti-Alucinaciones)
    // =========================================================================
    console.log('🕵️‍♂️ [Revisor] Validando...');
    logEtapa('PASO_C_REVISOR', 'Ejecutando Agente Revisor para contrastar contra Ground Truth...');
    const salidaRevisor = await revisarPropuesta(salidaEjecutor, snapshotTrello, config, metricas);

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
    console.log('✅ [Aprobador] Generando dictamen...');
    logEtapa('PASO_D_APROBADOR', 'Ejecutando Agente Aprobador para evaluación de impacto y gobernanza...');
    const dictamenBruto = await evaluarAprobacion(salidaRevisor, snapshotTrello, config, metricas);

    logEtapa(
      'PASO_D_APROBADOR',
      `Dictamen de gobernanza emitido con éxito. Riesgo Global: ${dictamenBruto.overallRisk} | ` +
      `Solicitudes de cambio propuestas: ${dictamenBruto.actionItems?.length || 0} | ` +
      `Regla HITL activa: SÍ`
    );

    // =========================================================================
    // PASO E: VALIDACIÓN DETERMINISTA CONTRA TRELLO (sin IA)
    // =========================================================================
    const { dictamen: dictamenAprobador, descartadas } = validarAccionesContraTrello(dictamenBruto, snapshotTrello, { config });
    descartadas.forEach((d) =>
      logEtapa('PASO_E_VALIDACION', `Acción descartada [${d.itemCode}] "${d.cardName}": ${d.motivos.join(' ')}`)
    );
    logEtapa(
      'PASO_E_VALIDACION',
      `Acciones válidas: ${dictamenAprobador.actionItems.length} | Descartadas: ${descartadas.length}`
    );

    // =========================================================================
    // PASO OPCIONAL: NOTIFICACIÓN DINÁMICA AL PM (MAILER)
    // =========================================================================
    let notificacionResultado = null;
    const sinAcciones = dictamenAprobador.actionItems.length === 0;
    const hayAlertasGraves = metricas.alertas.some((a) => a.severidad === 'CRITICA' || a.severidad === 'ALTA');
    if (opciones.notificarPM && opciones.notificarSoloConAcciones && sinAcciones && !hayAlertasGraves) {
      logEtapa('NOTIFICACION', 'Sin acciones que aprobar ni alertas graves; se omite el correo.');
    } else if (opciones.notificarPM) {
      console.log('📧 [Mailer] Despachando notificación de aprobación interactiva al Gestor...');
      logEtapa('NOTIFICACION', `Enviando solicitud de aprobación interactiva al Gestor (${config.projectManagerEmail})...`);
      try {
        notificacionResultado = await enviarSolicitudAprobacion(dictamenAprobador, config, metricas);
        logEtapa('NOTIFICACION', `Correo de aprobación interactivo enviado exitosamente (Acciones: ${notificacionResultado.registeredActionsCount}).`);
      } catch (mailError) {
        logEtapa('NOTIFICACION_WARN', `No se pudo enviar el correo: ${mailError.message}`);
      }
    }

    const finTimestamp = new Date().toISOString();
    logEtapa('FIN_FLUJO', `Flujo completado exitosamente a las ${finTimestamp}.`);

    return {
      success: true,
      metadata: {
        projectName,
        inicioTimestamp,
        finTimestamp,
        boardId: snapshotTrello.board?.id,
      },
      trelloSnapshot: snapshotTrello,
      metricas,
      ejecutorOutput: salidaEjecutor,
      revisorOutput: salidaRevisor,
      aprobadorVerdict: dictamenAprobador,
      accionesDescartadas: descartadas,
      notificacion: notificacionResultado,
    };

  } catch (error) {
    logEtapa('ERROR_FATAL', `Fallo durante el flujo: ${error.message}`);
    throw error;
  }
}

/**
 * Orquestador Principal para la Auditoría Manual Inmediata del Sistema Multiagente.
 * Encapsula todo el flujo secuencial de extremo a extremo:
 * Extraer datos de Trello -> Ejecutor -> Revisor -> Aprobador -> Mailer (Gestor del Proyecto)
 * 
 * @param {Object} [opciones={}]
 * @returns {Promise<Object>} Paquete integral con las salidas de cada etapa y el dictamen final.
 */
export async function ejecutarAuditoriaManual(opciones = {}) {
  console.log('\n🚀 [Auditoría Manual] Iniciando pipeline multiagente...');
  return await ejecutarFlujoSeguimiento({
    notificarPM: true,
    ...opciones,
  });
}

export default {
  ejecutarFlujoSeguimiento,
  ejecutarAuditoriaManual,
};
