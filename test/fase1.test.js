import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Entorno aislado: almacén temporal, sin servidor automático y sin tocar Trello real.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-test-'));
process.env.NODE_ENV = 'test';
process.env.ACTIONS_STORE_PATH = path.join(tmpDir, 'acciones.json');
process.env.HISTORIAL_LOG_PATH = path.join(tmpDir, 'historial.log');
process.env.TRELLO_DRY_RUN = 'true';
process.env.TRELLO_API_KEY = 'test-key';
process.env.TRELLO_TOKEN = 'test-token';
process.env.ADMIN_TOKEN = 'secreto-admin';

const { sanitizarParametrosTrello } = await import('../src/integrations/trello.js');
const { validarAccionesContraTrello } = await import('../src/workflows/validacion.js');
const store = await import('../src/storage/accionesStore.js');
const { escapeHtml } = await import('../src/utils/html.js');
const { default: app } = await import('../src/app.js');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// sanitizarParametrosTrello
// ---------------------------------------------------------------------------

test('sanitizar: valores vacíos no borran fecha ni responsables', () => {
  const { cardId, queryParams } = sanitizarParametrosTrello({ idCard: 'c1', due: '', idMembers: [], idList: '' });
  assert.equal(cardId, 'c1');
  assert.deepEqual(queryParams, {});
});

test('sanitizar: normaliza fecha y une miembros', () => {
  const { queryParams } = sanitizarParametrosTrello({
    idCard: 'c1',
    due: '2030-01-15T10:00:00Z',
    idMembers: ['m1', ' ', 'm2'],
  });
  assert.equal(queryParams.due, '2030-01-15T10:00:00.000Z');
  assert.equal(queryParams.idMembers, 'm1,m2');
});

test('sanitizar: descarta fechas inválidas', () => {
  const { queryParams } = sanitizarParametrosTrello({ idCard: 'c1', due: 'mañana' });
  assert.equal(queryParams.due, undefined);
});

// ---------------------------------------------------------------------------
// validarAccionesContraTrello
// ---------------------------------------------------------------------------

const snapshot = {
  cards: [{ id: 'card-1', name: 'Reservar salón' }],
  lists: [{ id: 'list-1', name: 'En curso' }],
  members: [{ id: 'mem-1', fullName: 'Ana' }],
};
const ahora = new Date('2030-01-01T00:00:00Z');

const accion = (params, extra = {}) => ({
  itemCode: 'SOL-01',
  cardId: params.idCard,
  cardName: 'nombre inventado',
  trelloExecutionParams: params,
  ...extra,
});

test('validación: acepta acción correcta y usa el nombre real de la tarjeta', () => {
  const { dictamen, descartadas } = validarAccionesContraTrello(
    { actionItems: [accion({ idCard: 'card-1', due: '2030-02-01T00:00:00Z', idMembers: ['mem-1'] })] },
    snapshot,
    ahora,
  );
  assert.equal(descartadas.length, 0);
  assert.equal(dictamen.actionItems[0].cardName, 'Reservar salón');
  assert.equal(dictamen.actionItems[0].trelloExecutionParams.idMembers, 'mem-1');
});

test('validación: descarta tarjeta inventada, fecha pasada, lista y miembro inexistentes', () => {
  const { dictamen, descartadas } = validarAccionesContraTrello(
    {
      actionItems: [
        accion({ idCard: 'card-falsa', due: '2030-02-01T00:00:00Z' }),
        accion({ idCard: 'card-1', due: '2029-12-01T00:00:00Z' }),
        accion({ idCard: 'card-1', idList: 'lista-falsa' }),
        accion({ idCard: 'card-1', idMembers: ['mem-falso'] }),
        accion({ idCard: 'card-1' }),
      ],
    },
    snapshot,
    ahora,
  );
  assert.equal(dictamen.actionItems.length, 0);
  assert.equal(descartadas.length, 5);
});

// ---------------------------------------------------------------------------
// Almacén persistente
// ---------------------------------------------------------------------------

test('almacén: IDs únicos aunque la IA repita el itemCode, y persisten en disco', () => {
  const a = store.registrarAccionPendiente({ itemCode: 'SOL-01', cardId: 'card-1' });
  const b = store.registrarAccionPendiente({ itemCode: 'SOL-01', cardId: 'card-1' });
  assert.notEqual(a.actionId, b.actionId);

  const enDisco = JSON.parse(fs.readFileSync(process.env.ACTIONS_STORE_PATH, 'utf8'));
  assert.ok(enDisco[a.actionId] && enDisco[b.actionId]);
  assert.ok(store.tokenValido(a, a.token));
  assert.ok(!store.tokenValido(a, b.token));
  assert.ok(store.listarAcciones().every((x) => !('token' in x)));
});

test('escapeHtml neutraliza etiquetas', () => {
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});

// ---------------------------------------------------------------------------
// Flujo HTTP de decisión
// ---------------------------------------------------------------------------

const nuevaAccion = () => store.registrarAccionPendiente({
  itemCode: 'SOL-99',
  cardId: 'card-1',
  cardName: '<b>Catering</b>',
  trelloExecutionParams: { idCard: 'card-1', due: '2030-02-01T00:00:00.000Z' },
});

const postDecision = (body) => fetch(`${baseUrl}/webhook/decision`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

test('GET del enlace solo muestra confirmación y no cambia el estado', async () => {
  const a = nuevaAccion();
  const res = await fetch(`${baseUrl}/webhook/decision?actionId=${a.actionId}&token=${a.token}&decision=approve`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /method="POST"/);
  assert.match(html, /&lt;b&gt;Catering&lt;\/b&gt;/); // escapado
  assert.equal(store.obtenerAccion(a.actionId).status, 'PENDING');
});

test('token inválido es rechazado', async () => {
  const a = nuevaAccion();
  const res = await postDecision({ actionId: a.actionId, token: 'x'.repeat(48), decision: 'approve' });
  assert.equal(res.status, 404);
  assert.equal(store.obtenerAccion(a.actionId).status, 'PENDING');
});

test('POST approve aplica (dry run) y es idempotente', async () => {
  const a = nuevaAccion();
  const res = await postDecision({ actionId: a.actionId, token: a.token, decision: 'approve' });
  assert.equal(res.status, 200);
  const guardada = store.obtenerAccion(a.actionId);
  assert.equal(guardada.status, 'APPROVED');
  assert.equal(guardada.executionResult.dryRun, true);

  const segunda = await postDecision({ actionId: a.actionId, token: a.token, decision: 'reject' });
  assert.match(await segunda.text(), /ya aprobada/i);
  assert.equal(store.obtenerAccion(a.actionId).status, 'APPROVED');
});

test('POST reject registra el rechazo', async () => {
  const a = nuevaAccion();
  await postDecision({ actionId: a.actionId, token: a.token, decision: 'reject' });
  assert.equal(store.obtenerAccion(a.actionId).status, 'REJECTED');
});

test('endpoints admin exigen ADMIN_TOKEN', async () => {
  const sin = await fetch(`${baseUrl}/api/pending-actions`);
  assert.equal(sin.status, 401);
  const con = await fetch(`${baseUrl}/api/pending-actions`, { headers: { 'x-admin-token': 'secreto-admin' } });
  assert.equal(con.status, 200);
});
