import cron from 'node-cron';
import { ejecutarFlujoSeguimiento } from './index.js';
import { sendProjectAlert } from '../notifications/mailer.js';
import { loadProjectConfig } from '../config/index.js';
import { fetchTrelloBoardSnapshot } from '../integrations/trello.js';

/**
 * Genera y envía el reporte semanal de avance al Gestor del Proyecto.
 * Se ejecuta automáticamente mediante el cronjob o manualmente para auditorías bajo demanda.
 */
export async function ejecutarReporteSemanal() {
  const timestamp = new Date().toISOString();
  console.log(`[Cron Semanal] [${timestamp}] 🚀 Iniciando auditoría semanal de avance general...`);

  try {
    const config = loadProjectConfig();
    const projectName = config?.projectName || 'Proyecto Genérico';

    // 1. Obtener snapshot actualizado del tablero
    const snapshot = await fetchTrelloBoardSnapshot();
    const metrics = snapshot.metrics || {};

    // 2. Ejecutar el flujo multiagente secuencial
    console.log(`[Cron Semanal] Ejecutando pipeline de agentes (Ejecutor -> Revisor -> Aprobador)...`);
    const flujoResultado = await ejecutarFlujoSeguimiento({ notificarPM: false });
    const dictamen = flujoResultado.aprobadorVerdict;

    // 3. Elaborar reporte de avance semanal (Completadas vs Pendientes)
    const total = metrics.totalCards || 0;
    const completadas = metrics.completedCards || 0;
    const pendientes = metrics.pendingCards || 0;
    const vencidas = metrics.overdueCards || 0;
    const porcentajeAvance = total > 0 ? Math.round((completadas / total) * 100) : 0;

    const cardsByListHtml = Object.entries(metrics.cardsByList || {})
      .map(([lista, cantidad]) => `<li><strong>${lista}:</strong> ${cantidad} tarjeta(s)</li>`)
      .join('');

    const subject = `📊 [Reporte Semanal] Avance de ${projectName} (${porcentajeAvance}% completado)`;

    const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Reporte Semanal</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden;">
        
        <div style="background-color: #0f172a; padding: 24px; text-align: center; color: #ffffff;">
          <h1 style="margin: 0; font-size: 20px;">Resumen Semanal de Proyecto</h1>
          <p style="margin: 6px 0 0 0; color: #94a3b8; font-size: 14px;">${projectName} • Viernes 5:00 PM</p>
        </div>

        <div style="padding: 24px;">
          
          <!-- Métricas Clave -->
          <div style="display: flex; justify-content: space-between; margin-bottom: 24px; background: #f1f5f9; padding: 16px; border-radius: 8px;">
            <div style="text-align: center; flex: 1;">
              <span style="font-size: 22px; font-weight: bold; color: #16a34a;">${completadas}</span><br>
              <span style="font-size: 11px; color: #64748b; text-transform: uppercase;">Completadas</span>
            </div>
            <div style="text-align: center; flex: 1; border-left: 1px solid #cbd5e1; border-right: 1px solid #cbd5e1;">
              <span style="font-size: 22px; font-weight: bold; color: #2563eb;">${pendientes}</span><br>
              <span style="font-size: 11px; color: #64748b; text-transform: uppercase;">En Progreso</span>
            </div>
            <div style="text-align: center; flex: 1;">
              <span style="font-size: 22px; font-weight: bold; color: #dc2626;">${vencidas}</span><br>
              <span style="font-size: 11px; color: #64748b; text-transform: uppercase;">Retrasadas</span>
            </div>
          </div>

          <!-- Barra de Progreso -->
          <div style="margin-bottom: 24px;">
            <div style="display: flex; justify-content: space-between; font-size: 12px; font-weight: bold; margin-bottom: 6px;">
              <span>Progreso Global</span>
              <span>${porcentajeAvance}%</span>
            </div>
            <div style="background-color: #e2e8f0; height: 10px; border-radius: 9999px; overflow: hidden;">
              <div style="background-color: #10b981; width: ${porcentajeAvance}%; height: 100%;"></div>
            </div>
          </div>

          <!-- Diagnóstico de los Agentes -->
          <h3 style="font-size: 15px; margin-bottom: 8px; color: #0f172a;">Diagnóstico del Agente Aprobador:</h3>
          <p style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px; font-size: 13px; color: #334155; margin: 0 0 20px 0;">
            ${dictamen.summaryForPM || dictamen.executiveSummary || 'Sin observaciones críticas.'}
          </p>

          <!-- Desglose por Listas -->
          <h3 style="font-size: 15px; margin-bottom: 8px; color: #0f172a;">Distribución de Actividades:</h3>
          <ul style="font-size: 13px; color: #475569; padding-left: 20px; line-height: 1.6; margin: 0 0 24px 0;">
            ${cardsByListHtml}
          </ul>

        </div>

        <div style="background-color: #f8fafc; padding: 14px; text-align: center; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8;">
          Smart Project Agent • Automatización Semanal • ${new Date().toLocaleDateString()}
        </div>

      </div>
    </body>
    </html>
    `;

    // 4. Enviar correo estructurado al Project Manager
    await sendProjectAlert({
      projectConfig: config,
      subject,
      html: htmlBody,
      text: `Resumen Semanal de ${projectName}: ${completadas} completadas, ${pendientes} en progreso, ${vencidas} retrasadas. Progreso: ${porcentajeAvance}%.`,
    });

    console.log(`[Cron Semanal] ✅ Reporte semanal despachado exitosamente a: ${config.projectManagerEmail}`);

    return {
      success: true,
      timestamp,
      porcentajeAvance,
      completadas,
      pendientes,
      vencidas,
    };

  } catch (error) {
    console.error(`[Cron Semanal] ⚠️ Error durante la ejecución del reporte semanal:`, error.message);
  }
}

/**
 * Inicializa y programa el cronjob de automatización del reporte semanal.
 * Expresión cron: '0 17 * * 5' -> Todos los viernes a las 5:00 PM (17:00).
 * 
 * @param {string} [cronScheduleExpression='0 17 * * 5']
 * @returns {cron.ScheduledTask}
 */
export function inicializarCronSemanal(cronScheduleExpression = '0 17 * * 5') {
  console.log(`[Cron] Configurando tarea programada para el reporte semanal (Expresión: "${cronScheduleExpression}")...`);

  const task = cron.schedule(cronScheduleExpression, async () => {
    console.log(`[Cron] ⏰ Ejecutando cronjob programado de los viernes 5:00 PM.`);
    await ejecutarReporteSemanal();
  });

  console.log(`[Cron] ✅ Tarea programada activa: Se ejecutará todos los viernes a las 17:00.`);
  return task;
}

export default {
  inicializarCronSemanal,
  ejecutarReporteSemanal,
};
