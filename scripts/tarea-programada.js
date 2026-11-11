import dotenv from 'dotenv';
import { ejecutarAuditoriaDiaria, ejecutarReporteSemanal } from '../src/workflows/cron.js';

dotenv.config({ quiet: true });

/**
 * Punto de entrada para ejecutar las tareas programadas fuera del servidor (GitHub Actions).
 *   node scripts/tarea-programada.js diaria   → auditoría con los agentes + correo si corresponde
 *   node scripts/tarea-programada.js semanal  → reporte semanal determinista
 *
 * Termina con código 1 si la tarea falla, para que el workflow quede en rojo y se note.
 */
const TAREAS = {
  diaria: ejecutarAuditoriaDiaria,
  semanal: ejecutarReporteSemanal,
};

const nombre = process.argv[2];
const tarea = TAREAS[nombre];

if (!tarea) {
  console.error(`Uso: node scripts/tarea-programada.js <${Object.keys(TAREAS).join('|')}>`);
  process.exit(2);
}

// En GitHub Actions el disco es efímero: sin Supabase, las acciones del correo no llegarían al servidor.
if (process.env.GITHUB_ACTIONS === 'true' && nombre === 'diaria'
  && !(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: las acciones no serían visibles para el servidor.');
  process.exit(1);
}

const resultado = await tarea();
process.exit(resultado ? 0 : 1);
