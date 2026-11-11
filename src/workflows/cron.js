import cron from 'node-cron';
import { ejecutarFlujoSeguimiento } from './index.js';
import { sendProjectAlert } from '../notifications/mailer.js';
import { loadProjectConfig } from '../config/index.js';
import { fetchTrelloBoardSnapshot } from '../integrations/trello.js';
import { obtenerActividadRepositorio } from '../integrations/github.js';
import { calcularMetricas } from '../analysis/metricas.js';
import { escapeHtml } from '../utils/html.js';

const PROGRAMACION_DIARIA = '0 8 * * 1-5'; // lunes a viernes, 08:00
const PROGRAMACION_SEMANAL = '0 17 * * 5'; // viernes, 17:00
const ZONA_HORARIA_POR_DEFECTO = 'America/Guayaquil';

const COLOR_SEVERIDAD = { CRITICA: '#dc2626', ALTA: '#ea580c', MEDIA: '#d97706', INFO: '#2563eb' };

/**
 * Auditoría diaria con los agentes de IA.
 * Solo envía correo si hay acciones para aprobar o alertas graves (ALTA/CRITICA).
 */
export async function ejecutarAuditoriaDiaria() {
  console.log(`[Cron Diario] [${new Date().toISOString()}] 🚀 Iniciando auditoría diaria...`);
  try {
    const config = loadProjectConfig();
    const resultado = await ejecutarFlujoSeguimiento({
      configProyecto: config,
      notificarPM: true,
      notificarSoloConAcciones: true,
    });
    if (resultado.notificacionError) {
      console.error(`[Cron Diario] ⚠️ La auditoría terminó pero el correo falló: ${resultado.notificacionError}`);
      return null;
    }
    console.log(`[Cron Diario] ✅ Auditoría completada. Acciones propuestas: ${resultado.aprobadorVerdict.actionItems.length}`);
    return resultado;
  } catch (error) {
    console.error('[Cron Diario] ⚠️ Error durante la auditoría diaria:', error.message);
    return null;
  }
}

/**
 * Reporte semanal de avance. Es 100% determinista (no consume cuota de Gemini):
 * métricas de Trello + GitHub con el avance por fase, el equipo y las alertas.
 */
export async function ejecutarReporteSemanal() {
  const timestamp = new Date().toISOString();
  console.log(`[Cron Semanal] [${timestamp}] 🚀 Generando reporte semanal de avance...`);

  try {
    const config = loadProjectConfig();
    const projectName = config?.projectName || 'Proyecto Genérico';

    const snapshot = await fetchTrelloBoardSnapshot(config.trelloBoardId);
    const github = config.repository
      ? await obtenerActividadRepositorio(config.repository, { desde: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) })
      : null;
    const m = calcularMetricas({ snapshot, config, github });

    const filasFases = m.fases.map((f) => `
      <tr>
        <td style="padding: 6px 0; font-size: 13px; color: #334155;">${escapeHtml(f.nombre)}</td>
        <td style="padding: 6px 0; width: 45%;">
          <div style="background-color: #e2e8f0; height: 8px; border-radius: 9999px; overflow: hidden;">
            <div style="background-color: ${f.avance === 100 ? '#10b981' : '#3b82f6'}; width: ${f.avance}%; height: 100%;"></div>
          </div>
        </td>
        <td style="padding: 6px 0 6px 8px; font-size: 12px; color: #64748b; text-align: right; white-space: nowrap;">${f.completadas}/${f.total}</td>
      </tr>`).join('');

    const filasEquipo = m.equipo.filter((e) => e.assignable).map((e) => `
      <tr>
        <td style="padding: 4px 0; font-size: 13px; color: #334155;">${escapeHtml(e.name)}<br><span style="font-size: 11px; color: #94a3b8;">${escapeHtml(e.role)}</span></td>
        <td style="padding: 4px 0; font-size: 12px; color: #64748b; text-align: right;">${e.tareasPendientesAsignadas} tarea(s) · ${e.commits} commit(s)</td>
      </tr>`).join('');

    const alertasHtml = m.alertas.length
      ? m.alertas.map((a) => `
        <li style="margin-bottom: 6px;">
          <span style="background-color: ${COLOR_SEVERIDAD[a.severidad]}; color: #fff; font-size: 10px; font-weight: bold; padding: 2px 6px; border-radius: 4px;">${a.severidad}</span>
          ${escapeHtml(a.mensaje)}
        </li>`).join('')
      : '<li>Sin alertas esta semana.</li>';

    const subject = `📊 Reporte semanal: ${m.avanceGlobal}% completado` +
      (m.entrega ? ` · ${m.entrega.diasRestantes} días para la entrega` : '');

    const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>Reporte Semanal</title></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden;">
        <div style="background-color: #0f172a; padding: 24px; text-align: center; color: #ffffff;">
          <h1 style="margin: 0; font-size: 20px;">Resumen Semanal de Proyecto</h1>
          <p style="margin: 6px 0 0 0; color: #94a3b8; font-size: 14px;">${escapeHtml(projectName)} • ${escapeHtml(m.faseActual)}</p>
        </div>
        <div style="padding: 24px;">
          <table role="presentation" width="100%" style="border-collapse: collapse; background: #f1f5f9; border-radius: 8px; margin-bottom: 24px;"><tr>
            <td style="text-align: center; padding: 14px;"><div style="font-size: 22px; font-weight: bold; color: #16a34a;">${m.avanceGlobal}%</div><div style="font-size: 11px; color: #64748b; text-transform: uppercase;">Avance</div></td>
            <td style="text-align: center; padding: 14px;"><div style="font-size: 22px; font-weight: bold; color: #2563eb;">${m.tareasPendientes.length}</div><div style="font-size: 11px; color: #64748b; text-transform: uppercase;">Pendientes</div></td>
            <td style="text-align: center; padding: 14px;"><div style="font-size: 22px; font-weight: bold; color: #dc2626;">${m.entrega ? m.entrega.diasRestantes : '—'}</div><div style="font-size: 11px; color: #64748b; text-transform: uppercase;">Días a la entrega</div></td>
          </tr></table>

          <h3 style="font-size: 15px; margin: 0 0 8px 0; color: #0f172a;">Avance por fase</h3>
          <table role="presentation" width="100%" style="border-collapse: collapse; margin-bottom: 24px;">${filasFases}</table>

          <h3 style="font-size: 15px; margin: 0 0 8px 0; color: #0f172a;">Alertas</h3>
          <ul style="font-size: 13px; color: #334155; padding-left: 18px; line-height: 1.5; margin: 0 0 24px 0;">${alertasHtml}</ul>

          <h3 style="font-size: 15px; margin: 0 0 8px 0; color: #0f172a;">Equipo (última semana)</h3>
          <table role="presentation" width="100%" style="border-collapse: collapse; margin-bottom: 8px;">${filasEquipo}</table>
          ${m.repositorio.disponible && m.repositorio.ci ? `<p style="font-size: 12px; color: #64748b;">Último CI: <strong>${escapeHtml(m.repositorio.ci.resultado || m.repositorio.ci.estado)}</strong> (${escapeHtml(String(m.repositorio.ci.fecha).slice(0, 10))})</p>` : ''}
        </div>
        <div style="background-color: #f8fafc; padding: 14px; text-align: center; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8;">
          Smart Project Agent • Reporte automático • ${new Date().toLocaleDateString('es')}
        </div>
      </div>
    </body>
    </html>`;

    await sendProjectAlert({
      projectConfig: config,
      subject,
      html: htmlBody,
      text: `Resumen semanal de ${projectName}: ${m.avanceGlobal}% completado, ${m.tareasPendientes.length} tareas pendientes` +
        (m.entrega ? `, ${m.entrega.diasRestantes} días para la entrega.` : '.') +
        `\nAlertas:\n${m.alertas.map((a) => `- [${a.severidad}] ${a.mensaje}`).join('\n') || '- Ninguna'}`,
    });

    console.log(`[Cron Semanal] ✅ Reporte semanal enviado a: ${config.projectManagerEmail}`);
    return { success: true, timestamp, avanceGlobal: m.avanceGlobal, alertas: m.alertas.length };
  } catch (error) {
    console.error('[Cron Semanal] ⚠️ Error durante la ejecución del reporte semanal:', error.message);
    return null;
  }
}

/**
 * Programa la auditoría diaria y el reporte semanal en la zona horaria del proyecto.
 * Las expresiones pueden sobrescribirse con CRON_AUDITORIA_DIARIA / CRON_REPORTE_SEMANAL
 * (usa "off" para desactivar una tarea).
 */
export function inicializarTareasProgramadas() {
  let timezone = ZONA_HORARIA_POR_DEFECTO;
  try {
    timezone = loadProjectConfig().timezone || ZONA_HORARIA_POR_DEFECTO;
  } catch (error) {
    console.warn(`[Cron] No se pudo leer la configuración (${error.message}). Se usa ${timezone}.`);
  }

  const tareas = [
    { nombre: 'Auditoría diaria', expresion: process.env.CRON_AUDITORIA_DIARIA || PROGRAMACION_DIARIA, fn: ejecutarAuditoriaDiaria },
    { nombre: 'Reporte semanal', expresion: process.env.CRON_REPORTE_SEMANAL || PROGRAMACION_SEMANAL, fn: ejecutarReporteSemanal },
  ];

  return tareas
    .filter((t) => t.expresion !== 'off')
    .map((t) => {
      if (!cron.validate(t.expresion)) {
        console.error(`[Cron] Expresión inválida para "${t.nombre}": ${t.expresion}`);
        return null;
      }
      const task = cron.schedule(t.expresion, async () => {
        console.log(`[Cron] ⏰ Ejecutando "${t.nombre}"...`);
        await t.fn();
      }, { timezone });
      console.log(`[Cron] ✅ ${t.nombre} programada ("${t.expresion}", ${timezone}).`);
      return task;
    })
    .filter(Boolean);
}

export default {
  inicializarTareasProgramadas,
  ejecutarAuditoriaDiaria,
  ejecutarReporteSemanal,
};
