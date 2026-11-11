import dotenv from 'dotenv';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

dotenv.config({ quiet: true });

const MODELO_POR_DEFECTO = 'gemini-3.8-flash';
// El plan gratuito limita ~20 solicitudes diarias POR MODELO, así que una lista
// variada de respaldos multiplica la capacidad diaria y esquiva modelos saturados (503).
const RESPALDOS_POR_DEFECTO = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.7-flash',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
].join(',');

const leerEntero = (valor, porDefecto) => {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
};

/**
 * Lista ordenada de modelos a intentar: GEMINI_MODEL primero y luego GEMINI_FALLBACK_MODELS.
 * @returns {string[]}
 */
export const obtenerModelosConfigurados = () => {
  const principal = (process.env.GEMINI_MODEL || '').trim() || MODELO_POR_DEFECTO;
  const respaldos = (process.env.GEMINI_FALLBACK_MODELS ?? RESPALDOS_POR_DEFECTO)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([principal, ...respaldos])];
};

/**
 * Crea un cliente de Gemini con reintentos acotados.
 * @param {string} model
 * @param {number} temperature
 * @returns {ChatGoogleGenerativeAI}
 */
export const crearModeloGemini = (model, temperature) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no encontrada en las variables de entorno (.env).');
  }
  return new ChatGoogleGenerativeAI({
    apiKey,
    model,
    temperature,
    maxRetries: leerEntero(process.env.GEMINI_MAX_RETRIES, 1),
  });
};

const esErrorDeAutenticacion = (error) =>
  error?.status === 401 || error?.status === 403 || /API_KEY_INVALID|PERMISSION_DENIED|401|403/.test(error?.message || '');

const describirError = (error) => {
  const msg = error?.message || String(error);
  if (error?.name === 'AbortError' || /abort|timeout/i.test(msg)) return 'sin respuesta dentro del tiempo límite';
  if (/503|UNAVAILABLE|high demand|overloaded/i.test(msg)) return 'modelo saturado (503)';
  if (/429|RESOURCE_EXHAUSTED/i.test(msg)) return 'cuota o límite de tasa excedido (429)';
  if (/404|NOT_FOUND/i.test(msg)) return 'modelo no disponible (404)';
  return msg.slice(0, 200);
};

/**
 * Invoca Gemini con tiempo límite por intento y modelos de respaldo.
 * Si un modelo está saturado o no responde, prueba con el siguiente de la lista.
 *
 * @param {Object} opciones
 * @param {string} opciones.agente - Nombre del agente (para los logs).
 * @param {Array} opciones.mensajes - Mensajes LangChain (SystemMessage, HumanMessage...).
 * @param {number} [opciones.temperature=0.1]
 * @param {import('zod').ZodTypeAny} [opciones.schema] - Si se indica, usa salida estructurada.
 * @param {string} [opciones.schemaName]
 * @returns {Promise<{ resultado: any, modelo: string }>}
 */
export async function invocarGemini({ agente, mensajes, temperature = 0.1, schema, schemaName }) {
  const modelos = obtenerModelosConfigurados();
  const timeout = leerEntero(process.env.GEMINI_TIMEOUT_MS, 120000);
  const fallos = [];

  for (const nombreModelo of modelos) {
    const inicio = Date.now();
    try {
      const modelo = crearModeloGemini(nombreModelo, temperature);
      const runnable = schema ? modelo.withStructuredOutput(schema, { name: schemaName }) : modelo;

      console.log(`[${agente}] Consultando Gemini (${nombreModelo}, límite ${Math.round(timeout / 1000)}s)...`);
      const resultado = await runnable.invoke(mensajes, { timeout });

      console.log(`[${agente}] Respuesta de ${nombreModelo} en ${((Date.now() - inicio) / 1000).toFixed(1)}s.`);
      return { resultado, modelo: nombreModelo };
    } catch (error) {
      if (esErrorDeAutenticacion(error)) {
        throw new Error(`GEMINI_API_KEY inválida o sin permisos: ${error.message}`);
      }
      const motivo = describirError(error);
      fallos.push(`${nombreModelo}: ${motivo}`);
      console.warn(`[${agente}] ⚠️ ${nombreModelo} falló tras ${((Date.now() - inicio) / 1000).toFixed(1)}s (${motivo}).`);
    }
  }

  throw new Error(
    `Ningún modelo de Gemini respondió. Intentos: ${fallos.join(' | ')}. ` +
    'Suele ser saturación temporal de Google; reintenta en unos minutos o ajusta GEMINI_MODEL / GEMINI_FALLBACK_MODELS.'
  );
}

export default { invocarGemini, crearModeloGemini, obtenerModelosConfigurados };
