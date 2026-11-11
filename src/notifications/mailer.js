import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { loadProjectConfig } from '../config/index.js';
import { registrarAccionPendiente } from '../storage/accionesStore.js';
import { escapeHtml } from '../utils/html.js';

dotenv.config();

/**
 * URL pública del servidor, usada en los botones del correo.
 * Debe ser accesible desde donde el Gestor abra el correo (no localhost en producción).
 * @returns {string}
 */
export const obtenerBaseUrl = () =>
  (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

/**
 * Crea y retorna el transportador de Nodemailer configurado con variables de entorno.
 * @returns {nodemailer.Transporter}
 */
export const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

/**
 * Construye la plantilla HTML interactiva con diseño profesional para el correo del Gestor.
 * @param {Object} params
 * @param {string} params.projectName
 * @param {string} params.overallRisk
 * @param {string} params.executiveSummary
 * @param {Array} params.actionItemsConIds
 * @param {string} params.baseUrl
 * @returns {string} HTML completo
 */
const generarHtmlAprobacion = ({ projectName, overallRisk, executiveSummary, actionItemsConIds, baseUrl }) => {
  const getBadgeColor = (risk) => {
    switch (risk?.toUpperCase()) {
      case 'CRITICO': return '#dc2626';
      case 'ALTO': return '#ea580c';
      case 'MEDIO': return '#d97706';
      default: return '#16a34a';
    }
  };

  const riskColor = getBadgeColor(overallRisk);
  projectName = escapeHtml(projectName);
  overallRisk = escapeHtml(overallRisk);
  executiveSummary = escapeHtml(executiveSummary);

  const actionCardsHtml = actionItemsConIds.map((rawItem) => {
    const enlace = (decision) =>
      `${baseUrl}/webhook/decision?actionId=${encodeURIComponent(rawItem.actionId)}` +
      `&token=${encodeURIComponent(rawItem.token)}&decision=${decision}`;
    const approveUrl = escapeHtml(enlace('approve'));
    const rejectUrl = escapeHtml(enlace('reject'));
    const impactColor = getBadgeColor(rawItem.impactLevel);
    const item = {
      ...rawItem,
      itemCode: escapeHtml(rawItem.itemCode),
      cardName: escapeHtml(rawItem.cardName),
      impactLevel: escapeHtml(rawItem.impactLevel),
      detectedProblem: escapeHtml(rawItem.detectedProblem),
      recommendedAction: escapeHtml(rawItem.recommendedAction),
      technicalJustification: escapeHtml(rawItem.technicalJustification),
    };

    return `
      <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 24px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.04);">
        <!-- Encabezado de la Tarjeta -->
        <div style="background-color: #f8fafc; padding: 14px 20px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
          <strong style="color: #0f172a; font-size: 16px;">📌 [${item.itemCode}] ${item.cardName}</strong>
          <span style="background-color: ${impactColor}; color: #ffffff; font-size: 11px; font-weight: bold; padding: 3px 10px; border-radius: 9999px; text-transform: uppercase;">
            Impacto: ${item.impactLevel}
          </span>
        </div>

        <div style="padding: 20px;">
          <!-- Problema -->
          <div style="margin-bottom: 14px;">
            <span style="font-size: 12px; font-weight: bold; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Problema Detectado</span>
            <p style="margin: 4px 0 0 0; color: #334155; font-size: 14px; line-height: 1.5;">${item.detectedProblem}</p>
          </div>

          <!-- Acción Recomendada -->
          <div style="margin-bottom: 14px; background-color: #f0fdf4; border-left: 4px solid #16a34a; padding: 12px 14px; border-radius: 4px;">
            <span style="font-size: 12px; font-weight: bold; color: #166534; text-transform: uppercase; letter-spacing: 0.5px;">Acción Correctiva Propuesta</span>
            <p style="margin: 4px 0 0 0; color: #14532d; font-size: 14px; line-height: 1.5; font-weight: 500;">${item.recommendedAction}</p>
          </div>

          <!-- Justificación Técnica -->
          <div style="margin-bottom: 20px;">
            <span style="font-size: 12px; font-weight: bold; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Justificación Técnica</span>
            <p style="margin: 4px 0 0 0; color: #475569; font-size: 13px; line-height: 1.5; font-style: italic;">"${item.technicalJustification}"</p>
          </div>

          <!-- Parámetros Trello a modificar -->
          ${item.trelloExecutionParams?.due ? `
          <div style="margin-bottom: 20px; font-size: 12px; color: #475569; background-color: #f1f5f9; padding: 8px 12px; border-radius: 6px;">
            🗓️ <strong>Nueva Fecha Límite propuesta:</strong> ${new Date(item.trelloExecutionParams.due).toLocaleString()}
          </div>` : ''}

          <!-- Botones de Acción (Human-in-the-Loop) -->
          <div style="border-top: 1px solid #f1f5f9; padding-top: 16px; text-align: center;">
            <a href="${approveUrl}" 
               style="background-color: #10b981; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block; margin-right: 12px; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.2);">
              ✓ Aprobar Modificación
            </a>
            <a href="${rejectUrl}" 
               style="background-color: #ef4444; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block; box-shadow: 0 2px 4px rgba(239, 68, 68, 0.2);">
              ✗ Rechazar
            </a>
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Solicitud de Aprobación - ${projectName}</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b;">
    <div style="max-width: 650px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
      
      <!-- Banner Superior -->
      <div style="background-color: #0f172a; padding: 28px; text-align: center;">
        <span style="color: #38bdf8; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1.5px;">Smart Project Agent • Human-in-the-Loop</span>
        <h1 style="color: #ffffff; margin: 8px 0 0 0; font-size: 22px; font-weight: 700;">Solicitud de Autorización de Cambios</h1>
        <p style="color: #94a3b8; margin: 6px 0 0 0; font-size: 14px;">Proyecto: <strong>${projectName}</strong></p>
      </div>

      <!-- Cuerpo del Mensaje -->
      <div style="padding: 28px;">
        
        <!-- Estado y Riesgo -->
        <div style="background-color: #f1f5f9; border-radius: 8px; padding: 16px; margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between;">
          <div>
            <span style="font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase;">Diagnóstico General:</span>
            <p style="margin: 2px 0 0 0; font-size: 14px; color: #1e293b; font-weight: 500;">${executiveSummary}</p>
          </div>
          <div style="text-align: right; margin-left: 12px;">
            <span style="background-color: ${riskColor}; color: #ffffff; font-size: 12px; font-weight: bold; padding: 4px 12px; border-radius: 9999px;">
              RIESGO: ${overallRisk}
            </span>
          </div>
        </div>

        <!-- Política de Gobernanza -->
        <div style="border: 1px dashed #cbd5e1; background-color: #fafafa; border-radius: 8px; padding: 12px 16px; margin-bottom: 28px; font-size: 12px; color: #475569; line-height: 1.5;">
          🔒 <strong>Regla de Gobernanza Activa:</strong> Ningún cambio ha sido aplicado aún en Trello. Por favor, evalúa cada propuesta individualmente y haz clic en el botón correspondiente para autorizar o desestimar la ejecución.
        </div>

        <h2 style="font-size: 16px; color: #0f172a; margin-bottom: 16px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px;">
          Propuestas Pendientes de Decisión (${actionItemsConIds.length}):
        </h2>

        ${actionCardsHtml}

      </div>

      <!-- Pie de Página -->
      <div style="background-color: #f8fafc; padding: 16px; text-align: center; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8;">
        Smart Project Agent • Automatización Segura con Verificación Humana<br>
        Generado automáticamente a las ${new Date().toLocaleString()}
      </div>

    </div>
  </body>
  </html>
  `;
};

/**
 * Envía la solicitud interactiva de aprobación al Gestor del Proyecto.
 * Registra previamente cada acción en el almacén en memoria para permitir su resolución interactiva.
 * 
 * @param {Object} datosDictamen - Salida estructurada proveniente del Agente Aprobador.
 * @param {Object} [configProyecto] - Configuración del proyecto.
 * @returns {Promise<Object>} Resultado del envío y lista de acciones registradas.
 */
export async function enviarSolicitudAprobacion(datosDictamen, configProyecto = null) {
  try {
    if (!datosDictamen) {
      throw new Error('[Mailer] Se requiere el objeto de datos del dictamen del Agente Aprobador.');
    }

    const config = configProyecto || (() => {
      try {
        return loadProjectConfig();
      } catch {
        return { projectName: 'Proyecto Genérico' };
      }
    })();

    const recipient = config.projectManagerEmail || datosDictamen.projectMetadata?.projectManagerEmail;
    if (!recipient) {
      throw new Error('[Mailer] projectManagerEmail no configurado en project.config.json ni en el dictamen.');
    }

    const projectName = config.projectName || datosDictamen.projectMetadata?.projectName || 'Proyecto Genérico';
    const baseUrl = obtenerBaseUrl();
    if (/localhost|127\.0\.0\.1/.test(baseUrl)) {
      console.warn(
        `[Mailer] ⚠️ APP_BASE_URL apunta a ${baseUrl}. Los botones del correo solo funcionarán ` +
        'en este mismo equipo. Configura APP_BASE_URL con la URL pública del servidor.'
      );
    }

    // 1. Registrar cada acción en el almacén persistente (ID único + token secreto)
    const actionItemsRaw = datosDictamen.actionItems || [];
    const actionItemsConIds = actionItemsRaw.map((item, idx) => {
      const itemCode = item.itemCode || `ACC-${idx + 1}`;
      const record = registrarAccionPendiente({ ...item, itemCode, projectName });
      return { ...item, itemCode, actionId: record.actionId, token: record.token };
    });

    if (actionItemsConIds.length === 0) {
      console.log('[Mailer] ℹ️ El dictamen no contiene acciones que requieran aprobación. Se envía solo el diagnóstico.');
    }

    // 2. Construir plantilla HTML interactiva
    const htmlEmail = generarHtmlAprobacion({
      projectName,
      overallRisk: datosDictamen.overallRisk || 'MEDIO',
      executiveSummary: datosDictamen.summaryForPM || datosDictamen.executiveSummary || 'Auditoría de planificación completada.',
      actionItemsConIds,
      baseUrl,
    });

    // 3. Configurar y enviar correo
    const transporter = createTransporter();
    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@smart-project-agent.local',
      to: recipient,
      subject: datosDictamen.emailSubject || `[Acción Requerida] Aprobación de Cambios para ${projectName}`,
      html: htmlEmail,
      text: datosDictamen.emailBodyMarkdown || `Se requiere su aprobación para ${actionItemsConIds.length} cambios en ${projectName}.`,
    };

    console.log(`[Mailer] Despachando solicitud de aprobación interactiva a: ${recipient}...`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Mailer] Correo enviado exitosamente (ID: ${info.messageId}). Acciones registradas: ${actionItemsConIds.length}`);

    return {
      success: true,
      messageId: info.messageId,
      recipient,
      registeredActionsCount: actionItemsConIds.length,
      actionIds: actionItemsConIds.map(a => a.actionId),
    };

  } catch (error) {
    console.error('[Mailer] Error al enviar solicitud de aprobación:', error.message);
    throw error;
  }
}

/**
 * Envío genérico de alertas (compatibilidad previa).
 */
export const sendProjectAlert = async ({ projectConfig, subject, text, html }) => {
  const recipient = projectConfig?.projectManagerEmail;
  if (!recipient) {
    throw new Error('Project manager email is missing in the provided project configuration.');
  }

  const projectName = projectConfig.projectName || 'Generic Project';
  const fullSubject = `[${projectName} Alert] ${subject}`;
  const transporter = createTransporter();

  const mailOptions = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@smart-project-agent.local',
    to: recipient,
    subject: fullSubject,
    text: text || 'No details provided.',
    html: html || `<p>${text || 'No details provided.'}</p>`,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Mailer] Alert sent successfully to ${recipient} (Message ID: ${info.messageId})`);
    return info;
  } catch (error) {
    console.error(`[Mailer] Failed to send alert email to ${recipient}:`, error.message);
    throw error;
  }
};

export default {
  createTransporter,
  sendProjectAlert,
  enviarSolicitudAprobacion,
  obtenerBaseUrl,
};
