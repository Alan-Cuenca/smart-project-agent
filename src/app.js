import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { loadProjectConfig } from './config/index.js';
import { 
  obtenerAccionPendiente, 
  actualizarEstadoAccion, 
  pendingActionsStore 
} from './notifications/mailer.js';
import { ejecutarModificacionTrello } from './integrations/trello.js';
import { inicializarCronSemanal } from './workflows/cron.js';
import { ejecutarAuditoriaManual } from './workflows/index.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_FILE_PATH = path.resolve(__dirname, '../historial.log');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    pendingActionsCount: pendingActionsStore.size,
  });
});

/**
 * Consulta de acciones en memoria (inspección de desarrollo)
 */
app.get('/api/pending-actions', (req, res) => {
  const actions = Array.from(pendingActionsStore.values());
  res.status(200).json({
    total: actions.length,
    actions,
  });
});

/**
 * Endpoint de prueba para invocar manualmente la auditoría completa del agente
 * GET /api/test-agent
 */
app.get('/api/test-agent', async (req, res) => {
  try {
    console.log('[API /api/test-agent] Solicitud recibida: Disparando auditoría manual del agente...');

    // Ejecuta la auditoría en segundo plano para respuesta inmediata al cliente
    ejecutarAuditoriaManual().catch((error) => {
      console.error('[API /api/test-agent] 💥 Error durante la auditoría manual:', error.message || error);
    });

    return res.status(200).json({
      mensaje: "Auditoría del Agente iniciada. Revisa la consola del servidor y tu correo electrónico."
    });
  } catch (error) {
    console.error('[API /api/test-agent] ⚠️ Error al invocar la auditoría:', error.message || error);
    return res.status(500).json({
      error: "Error al iniciar la auditoría del agente.",
      detalle: error.message
    });
  }
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

/**
 * Helper para renderizar páginas HTML responsivas de confirmación para el Gestor
 */
const renderHtmlResponse = ({ title, statusType, headline, message, details, actionCode }) => {
  const isApproved = statusType === 'approved';
  const isRejected = statusType === 'rejected';
  
  const themeColor = isApproved ? '#10b981' : (isRejected ? '#ef4444' : '#f59e0b');
  const icon = isApproved ? '✓' : (isRejected ? '✗' : 'ℹ');

  return `
  <!DOCTYPE html>
  <html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
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
      .footer-note { font-size: 12px; color: #64748b; margin: 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon-circle">${icon}</div>
      <h1>${headline}</h1>
      <p class="subtitle">${message}</p>
      
      ${details ? `
      <div class="details-box">
        <div class="details-item">
          <strong>Referencia:</strong> <span class="badge">${actionCode || 'N/A'}</span>
        </div>
        ${details.cardName ? `<div class="details-item"><strong>Tarjeta:</strong> <span>${details.cardName}</span></div>` : ''}
        ${details.action ? `<div class="details-item"><strong>Acción:</strong> <span>${details.action}</span></div>` : ''}
        ${details.dueDate ? `<div class="details-item"><strong>Nueva Fecha Límite:</strong> <span>${details.dueDate}</span></div>` : ''}
        <div class="details-item"><strong>Registrado en Historial:</strong> <span>historial.log</span></div>
      </div>
      ` : ''}

      <p class="footer-note">Smart Project Agent • Gobernanza Human-in-the-Loop</p>
    </div>
  </body>
  </html>
  `;
};

/**
 * Endpoint Interactivo Human-in-the-Loop:
 * Recibe la decisión del Gestor del Proyecto desde los botones del correo electrónico.
 * URL esperada: GET /webhook/decision?actionId=...&decision=(approve|reject)
 */
app.get('/webhook/decision', async (req, res) => {
  const { actionId, decision } = req.query;

  // 1. Validación de parámetros de consulta
  if (!actionId || !decision) {
    return res.status(400).send(renderHtmlResponse({
      title: 'Petición Inválida',
      statusType: 'warning',
      headline: 'Parámetros Incompletos',
      message: 'La solicitud no contiene el ID de acción o la decisión requerida.',
    }));
  }

  const decisionNormalized = String(decision).toLowerCase();
  if (!['approve', 'reject'].includes(decisionNormalized)) {
    return res.status(400).send(renderHtmlResponse({
      title: 'Decisión Inválida',
      statusType: 'warning',
      headline: 'Decisión no reconocida',
      message: 'El valor de decisión recibido debe ser "approve" o "reject".',
    }));
  }

  // 2. Búsqueda de la acción en el almacén de acciones pendientes
  const action = obtenerAccionPendiente(actionId);

  // Manejo de acción no encontrada o expirada
  if (!action) {
    console.warn(`[Webhook Decision] ⚠️ Acción "${actionId}" no encontrada en memoria.`);
    return res.status(404).send(renderHtmlResponse({
      title: 'Acción No Encontrada',
      statusType: 'warning',
      headline: 'Solicitud no encontrada o expirada',
      message: `No se encontró en memoria ninguna acción pendiente con ID "${actionId}". Puede que el servidor se haya reiniciado o la solicitud ya no esté vigente.`,
    }));
  }

  // 3. Verificación de si la acción ya fue resuelta previamente (idempotencia)
  if (action.status !== 'PENDING') {
    const estadoPrevio = action.status === 'APPROVED' ? 'APROBADA' : 'RECHAZADA';
    console.log(`[Webhook Decision] ℹ️ La acción "${actionId}" ya fue resuelta previamente como: ${estadoPrevio}`);
    
    return res.status(200).send(renderHtmlResponse({
      title: 'Acción Ya Procesada',
      statusType: action.status === 'APPROVED' ? 'approved' : 'rejected',
      headline: `Acción Ya ${estadoPrevio}`,
      message: `Esta solicitud fue resuelta previamente el ${new Date(action.resolvedAt).toLocaleString()}.`,
      actionCode: action.itemCode,
      details: {
        cardName: action.cardName,
        action: action.recommendedAction,
      },
    }));
  }

  // 4. Procesamiento de la Decisión
  const timestampISO = new Date().toISOString();

  if (decisionNormalized === 'approve') {
    // Actualizar estado en almacén
    actualizarEstadoAccion(actionId, 'APPROVED');

    const params = action.trelloExecutionParams;

    // Registro en historial.log
    registrarEnHistorial(
      `[DECISION: APROBADA] ActionId: ${action.actionId} | Codigo: ${action.itemCode} | ` +
      `Proyecto: "${action.projectName}" | Tarjeta: "${action.cardName}" (${action.cardId}) | ` +
      `Accion: "${action.recommendedAction}" | Params: ${JSON.stringify(params)}`
    );

    // Registro estructurado en consola (Auditoría)
    console.log('================================================================================');
    console.log(`[HUMAN-IN-THE-LOOP] ✅ DECISIÓN REGISTRADA: ACCIÓN APROBADA POR EL GESTOR`);
    console.log(`Timestamp: ${timestampISO}`);
    console.log(`Action ID: ${action.actionId} | Código: ${action.itemCode}`);
    console.log(`Proyecto: "${action.projectName}"`);
    console.log(`Tarjeta Trello: "${action.cardName}" (Card ID: ${action.cardId})`);
    console.log(`Problema Detectado: ${action.detectedProblem}`);
    console.log(`Acción Aprobada: ${action.recommendedAction}`);
    console.log(`Parámetros Trello a Ejecutar:`, JSON.stringify(params, null, 2));
    console.log(`--------------------------------------------------------------------------------`);

    // Llamada a la API de Trello (Paso 2 y Paso 3):
    // Descomentar para aplicar los cambios directamente en Trello:
    // await ejecutarModificacionTrello(params);
    console.log(`[Trello Execution] Simulación activa: llamada a ejecutarModificacionTrello(params) preparada.`);
    console.log(`[Historial] Registro guardado en: ${LOG_FILE_PATH}`);
    console.log('================================================================================');

    return res.status(200).send(renderHtmlResponse({
      title: 'Modificación Aprobada',
      statusType: 'approved',
      headline: '¡Acción Aprobada con Éxito!',
      message: 'El Gestor del Proyecto ha autorizado la modificación. El cambio quedó registrado en historial.log y preparado para Trello.',
      actionCode: action.itemCode,
      details: {
        cardName: action.cardName,
        action: action.recommendedAction,
        dueDate: params?.due ? new Date(params.due).toLocaleString() : 'Sin cambio de fecha',
      },
    }));

  } else {
    // Decisión: Rechazar
    actualizarEstadoAccion(actionId, 'REJECTED');

    // Registro en historial.log
    registrarEnHistorial(
      `[DECISION: RECHAZADA] ActionId: ${action.actionId} | Codigo: ${action.itemCode} | ` +
      `Proyecto: "${action.projectName}" | Tarjeta: "${action.cardName}" (${action.cardId}) | ` +
      `Desestimada por el PM.`
    );

    console.log('================================================================================');
    console.log(`[HUMAN-IN-THE-LOOP] ❌ DECISIÓN REGISTRADA: ACCIÓN RECHAZADA POR EL GESTOR`);
    console.log(`Timestamp: ${timestampISO}`);
    console.log(`Action ID: ${action.actionId} | Código: ${action.itemCode}`);
    console.log(`Proyecto: "${action.projectName}"`);
    console.log(`Tarjeta Trello: "${action.cardName}" (Card ID: ${action.cardId})`);
    console.log(`Acción Desestimada: ${action.recommendedAction}`);
    console.log(`Resultado: La tarjeta permanecerá sin cambios en Trello por orden del Gestor.`);
    console.log(`[Historial] Registro guardado en: ${LOG_FILE_PATH}`);
    console.log('================================================================================');

    return res.status(200).send(renderHtmlResponse({
      title: 'Acción Desestimada',
      statusType: 'rejected',
      headline: 'Acción Rechazada',
      message: 'Has descartado esta propuesta. No se realizará ninguna modificación en Trello ni en la planificación.',
      actionCode: action.itemCode,
      details: {
        cardName: action.cardName,
        action: 'Desestimada por el Gestor del Proyecto.',
      },
    }));
  }
});

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
  app.listen(PORT, () => {
    console.log(`[Server] Smart Project Agent running on port ${PORT}`);
    console.log(`[Server] Test agent endpoint: GET http://localhost:${PORT}/api/test-agent`);
    console.log(`[Server] Webhook repo endpoint: POST http://localhost:${PORT}/webhook/repo-update`);
    console.log(`[Server] Decision HITL endpoint: GET http://localhost:${PORT}/webhook/decision`);
    
    // Paso 5: Inicialización del Cronjob Semanal
    inicializarCronSemanal('0 17 * * 5');
  });
}

export default app;
