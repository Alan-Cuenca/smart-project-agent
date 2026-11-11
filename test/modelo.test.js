import { test } from 'node:test';
import assert from 'node:assert/strict';

const { obtenerModelosConfigurados } = await import('../src/agents/modelo.js');

test('modelos: variables vacías (como llegan desde GitHub Actions) usan los valores por defecto', () => {
  process.env.GEMINI_MODEL = '';
  process.env.GEMINI_FALLBACK_MODELS = '';
  const modelos = obtenerModelosConfigurados();
  assert.equal(modelos[0], 'gemini-3.8-flash');
  assert.ok(modelos.length > 1, 'debe haber modelos de respaldo');
});

test('modelos: respeta la configuración explícita sin duplicados', () => {
  process.env.GEMINI_MODEL = 'modelo-a';
  process.env.GEMINI_FALLBACK_MODELS = 'modelo-b, modelo-a ,modelo-c';
  assert.deepEqual(obtenerModelosConfigurados(), ['modelo-a', 'modelo-b', 'modelo-c']);
});
