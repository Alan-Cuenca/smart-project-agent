import { test } from 'node:test';
import assert from 'node:assert/strict';

// Simulación mínima de la API REST de Supabase (PostgREST) en memoria.
process.env.SUPABASE_URL = 'https://proyecto.supabase.co/';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

const filas = new Map();
const peticiones = [];

globalThis.fetch = async (url, { method, headers, body }) => {
  const u = new URL(url);
  peticiones.push({ method, url: u, headers });
  assert.equal(u.pathname, '/rest/v1/acciones_pendientes');
  assert.equal(headers.apikey, 'service-role-test');
  assert.equal(headers.Authorization, 'Bearer service-role-test');

  const id = u.searchParams.get('action_id')?.replace('eq.', '');
  const responder = (datos, status = 200) => ({ ok: true, status, json: async () => datos, text: async () => '' });

  if (method === 'POST') {
    const fila = JSON.parse(body);
    filas.set(fila.action_id, fila);
    return responder([fila], 201);
  }
  if (method === 'GET') {
    if (id) return responder(filas.has(id) ? [filas.get(id)] : []);
    const status = u.searchParams.get('status')?.replace('eq.', '');
    return responder([...filas.values()].filter((f) => !status || f.status === status));
  }
  if (method === 'PATCH') {
    const fila = { ...filas.get(id), ...JSON.parse(body) };
    filas.set(id, fila);
    return responder([fila]);
  }
  throw new Error(`método no simulado: ${method}`);
};

const store = await import('../src/storage/accionesStore.js');

test('supabase: se selecciona el backend cuando hay credenciales', () => {
  assert.equal(store.obtenerBackend().nombre, 'supabase');
});

test('supabase: registra, valida token, actualiza y lista sin secretos', async () => {
  const a = await store.registrarAccionPendiente({ itemCode: 'SOL-01', cardId: 'c1', trelloExecutionParams: { idCard: 'c1', comment: 'hola' } });

  const fila = filas.get(a.actionId);
  assert.equal(fila.status, 'PENDING');
  assert.ok(fila.token_hash && fila.token_hash !== a.token);
  assert.ok(!JSON.stringify(fila).includes(a.token), 'el token en claro no debe enviarse a Supabase');
  assert.ok(fila.expires_at);

  const leida = await store.obtenerAccion(a.actionId);
  assert.ok(store.tokenValido(leida, a.token));
  assert.equal(leida.trelloExecutionParams.comment, 'hola');

  const actualizada = await store.actualizarEstadoAccion(a.actionId, 'APPROVED', { success: true });
  assert.equal(actualizada.status, 'APPROVED');
  assert.equal(filas.get(a.actionId).status, 'APPROVED');
  assert.ok(filas.get(a.actionId).resolved_at);

  const pendientes = await store.listarAcciones({ status: 'PENDING' });
  assert.equal(pendientes.length, 0);
  const todas = await store.listarAcciones();
  assert.ok(todas.every((x) => !('tokenHash' in x) && !('token' in x)));
});

test('supabase: un actionId malformado no llega a la base de datos', async () => {
  const antes = peticiones.length;
  assert.equal(await store.obtenerAccion('1 or 1=1'), null);
  assert.equal(peticiones.length, antes);
});
