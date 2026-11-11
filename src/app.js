import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { loadProjectConfig } from './config/index.js';
import {
  ESTADOS,
  obtenerAccion,
  tokenValido,
  accionExpirada,
  actualizarEstadoAccion,
  listarAcciones,
} from './storage/accionesStore.js';
import { ejecutarModificacionTrello } from './integrations/trello.js';
import { inicializarTareasProgramadas } from './workflows/cron.js';
import { ejecutarAuditoriaManual } from './workflows/index.js';
import { escapeHtml } from './utils/html.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_FILE_PATH = process.env.HISTORIAL_LOG_PATH || path.resolve(__dirname, '../historial.log');

const app = express();
const PORT = process.env.PORT || 3000;
const ES_PRODUCCION = process.env.NODE_ENV === 'production';

/**
 * En producción el servidor se niega a arrancar con una configuración insegura.
 * @returns {string[]} problemas encontrados
 */
export const validarEntornoProduccion = (env = process.env) => {
  const problemas = [];
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) {
    problemas.push('ADMIN_TOKEN debe estar definido y tener al menos 32 caracteres.');
  }
  if (!/^https:\/\//.test(env.APP_BASE_URL || '')) {
    problemas.push('APP_BASE_URL debe ser una URL https:// pública.');
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    problemas.push('SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son obligatorias (el disco del servidor no es persistente).');
  }
  return problemas;
};

// Middlewares
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Cabeceras de seguridad básicas
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', // evita filtrar el token de la URL a otros sitios
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...(ES_PRODUCCION ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  });
  next();
});

// Request logging middleware (sin query string para no registrar tokens en consola)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/**
 * Protege endpoints administrativos con ADMIN_TOKEN (solo header "x-admin-token",
 * nunca en la URL, para que no quede en logs ni historial del navegador).
 * Si ADMIN_TOKEN no está configurado (solo posible fuera de producción), se permite el acceso.
 */
const requireAdmin = (req, res, next) => {
  const esperado = process.env.ADMIN_TOKEN;
  if (!esperado) return next();

  const a = crypto.createHash('sha256').update(esperado).digest();
  const b = crypto.createHash('sha256').update(String(req.get('x-admin-token') || '')).digest();
  if (crypto.timingSafeEqual(a, b)) return next();

  return res.status(401).json({ error: 'No autorizado. Envía el header x-admin-token.' });
};

// Raíz: confirma que el servicio está activo, sin exponer información interna
app.get('/', (req, res) => {
  res.status(200).json({
    servicio: 'Smart Project Agent',
    estado: 'activo',
    descripcion: 'Servidor de aprobaciones. Los enlaces de los correos de auditoría apuntan a /webhook/decision.',
  });
});

app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

// Health check endpoint (no consulta la base de datos para ser barato)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Consulta de acciones registradas (sin tokens). Filtro opcional: ?status=PENDING
 */
app.get('/api/pending-actions', requireAdmin, async (req, res) => {
  try {
    const actions = await listarAcciones({ status: req.query.status });
    res.status(200).json({ total: actions.length, actions });
  } catch (error) {
    console.error('[API /api/pending-actions] Error:', error.message);
    res.status(500).json({ error: 'No se pudo consultar el almacén de acciones.' });
  }
});

/**
 * Endpoint de prueba para invocar manualmente la auditoría completa del agente
 * GET /api/test-agent
 */
app.get('/api/test-agent', requireAdmin, (req, res) => {
  console.log('[API /api/test-agent] Solicitud recibida: Disparando auditoría manual del agente...');

  // Ejecuta la auditoría en segundo plano para respuesta inmediata al cliente
  ejecutarAuditoriaManual().catch((error) => {
    console.error('[API /api/test-agent] 💥 Error durante la auditoría manual:', error.message || error);
  });

  return res.status(200).json({
    mensaje: 'Auditoría del Agente iniciada. Revisa la consola del servidor y tu correo electrónico.',
  });
});

/**
 * Helper para registrar eventos en el archivo local historial.log
 */
const registrarEnHistorial = (linea) => {
  try {
    const logEntry = `[${new Date().toISOString()}] ${linea}\n`;
    fs.appendFileSync(LOG_FILE_PATH, logEntry, 'utf8');
  } catch (error) {
    console.error('[Historial] Error al escribir en historial.log:', error.message);
  }
};

const formatearFecha = (iso) => {
  if (!iso) return null;
  const fecha = new Date(iso);
  return Number.isNaN(fecha.getTime()) ? null : fecha.toLocaleString('es');
};

/**
 * Helper para renderizar páginas HTML responsivas para el Gestor.
 * Todo el contenido dinámico se escapa; `formHtml` es HTML de confianza generado en este archivo.
 */
const renderHtmlResponse = ({ title, statusType, headline, message, details, actionCode, formHtml = '' }) => {
  const isApproved = statusType === 'approved';
  const isRejected = statusType === 'rejected';

  const themeColor = isApproved ? '#10b981' : (isRejected ? '#ef4444' : '#f59e0b');
  const icon = isApproved ? '✓' : (isRejected ? '✗' : 'ℹ');

  const detalle = (etiqueta, valor) =>
    valor ? `<div class="details-item"><strong>${etiqueta}:</strong> <span>${escapeHtml(valor)}</span></div>` : '';

  return `
  <!DOCTYPE html>
  <html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex">
    <title>${escapeHtml(title)}</title>
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        background: #0f172a;
        color: #f8fafc;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        margin: 0;
        padding: 20px;
      }
      .card {
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 16px;
        max-width: 520px;
        width: 100%;
        padding: 36px 28px;
        text-align: center;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
      }
      .icon-circle {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        background-color: ${themeColor}22;
        border: 2px solid ${themeColor};
        color: ${themeColor};
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 36px;
        font-weight: bold;
        margin: 0 auto 20px auto;
      }
      h1 { font-size: 22px; margin: 0 0 10px 0; color: #ffffff; }
      p.subtitle { color: #94a3b8; font-size: 14px; margin: 0 0 24px 0; line-height: 1.5; }
      .details-box {
        background: #0f172a;
        border: 1px solid #334155;
        border-radius: 10px;
        padding: 18px;
        text-align: left;
        margin-bottom: 24px;
        font-size: 13px;
        line-height: 1.6;
      }
      .details-item { margin-bottom: 8px; }
      .details-item strong { color: #cbd5e1; }
      .details-item span { color: #94a3b8; }
      .badge {
        display: inline-block;
        padding: 3px 8px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: bold;
        background: ${themeColor}33;
        color: ${themeColor};
      }
      .btn {
        border: 0;
        border-radius: 8px;
        padding: 12px 28px;
        font-size: 15px;
        font-weight: bold;
        color: #ffffff;
        cursor: pointer;
        background: ${themeColor};
        margin-bottom: 20px;
      }
      .footer-note { font-size: 12px; color: #64748b; margin: 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon-circle">${icon}</div>
      <h1>${escapeHtml(headline)}</h1>
      <p class="subtitle">${escapeHtml(message)}</p>

      ${details ? `
      <div class="details-box">
        <div class="details-item">
          <strong>Referencia:</strong> <span class="badge">${escapeHtml(actionCode || 'N/A')}</span>
        </div>
        ${detalle('Tarjeta', details.cardName)}
        ${detalle('Problema', details.problem)}
        ${detalle('Acción', details.action)}
        ${detalle('Nueva Fecha Límite', details.dueDate)}
        ${detalle('Comentario a publicar', details.comment)}
        ${detalle('Resultado en Trello', details.trelloResult)}
      </div>
      ` : ''}

      ${formHtml}

      <p class="footer-note">Smart Project Agent • Gobernanza Human-in-the-Loop</p>
    </div>
  </body>
  </html>
  `;
};

const ESTADO_TEXTO = {
  [ESTADOS.APPROVED]: 'APROBADA Y APLICADA',
  [ESTADOS.REJECTED]: 'RECHAZADA',
  [ESTADOS.FAILED]: 'APROBADA, PERO FALLÓ EN TRELLO',
};

/**
 * Valida actionId + token + decision. Retorna { action, decision } o envía la respuesta de error.
 */
const resolverSolicitudDecision = async (params, res) => {
  const { actionId, token, decision } = params || {};
  const decisionNormalized = String(decision || '').toLowerCase();

  if (!actionId || !token || !['approve', 'reject'].includes(decisionNormalized)) {
    res.status(400).send(renderHtmlResponse({
      title: 'Petición Inválida',
      statusType: 'warning',
      headline: 'Enlace incompleto o inválido',
      message: 'La solicitud no contiene un ID de acción, un token o una decisión válidos. Usa el enlace del correo original.',
    }));
    return null;
  }

  const action = await obtenerAccion(String(actionId));
  if (!action || !tokenValido(action, String(token))) {
    console.warn('[Webhook Decision] ⚠️ Acción no encontrada o token inválido.');
    res.status(404).send(renderHtmlResponse({
      title: 'Acción No Encontrada',
      statusType: 'warning',
      headline: 'Solicitud no encontrada',
      message: 'No existe una acción pendiente con ese enlace, o el enlace no es válido.',
    }));
    return null;
  }

  if (action.status === ESTADOS.PENDING && accionExpirada(action)) {
    res.status(410).send(renderHtmlResponse({
      title: 'Enlace Caducado',
      statusType: 'warning',
      headline: 'Esta propuesta ya caducó',
      message: 'El enlace superó su tiempo de vigencia. La próxima auditoría generará propuestas actualizadas.',
      actionCode: action.itemCode,
      details: { cardName: action.cardName, action: action.recommendedAction },
    }));
    return null;
  }

  return { action, decision: decisionNormalized };
};

/** Envuelve un handler async para responder con una página de error en vez de colgar la petición. */
const manejarErrores = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error(`[${req.method} ${req.path}] Error:`, error.message);
    if (!res.headersSent) {
      res.status(500).send(renderHtmlResponse({
        title: 'Error Interno',
        statusType: 'warning',
        headline: 'No se pudo procesar la solicitud',
        message: 'Ocurrió un error temporal. Intenta nuevamente en unos minutos desde el mismo enlace.',
      }));
    }
  }
};

const detallesDeAccion = (action, extra = {}) => ({
  cardName: action.cardName,
  problem: action.detectedProblem,
  action: action.recommendedAction,
  dueDate: formatearFecha(action.trelloExecutionParams?.due),
  comment: action.trelloExecutionParams?.comment,
  ...extra,
});

const responderAccionYaResuelta = (action, res) => {
  const estado = ESTADO_TEXTO[action.status] || action.status;
  return res.status(200).send(renderHtmlResponse({
    title: 'Acción Ya Procesada',
    statusType: action.status === ESTADOS.APPROVED ? 'approved' : 'rejected',
    headline: `Acción ya ${estado.toLowerCase()}`,
    message: `Esta solicitud fue resuelta el ${formatearFecha(action.resolvedAt)}.`,
    actionCode: action.itemCode,
    details: detallesDeAccion(action, { trelloResult: action.executionResult?.error }),
  }));
};

/**
 * Paso 1 (GET): el enlace del correo muestra una página de confirmación.
 * No modifica nada, así los escáneres de enlaces de los clientes de correo no pueden aprobar acciones.
 * URL: GET /webhook/decision?actionId=...&token=...&decision=(approve|reject)
 */
app.get('/webhook/decision', manejarErrores(async (req, res) => {
  const resuelta = await resolverSolicitudDecision(req.query, res);
  if (!resuelta) return;
  const { action, decision } = resuelta;

  const puedeDecidir = action.status === ESTADOS.PENDING
    || (action.status === ESTADOS.FAILED && decision === 'approve');
  if (!puedeDecidir) return responderAccionYaResuelta(action, res);

  const esAprobacion = decision === 'approve';
  const formHtml = `
    <form method="POST" action="/webhook/decision">
      <input type="hidden" name="actionId" value="${escapeHtml(action.actionId)}">
      <input type="hidden" name="token" value="${escapeHtml(req.query.token)}">
      <input type="hidden" name="decision" value="${escapeHtml(decision)}">
      <button type="submit" class="btn">${esAprobacion ? 'Confirmar y aplicar en Trello' : 'Confirmar rechazo'}</button>
    </form>`;

  return res.status(200).send(renderHtmlResponse({
    title: esAprobacion ? 'Confirmar Aprobación' : 'Confirmar Rechazo',
    statusType: esAprobacion ? 'approved' : 'rejected',
    headline: esAprobacion ? '¿Aplicar este cambio en Trello?' : '¿Rechazar esta propuesta?',
    message: esAprobacion
      ? (action.status === ESTADOS.FAILED
        ? 'Un intento anterior falló en Trello. Puedes reintentar la modificación.'
        : 'Revisa el detalle. El cambio se aplicará en Trello al confirmar.')
      : 'La tarjeta quedará sin cambios en Trello.',
    actionCode: action.itemCode,
    details: detallesDeAccion(action, { trelloResult: action.executionResult?.error }),
    formHtml,
  }));
}));

/**
 * Paso 2 (POST): registra la decisión del Gestor y, si aprueba, aplica el cambio en Trello.
 */
app.post('/webhook/decision', manejarErrores(async (req, res) => {
  const resuelta = await resolverSolicitudDecision(req.body, res);
  if (!resuelta) return;
  const { action, decision } = resuelta;

  const puedeDecidir = action.status === ESTADOS.PENDING
    || (action.status === ESTADOS.FAILED && decision === 'approve');
  if (!puedeDecidir) return responderAccionYaResuelta(action, res);

  const params = action.trelloExecutionParams;
  const resumen =
    `ActionId: ${action.actionId} | Codigo: ${action.itemCode} | Proyecto: "${action.projectName}" | ` +
    `Tarjeta: "${action.cardName}" (${action.cardId})`;

  if (decision === 'reject') {
    await actualizarEstadoAccion(action.actionId, ESTADOS.REJECTED);
    registrarEnHistorial(`[DECISION: RECHAZADA] ${resumen} | Desestimada por el PM.`);
    console.log(`[HUMAN-IN-THE-LOOP] ❌ Acción ${action.itemCode} rechazada por el Gestor. Trello sin cambios.`);

    return res.status(200).send(renderHtmlResponse({
      title: 'Acción Desestimada',
      statusType: 'rejected',
      headline: 'Acción Rechazada',
      message: 'Has descartado esta propuesta. No se realizará ninguna modificación en Trello.',
      actionCode: action.itemCode,
      details: { cardName: action.cardName, action: 'Desestimada por el Gestor del Proyecto.' },
    }));
  }

  // Aprobación: aplicar el cambio en Trello
  console.log(`[HUMAN-IN-THE-LOOP] ✅ Acción ${action.itemCode} aprobada. Aplicando en Trello...`, params);
  const resultado = await ejecutarModificacionTrello(params);
  const executionResult = {
    success: resultado.success,
    dryRun: Boolean(resultado.dryRun),
    error: resultado.error || null,
    executedAt: new Date().toISOString(),
  };

  if (!resultado.success) {
    await actualizarEstadoAccion(action.actionId, ESTADOS.FAILED, executionResult);
    registrarEnHistorial(`[DECISION: APROBADA - ERROR TRELLO] ${resumen} | Params: ${JSON.stringify(params)} | Error: ${resultado.error}`);

    return res.status(502).send(renderHtmlResponse({
      title: 'Error al Aplicar en Trello',
      statusType: 'warning',
      headline: 'Aprobada, pero Trello rechazó el cambio',
      message: 'La decisión quedó registrada. Puedes reintentar desde el mismo enlace del correo.',
      actionCode: action.itemCode,
      details: detallesDeAccion(action, { trelloResult: resultado.error }),
    }));
  }

  await actualizarEstadoAccion(action.actionId, ESTADOS.APPROVED, executionResult);
  registrarEnHistorial(
    `[DECISION: APROBADA${executionResult.dryRun ? ' - DRY RUN' : ''}] ${resumen} | ` +
    `Accion: "${action.recommendedAction}" | Params: ${JSON.stringify(params)}`
  );

  return res.status(200).send(renderHtmlResponse({
    title: 'Modificación Aplicada',
    statusType: 'approved',
    headline: executionResult.dryRun ? 'Aprobada (simulación)' : '¡Cambio aplicado en Trello!',
    message: executionResult.dryRun
      ? 'TRELLO_DRY_RUN está activo: la decisión se registró, pero no se modificó Trello.'
      : 'El Gestor autorizó la modificación y la tarjeta fue actualizada en Trello.',
    actionCode: action.itemCode,
    details: detallesDeAccion(action, { trelloResult: executionResult.dryRun ? 'Simulado' : 'Actualizada' }),
  }));
}));

/**
 * Generic Webhook Endpoint for Repository Updates
 */
app.post('/webhook/repo-update', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[Webhook] Repository update received:');

    let projectConfig = null;
    try {
      projectConfig = loadProjectConfig();
    } catch (configErr) {
      console.warn('[Webhook] Could not load active project configuration:', configErr.message);
    }

    const repository = payload?.repository?.name || payload?.repository || projectConfig?.projectName || 'Unknown Repository';
    const ref = payload?.ref || payload?.branch || 'Unknown Branch/Ref';
    const commitsCount = Array.isArray(payload?.commits) ? payload.commits.length : 0;
    const sender = payload?.sender?.login || payload?.pusher?.name || payload?.author || 'Unknown Sender';

    console.log(`[Webhook] Project: ${repository} | Ref: ${ref} | Commits: ${commitsCount} | Sender: ${sender}`);

    return res.status(200).json({
      status: 'success',
      message: 'Repository update received and queued for audit processing',
      timestamp: new Date().toISOString(),
      details: {
        repository,
        ref,
        commitsCount,
        sender,
        configuredProject: projectConfig?.projectName || null,
      },
    });
  } catch (error) {
    console.error('[Webhook] Error processing repository update:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while processing repository update',
      error: error.message,
    });
  }
});

// Start server only when executed directly
if (process.env.NODE_ENV !== 'test') {
  if (ES_PRODUCCION) {
    const problemas = validarEntornoProduccion();
    if (problemas.length > 0) {
      console.error('[Server] ❌ Configuración insegura para producción. El servidor no se iniciará:');
      problemas.forEach((p) => console.error(`  - ${p}`));
      process.exit(1);
    }
  }

  app.listen(PORT, () => {
    console.log(`[Server] Smart Project Agent running on port ${PORT}`);
    console.log(`[Server] Test agent endpoint: GET http://localhost:${PORT}/api/test-agent`);
    console.log(`[Server] Webhook repo endpoint: POST http://localhost:${PORT}/webhook/repo-update`);
    console.log(`[Server] Decision HITL endpoint: GET/POST http://localhost:${PORT}/webhook/decision`);
    if (!process.env.ADMIN_TOKEN) {
      console.warn('[Server] ⚠️ ADMIN_TOKEN no configurado: /api/test-agent y /api/pending-actions son públicos.');
    }
    if (process.env.TRELLO_DRY_RUN === 'true') {
      console.warn('[Server] 🧪 TRELLO_DRY_RUN=true: las aprobaciones NO modificarán Trello.');
    }

    // Tareas programadas: auditoría diaria (L-V) y reporte semanal (viernes)
    inicializarTareasProgramadas();
  });
}

export default app;
