import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { loadProjectConfig } from '../config/index.js';
import { invocarGemini } from './modelo.js';

/**
 * Resumen del equipo para los prompts (sin datos de contacto).
 * @param {Object} metricas
 */
export const equipoParaPrompt = (metricas) =>
  (metricas?.equipo || []).map((m) => ({
    trelloMemberId: m.trelloMemberId,
    nombre: m.name,
    rol: m.role,
    puedeRecibirTareas: m.assignable,
    tareasPendientesAsignadas: m.tareasPendientesAsignadas,
    commitsRecientes: m.commits,
    commitsPorTipo: m.commitsPorTipo,
    ultimoCommit: m.ultimoCommit,
  }));

/**
 * Agente Ejecutor: interpreta las métricas deterministas del proyecto (Trello + GitHub),
 * identifica los riesgos que amenazan la fecha de entrega y propone acciones correctivas.
 *
 * Las cifras ya vienen calculadas por el código (src/analysis/metricas.js); el agente no
 * recalcula fechas ni conteos: razona sobre ellos.
 *
 * @param {Object} datosTrello - Snapshot normalizado de Trello (se usa solo si no hay métricas).
 * @param {Object} [configProyecto] - project.config.json.
 * @param {Object} [metricas] - Resultado de calcularMetricas().
 * @returns {Promise<string>} Diagnóstico y propuesta textual para el Agente Revisor.
 */
export async function analizarPlanificacion(datosTrello, configProyecto = null, metricas = null) {
  try {
    if (!datosTrello || typeof datosTrello !== 'object') {
      throw new Error('[AgenteEjecutor] Se requiere el objeto JSON estructurado de Trello (datosTrello).');
    }

    const config = configProyecto || (() => {
      try {
        return loadProjectConfig();
      } catch {
        return { projectName: 'Proyecto Genérico' };
      }
    })();

    const projectName = config?.projectName || 'Proyecto Genérico';

    const promptSistema = `
Eres el **Agente Ejecutor**, un Project Manager técnico senior que da seguimiento al proyecto de software **"${projectName}"**.
${config?.projectDescription ? `Producto: ${config.projectDescription}` : ''}

Contexto de trabajo:
- El proyecto avanza por **fases secuenciales** (cada lista del tablero de Trello es una fase). Una tarea está terminada cuando su fecha está marcada como completada.
- ${metricas?.entrega ? `La **fecha de entrega final es ${metricas.entrega.fecha}** (quedan ${metricas.entrega.diasRestantes} días). Todo debe planificarse para cumplirla.` : 'No hay fecha de entrega configurada.'}
- Recibirás **métricas ya calculadas por el sistema** (avance por fase, tareas pendientes, carga del equipo, actividad del repositorio, estado del CI) y **alertas** priorizadas. Esas cifras son exactas: no las recalcules ni las contradigas.

Tu tarea:
1. **Diagnóstico:** explica en pocas líneas el estado real del proyecto frente a la entrega y qué riesgos concretos existen (usa las alertas como punto de partida).
2. **Propuestas de acción** (solo sobre tareas PENDIENTES, máximo 6, las de mayor impacto primero). Tipos posibles:
   - **ASIGNACION:** proponer responsables para tareas sin dueño, según el rol de cada persona y su carga. Nunca asignes a quien tenga \`puedeRecibirTareas: false\`. Las tareas de documentación/manuales van a quien tenga el rol de documentación.
   - **REPROGRAMACION:** mover fechas solo si es necesario y siempre antes de la fecha de entrega.
   - **COMENTARIO:** dejar en la tarjeta una nota accionable para el equipo (p. ej. qué debe verificarse antes de cerrarla, un riesgo detectado en el repositorio o el CI). Debe ser concreta y breve.
3. Para cada propuesta indica: tarjeta (nombre e ID exacto), problema, acción, responsable(s) con su trelloMemberId si aplica, nueva fecha si aplica, el texto del comentario si aplica, y la justificación basada en las métricas.

Reglas:
- Usa solo IDs y nombres que aparezcan en los datos.
- Si el CI falla o entran funcionalidades nuevas en fase de pruebas, tradúcelo en acciones sobre las tarjetas pendientes relacionadas (p. ej. un comentario en la tarea de corrección de errores).
- Sé directo y práctico: el destinatario es el Gestor del Proyecto, que aprobará o rechazará cada acción.
`.trim();

    const datos = metricas
      ? {
          proyecto: { nombre: projectName, entrega: metricas.entrega, faseActual: metricas.faseActual, avanceGlobal: metricas.avanceGlobal },
          fases: metricas.fases,
          tareasPendientes: metricas.tareasPendientes,
          equipo: equipoParaPrompt(metricas),
          repositorio: metricas.repositorio,
          alertas: metricas.alertas,
        }
      : datosTrello;

    const humanMessage = new HumanMessage(
      `Fecha y hora actual: ${new Date().toISOString()}\n\n` +
      `Datos del proyecto:\n\n\`\`\`json\n${JSON.stringify(datos, null, 2)}\n\`\`\`\n\n` +
      'Elabora tu diagnóstico y tus propuestas de acción.'
    );

    console.log(`[AgenteEjecutor] Analizando planificación del proyecto "${projectName}"...`);

    const { resultado } = await invocarGemini({
      agente: 'AgenteEjecutor',
      mensajes: [new SystemMessage(promptSistema), humanMessage],
      temperature: 0.2,
    });

    console.log('[AgenteEjecutor] Propuesta de planificación generada exitosamente.');
    return resultado.content;

  } catch (error) {
    console.error('[AgenteEjecutor] Error al procesar la auditoría con Google Gemini:', error.message);
    throw new Error(`[AgenteEjecutor Falló]: ${error.message}`);
  }
}

export default {
  analizarPlanificacion,
  equipoParaPrompt,
};
