import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const STORE_PATH = process.env.ACTIONS_STORE_PATH || path.join(DATA_DIR, 'acciones.json');

/**
 * Estados posibles de una acción:
 * - PENDING:   esperando decisión del Gestor.
 * - APPROVED:  aprobada y aplicada en Trello.
 * - FAILED:    aprobada, pero Trello rechazó el cambio (puede reintentarse).
 * - REJECTED:  desestimada por el Gestor.
 */
export const ESTADOS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  FAILED: 'FAILED',
  REJECTED: 'REJECTED',
});

/**
 * Lee todas las acciones del archivo JSON. Si no existe, retorna un objeto vacío.
 * @returns {Record<string, Object>}
 */
const leerStore = () => {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    const contenido = fs.readFileSync(STORE_PATH, 'utf8');
    return contenido.trim() ? JSON.parse(contenido) : {};
  } catch (error) {
    console.error(`[AccionesStore] Error leyendo ${STORE_PATH}:`, error.message);
    throw new Error(`[AccionesStore] No se pudo leer el almacén de acciones: ${error.message}`);
  }
};

/**
 * Escribe el almacén de forma atómica (archivo temporal + rename) para evitar corrupción.
 * @param {Record<string, Object>} datos
 */
const escribirStore = (datos) => {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmpPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(datos, null, 2), 'utf8');
  fs.renameSync(tmpPath, STORE_PATH);
};

/**
 * Registra una nueva acción pendiente con un ID único e impredecible y un token secreto.
 * El token viaja en los enlaces del correo y es obligatorio para decidir sobre la acción.
 *
 * @param {Object} actionData - Item generado por el Agente Aprobador.
 * @returns {Object} Registro completo (incluye actionId y token).
 */
export const registrarAccionPendiente = (actionData) => {
  const datos = leerStore();
  const actionId = crypto.randomUUID();

  const record = {
    actionId,
    token: crypto.randomBytes(24).toString('hex'),
    itemCode: actionData.itemCode || actionId.slice(0, 8),
    projectName: actionData.projectName || 'Proyecto Genérico',
    cardId: actionData.cardId || actionData.trelloExecutionParams?.idCard,
    cardName: actionData.cardName || 'Tarea Sin Nombre',
    detectedProblem: actionData.detectedProblem || 'Sin detalle del problema',
    recommendedAction: actionData.recommendedAction || 'Sin detalle de acción',
    technicalJustification: actionData.technicalJustification || 'No especificada',
    impactLevel: actionData.impactLevel || 'MEDIO',
    trelloExecutionParams: actionData.trelloExecutionParams || { idCard: actionData.cardId },
    status: ESTADOS.PENDING,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    executionResult: null,
  };

  datos[actionId] = record;
  escribirStore(datos);
  return record;
};

/**
 * @param {string} actionId
 * @returns {Object|null}
 */
export const obtenerAccion = (actionId) => {
  if (!actionId) return null;
  return leerStore()[actionId] || null;
};

/**
 * Compara el token recibido con el almacenado en tiempo constante.
 * @param {Object} action
 * @param {string} token
 * @returns {boolean}
 */
export const tokenValido = (action, token) => {
  if (!action?.token || typeof token !== 'string') return false;
  const esperado = Buffer.from(action.token);
  const recibido = Buffer.from(token);
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
};

/**
 * Actualiza el estado (y opcionalmente el resultado de ejecución) de una acción.
 * @param {string} actionId
 * @param {string} status - Uno de ESTADOS.
 * @param {Object} [executionResult]
 * @returns {Object} Registro actualizado.
 */
export const actualizarEstadoAccion = (actionId, status, executionResult = null) => {
  const datos = leerStore();
  const action = datos[actionId];
  if (!action) {
    throw new Error(`Acción con ID "${actionId}" no encontrada en el almacén.`);
  }

  action.status = status;
  action.resolvedAt = new Date().toISOString();
  if (executionResult) action.executionResult = executionResult;

  datos[actionId] = action;
  escribirStore(datos);
  return action;
};

/**
 * Lista las acciones sin exponer sus tokens.
 * @param {{ status?: string }} [filtro]
 * @returns {Array<Object>}
 */
export const listarAcciones = ({ status } = {}) => {
  return Object.values(leerStore())
    .filter((a) => !status || a.status === status)
    .map(({ token, ...resto }) => resto);
};

export default {
  ESTADOS,
  registrarAccionPendiente,
  obtenerAccion,
  tokenValido,
  actualizarEstadoAccion,
  listarAcciones,
};
