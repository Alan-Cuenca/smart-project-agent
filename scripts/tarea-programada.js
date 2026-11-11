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

/**
 * Verificación previa: lista por NOMBRE (nunca por valor) las variables que faltan o son inválidas,
 * para diagnosticar el workflow sin exponer secretos en los logs.
 */
const verificarEntorno = () => {
  const env = process.env;
  const requeridas = ['TRELLO_API_KEY', 'TRELLO_TOKEN', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];
  if (nombre === 'diaria') {
    requeridas.push('GEMINI_API_KEY', 'APP_BASE_URL');
    // En GitHub Actions el disco es efímero: sin Supabase, las acciones del correo no llegarían al servidor.
    if (env.GITHUB_ACTIONS === 'true') requeridas.push('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  }

  const problemas = requeridas.filter((n) => !env[n]?.trim()).map((n) => `${n}: no está definida o está vacía`);

  if (!env.PROJECT_CONFIG_JSON?.trim() && env.GITHUB_ACTIONS === 'true') {
    problemas.push('PROJECT_CONFIG_JSON: no está definida o está vacía');
  } else if (env.PROJECT_CONFIG_JSON?.trim()) {
    try {
      JSON.parse(env.PROJECT_CONFIG_JSON);
    } catch (error) {
      problemas.push(`PROJECT_CONFIG_JSON: no es JSON válido (${error.message}). Debe ser la línea que empieza con {"projectName"...`);
    }
  }

  if (env.APP_BASE_URL && !/^https?:\/\/[^/]+/.test(env.APP_BASE_URL)) {
    problemas.push('APP_BASE_URL: debe ser una URL completa, p. ej. https://smart-project-agent.onrender.com');
  }
  if (env.SUPABASE_URL && !/^https:\/\/.+\.supabase\.co\/?$/.test(env.SUPABASE_URL.trim())) {
    problemas.push('SUPABASE_URL: debe tener la forma https://<proyecto>.supabase.co');
  }

  if (problemas.length > 0) {
    console.error(`❌ Configuración incompleta para la tarea "${nombre}":`);
    problemas.forEach((p) => console.error(`   - ${p}`));
    console.error('Revisa Settings → Secrets and variables → Actions (los nombres deben coincidir exactamente).');
    process.exit(1);
  }
  console.log(`✅ Verificación de configuración superada para la tarea "${nombre}".`);
};

verificarEntorno();

const resultado = await tarea();
process.exit(resultado ? 0 : 1);
