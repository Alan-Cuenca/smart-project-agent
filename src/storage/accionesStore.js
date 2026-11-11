import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const TABLA = 'acciones_pendientes';

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

/** Hash SHA-256 del token: el token en claro solo viaja en el correo, nunca se almacena. */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const diasDeVigencia = () => {
  const n = Number.parseInt(process.env.ACTION_TTL_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
};

// ---------------------------------------------------------------------------
// Backend 1: archivo JSON local (desarrollo y tests)
// ---------------------------------------------------------------------------
const rutaArchivo = () => process.env.ACTIONS_STORE_PATH || path.join(DATA_DIR, 'acciones.json');

const backendArchivo = {
  nombre: 'archivo',
  leer() {
    const ruta = rutaArchivo();
    if (!fs.existsSync(ruta)) return {};
    const contenido = fs.readFileSync(ruta, 'utf8');
    return contenido.trim() ? JSON.parse(contenido) : {};
  },
  escribir(datos) {
    const ruta = rutaArchivo();
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    const tmp = `${ruta}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(datos, null, 2), 'utf8');
    fs.renameSync(tmp, ruta); // escritura atómica
  },
  async insertar(registro) {
    const datos = this.leer();
    datos[registro.actionId] = registro;
    this.escribir(datos);
  },
  async obtener(actionId) {
    return this.leer()[actionId] || null;
  },
  async actualizar(actionId, cambios) {
    const datos = this.leer();
    if (!datos[actionId]) return null;
    datos[actionId] = { ...datos[actionId], ...cambios };
    this.escribir(datos);
    return datos[actionId];
  },
  async listar(status) {
    return Object.values(this.leer()).filter((a) => !status || a.status === status);
  },
};

// ---------------------------------------------------------------------------
// Backend 2: Supabase (producción). Usa la API REST de PostgREST con la service role key.
// La tabla tiene RLS activado y sin políticas: solo la service role puede leer o escribir.
// ---------------------------------------------------------------------------
const backendSupabase = {
  nombre: 'supabase',
  async peticion(metodo, query = '', cuerpo) {
    const url = `${process.env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${TABLA}${query}`;
    const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await fetch(url, {
      method: metodo,
      headers: {
        apikey: clave,
        Authorization: `Bearer ${clave}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const detalle = await res.text().catch(() => '');
      throw new Error(`[AccionesStore] Supabase ${metodo} ${res.status}: ${detalle.slice(0, 300)}`);
    }
    return res.status === 204 ? [] : res.json();
  },
  aFila: (r) => ({
    action_id: r.actionId,
    token_hash: r.tokenHash,
    status: r.status,
    datos: r,
    created_at: r.createdAt,
    resolved_at: r.resolvedAt,
    expires_at: r.expiresAt,
  }),
  deFila: (fila) => (fila ? { ...fila.datos, status: fila.status, resolvedAt: fila.resolved_at, tokenHash: fila.token_hash } : null),
  async insertar(registro) {
    await this.peticion('POST', '', this.aFila(registro));
  },
  async obtener(actionId) {
    const filas = await this.peticion('GET', `?action_id=eq.${encodeURIComponent(actionId)}&select=*`);
    return this.deFila(filas[0]);
  },
  async actualizar(actionId, cambios) {
    const actual = await this.obtener(actionId);
    if (!actual) return null;
    const nuevo = { ...actual, ...cambios };
    const filas = await this.peticion('PATCH', `?action_id=eq.${encodeURIComponent(actionId)}`, {
      status: nuevo.status,
      resolved_at: nuevo.resolvedAt,
      datos: nuevo,
    });
    return this.deFila(filas[0]);
  },
  async listar(status) {
    const filtro = status ? `&status=eq.${encodeURIComponent(status)}` : '';
    const filas = await this.peticion('GET', `?select=*&order=created_at.desc&limit=200${filtro}`);
    return filas.map((f) => this.deFila(f));
  },
};

/** Supabase si están sus credenciales; si no, archivo local. */
export const obtenerBackend = () =>
  (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? backendSupabase : backendArchivo);

const sinSecretos = ({ token, tokenHash, ...resto }) => resto;

// ---------------------------------------------------------------------------
// API pública (asíncrona)
// ---------------------------------------------------------------------------

/**
 * Registra una nueva acción pendiente con un ID único y un token secreto.
 * Solo se almacena el hash del token; el token en claro se retorna una única vez para el correo.
 *
 * @param {Object} actionData - Item generado por el Agente Aprobador.
 * @returns {Promise<Object>} Registro (incluye actionId y token en claro).
 */
export const registrarAccionPendiente = async (actionData) => {
  const actionId = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  const ahora = new Date();

  const registro = {
    actionId,
    tokenHash: hashToken(token),
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
    createdAt: ahora.toISOString(),
    expiresAt: new Date(ahora.getTime() + diasDeVigencia() * 24 * 60 * 60 * 1000).toISOString(),
    resolvedAt: null,
    executionResult: null,
  };

  await obtenerBackend().insertar(registro);
  return { ...sinSecretos(registro), token };
};

/**
 * @param {string} actionId
 * @returns {Promise<Object|null>} Registro interno (incluye tokenHash, para validar).
 */
export const obtenerAccion = async (actionId) => {
  if (!actionId || !/^[0-9a-f-]{36}$/i.test(actionId)) return null;
  return obtenerBackend().obtener(actionId);
};

/**
 * Compara el hash del token recibido con el almacenado, en tiempo constante.
 * @param {Object} action
 * @param {string} token
 * @returns {boolean}
 */
export const tokenValido = (action, token) => {
  if (!action?.tokenHash || typeof token !== 'string' || token.length === 0) return false;
  const esperado = Buffer.from(action.tokenHash, 'hex');
  const recibido = Buffer.from(hashToken(token), 'hex');
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
};

/** @returns {boolean} true si el enlace de la acción ya caducó. */
export const accionExpirada = (action, ahora = new Date()) =>
  Boolean(action?.expiresAt && new Date(action.expiresAt) < ahora);

/**
 * Actualiza el estado (y opcionalmente el resultado de ejecución) de una acción.
 * @returns {Promise<Object>} Registro actualizado (sin secretos).
 */
export const actualizarEstadoAccion = async (actionId, status, executionResult = null) => {
  const cambios = { status, resolvedAt: new Date().toISOString() };
  if (executionResult) cambios.executionResult = executionResult;
  const actualizado = await obtenerBackend().actualizar(actionId, cambios);
  if (!actualizado) throw new Error(`Acción con ID "${actionId}" no encontrada en el almacén.`);
  return sinSecretos(actualizado);
};

/**
 * Lista las acciones sin exponer tokens ni hashes.
 * @param {{ status?: string }} [filtro]
 * @returns {Promise<Array<Object>>}
 */
export const listarAcciones = async ({ status } = {}) =>
  (await obtenerBackend().listar(status)).map(sinSecretos);

export default {
  ESTADOS,
  obtenerBackend,
  registrarAccionPendiente,
  obtenerAccion,
  tokenValido,
  accionExpirada,
  actualizarEstadoAccion,
  listarAcciones,
};
