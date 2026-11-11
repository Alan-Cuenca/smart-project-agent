import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parsearConfigJson, loadProjectConfig } = await import('../src/config/index.js');

const base = {
  projectName: 'EVENTRA',
  projectDescription: 'Plataforma SaaS multi-tenant para empresas de eventos',
  trelloBoardId: 'abc123',
  projectManagerEmail: 'pm@real.com',
};

test('config: tolera un salto de línea colado en medio de un texto al copiar', () => {
  const json = JSON.stringify(base);
  const roto = `${json.slice(0, 80)}\r\n${json.slice(80)}`;
  assert.throws(() => JSON.parse(roto));
  assert.deepEqual(parsearConfigJson(roto), base);
});

test('config: acepta el archivo formateado en varias líneas y con BOM', () => {
  assert.deepEqual(parsearConfigJson(`﻿${JSON.stringify(base, null, 2)}`), base);
});

test('config: PROJECT_CONFIG_JSON con un comando en vez del JSON da un error claro', () => {
  process.env.PROJECT_CONFIG_JSON = 'node -e "console.log(...)"';
  assert.throws(() => loadProjectConfig(), /no es un JSON válido.*project\.config\.json/);
  delete process.env.PROJECT_CONFIG_JSON;
});
