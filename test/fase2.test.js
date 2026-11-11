import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { calcularMetricas } = await import('../src/analysis/metricas.js');
const { validarAccionesContraTrello } = await import('../src/workflows/validacion.js');
const { sanitizarParametrosTrello, tieneCambios } = await import('../src/integrations/trello.js');
const { tipoDeCommit } = await import('../src/integrations/github.js');

const ahora = new Date('2026-11-11T12:00:00Z');

const config = {
  projectName: 'EVENTRA',
  deadline: '2026-11-20',
  team: [
    { name: 'Dev Uno', trelloUsername: 'dev1', gitEmails: ['dev1@x.com'], role: 'Backend', assignable: true },
    { name: 'Docs', trelloUsername: 'docs', gitEmails: [], role: 'Documentación', assignable: true },
    { name: 'Revisor', trelloUsername: 'rev', gitEmails: [], role: 'Revisor', assignable: false },
  ],
};

const card = (id, name, listId, listName, { due, start = null, done = false, assignees = [] } = {}) => ({
  id, name, description: '', list: { id: listId, name: listName },
  startDate: start, dueDate: due, dueComplete: done, assignees,
});

const snapshot = {
  board: { id: 'b1', name: 'EVENTRA' },
  lists: [
    { id: 'L3', name: 'Fase 3: Construcción' },
    { id: 'L4', name: 'Fase 4: Integración, validación y pruebas' },
    { id: 'L5', name: 'Fase 5: Despliegue y cierre' },
  ],
  members: [
    { id: 'M1', username: 'dev1', fullName: 'Dev Uno' },
    { id: 'M2', username: 'docs', fullName: 'Docs' },
    { id: 'M3', username: 'rev', fullName: 'Revisor' },
  ],
  cards: [
    card('c1', '3.1 Auth', 'L3', 'Fase 3: Construcción', { due: '2026-10-10T17:00:00Z', done: true }),
    card('c2', '4.1 Integración', 'L4', 'Fase 4: Integración, validación y pruebas', { start: '2026-11-02T12:00:00Z', due: '2026-11-03T17:00:00Z', done: true }),
    card('c3', '4.5 Flujo completo', 'L4', 'Fase 4: Integración, validación y pruebas', { due: '2026-11-10T17:00:00Z' }),
    card('c4', '4.6 Corrección', 'L4', 'Fase 4: Integración, validación y pruebas', { due: '2026-11-12T17:00:00Z', assignees: [{ id: 'M3' }] }),
    card('c5', '5.5 Cierre', 'L5', 'Fase 5: Despliegue y cierre', { due: '2026-11-25T17:00:00Z' }),
  ],
};

const github = {
  disponible: true,
  repositorio: 'org/repo',
  branch: 'main',
  desde: '2026-10-28T00:00:00Z',
  ci: { resultado: 'failure', estado: 'completed', fecha: '2026-11-11T10:00:00Z', commit: 'feat: x' },
  commits: [
    { sha: 'a1', mensaje: 'feat(portal): nueva vista', tipo: 'feat', autor: 'Dev', email: 'dev1@x.com', fecha: '2026-11-10T10:00:00Z' },
    { sha: 'a2', mensaje: 'fix: bug', tipo: 'fix', autor: 'Dev', email: 'dev1@x.com', fecha: '2026-11-09T10:00:00Z' },
    { sha: 'a3', mensaje: 'feat: vieja', tipo: 'feat', autor: 'Dev', email: 'dev1@x.com', fecha: '2026-10-29T10:00:00Z' },
  ],
};

const codigos = (m) => m.alertas.map((a) => a.codigo);

test('métricas: avance por fase, fase actual y días a la entrega', () => {
  const m = calcularMetricas({ snapshot, config, github, ahora });
  assert.equal(m.avanceGlobal, 40);
  assert.equal(m.faseActual, 'Fase 4: Integración, validación y pruebas');
  assert.equal(m.entrega.diasRestantes, 10);
  const f4 = m.fases.find((f) => f.id === 'L4');
  assert.deepEqual([f4.completadas, f4.total, f4.inicio], [1, 3, '2026-11-02']);
});

test('métricas: detecta vencidas, 48h, fuera de plazo, sin responsable y revisor asignado', () => {
  const m = calcularMetricas({ snapshot, config, github, ahora });
  const c = codigos(m);
  for (const esperado of ['TAREAS_VENCIDAS', 'VENCEN_EN_48H', 'FUERA_DE_PLAZO', 'SIN_RESPONSABLE', 'REVISOR_ASIGNADO']) {
    assert.ok(c.includes(esperado), `falta alerta ${esperado}`);
  }
  assert.equal(m.alertas.find((a) => a.codigo === 'TAREAS_VENCIDAS').cardIds[0], 'c3');
});

test('métricas: CI fallido y feat dentro de la fase de pruebas (solo desde su inicio)', () => {
  const m = calcularMetricas({ snapshot, config, github, ahora });
  assert.ok(codigos(m).includes('CI_FALLIDO'));
  assert.deepEqual(m.repositorio.featEnFaseActual.map((c) => c.sha), ['a1']);
  const dev = m.equipo.find((e) => e.name === 'Dev Uno');
  assert.equal(dev.commits, 3);
});

test('métricas: alertas ordenadas por severidad y sin GitHub no falla', () => {
  const m = calcularMetricas({ snapshot, config, github: null, ahora });
  assert.equal(m.repositorio.disponible, false);
  const orden = { CRITICA: 0, ALTA: 1, MEDIA: 2, INFO: 3 };
  const sev = m.alertas.map((a) => orden[a.severidad]);
  assert.deepEqual(sev, [...sev].sort((a, b) => a - b));
});

test('validación: rechaza asignar al revisor y fechas posteriores a la entrega', () => {
  const { dictamen, descartadas } = validarAccionesContraTrello({
    actionItems: [
      { itemCode: 'A', cardId: 'c3', trelloExecutionParams: { idCard: 'c3', idMembers: ['M3'] } },
      { itemCode: 'B', cardId: 'c3', trelloExecutionParams: { idCard: 'c3', due: '2026-11-22T12:00:00Z' } },
      { itemCode: 'C', cardId: 'c3', trelloExecutionParams: { idCard: 'c3', idMembers: ['M1', 'M2'] } },
    ],
  }, snapshot, { ahora, config });
  assert.deepEqual(descartadas.map((d) => d.itemCode), ['A', 'B']);
  assert.match(descartadas[0].motivos.join(' '), /no ejecuta tareas/);
  assert.equal(dictamen.actionItems[0].itemCode, 'C');
});

test('validación: una acción solo con comentario es válida', () => {
  const { dictamen } = validarAccionesContraTrello({
    actionItems: [{ itemCode: 'D', cardId: 'c4', trelloExecutionParams: { idCard: 'c4', comment: '  Revisar CI antes de cerrar  ' } }],
  }, snapshot, { ahora, config });
  assert.equal(dictamen.actionItems.length, 1);
  assert.equal(dictamen.actionItems[0].trelloExecutionParams.comment, 'Revisar CI antes de cerrar');
});

test('validación: una fecha del mismo día no cuenta como reprogramación', () => {
  const { dictamen, descartadas } = validarAccionesContraTrello({
    actionItems: [
      { itemCode: 'E', cardId: 'c4', trelloExecutionParams: { idCard: 'c4', due: '2026-11-12T23:59:59Z' } },
      { itemCode: 'F', cardId: 'c4', trelloExecutionParams: { idCard: 'c4', due: '2026-11-12T23:59:59Z', idMembers: ['M1'] } },
    ],
  }, snapshot, { ahora, config });
  assert.deepEqual(descartadas.map((d) => d.itemCode), ['E']);
  assert.equal(dictamen.actionItems[0].trelloExecutionParams.due, undefined);
  assert.equal(dictamen.actionItems[0].trelloExecutionParams.idMembers, 'M1');
});

test('sanitizar: comentario vacío no cuenta como cambio y se recorta el largo', () => {
  assert.equal(tieneCambios(sanitizarParametrosTrello({ idCard: 'x', comment: '   ' })), false);
  assert.equal(sanitizarParametrosTrello({ idCard: 'x', comment: 'a'.repeat(5000) }).comment.length, 2000);
});

test('github: tipo de commit convencional', () => {
  assert.equal(tipoDeCommit('feat(portal): algo'), 'feat');
  assert.equal(tipoDeCommit('fix!: urgente'), 'fix');
  assert.equal(tipoDeCommit('Merge branch main'), 'otro');
});
