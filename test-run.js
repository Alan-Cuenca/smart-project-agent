import dotenv from 'dotenv';
import { ejecutarAuditoriaManual } from './src/workflows/index.js';

dotenv.config();

/**
 * Script de terminal para ejecutar la auditoría manual del agente de forma inmediata.
 * Permite probar el flujo multiagente (Trello -> Ejecutor -> Revisor -> Aprobador -> Mailer)
 * directamente desde la línea de comandos sin esperar la programación de cron.
 */
(async () => {
  try {
    console.log('================================================================');
    console.log('🤖 SMART PROJECT AGENT - EJECUCIÓN MANUAL DE AUDITORÍA');
    console.log('================================================================');

    const resultado = await ejecutarAuditoriaManual();

    console.log('\n================================================================');
    console.log('🎉 Auditoría completada con éxito.');
    if (resultado?.aprobadorVerdict) {
      console.log(`Dictamen de Riesgo: ${resultado.aprobadorVerdict.overallRisk || 'N/A'}`);
      console.log(`Acciones evaluadas: ${resultado.aprobadorVerdict.actionItems?.length || 0}`);
    }
    console.log('================================================================\n');

    process.exit(0);
  } catch (error) {
    console.error('\n💥 Error durante la ejecución de la auditoría manual:', error.message || error);
    process.exit(1);
  }
})();
