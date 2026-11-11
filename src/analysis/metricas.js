/**
 * Métricas deterministas del proyecto (sin IA).
 *
 * Combina el snapshot de Trello (tablero organizado por fases), la configuración del equipo
 * y la actividad de GitHub para producir hechos verificables y alertas priorizadas.
 * Los agentes de IA reciben este resultado como base: interpretan y proponen, pero no calculan.
 */

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

// Fases en las que, por planificación, no deberían entrar funcionalidades nuevas.
const PATRON_FASE_ESTABILIZACION = /prueba|validaci|integraci|despliegue|cierre|capacitaci/i;

const SEVERIDAD_ORDEN = { CRITICA: 0, ALTA: 1, MEDIA: 2, INFO: 3 };

const diasEntre = (desde, hasta) => Math.ceil((hasta.getTime() - desde.getTime()) / DIA);
const fechaCorta = (iso) => (iso ? String(iso).slice(0, 10) : null);

/**
 * Vincula los miembros del tablero con la configuración del equipo.
 * @returns {Map<string, Object>} trelloMemberId -> miembro enriquecido
 */
const construirEquipo = (snapshot, config) => {
  const porUsername = new Map((config?.team || []).map((m) => [m.trelloUsername?.toLowerCase(), m]));
  const equipo = new Map();

  for (const miembro of snapshot?.members || []) {
    const conf = porUsername.get(miembro.username?.toLowerCase());
    equipo.set(miembro.id, {
      trelloMemberId: miembro.id,
      trelloUsername: miembro.username,
      name: conf?.name || miembro.fullName || miembro.username,
      role: conf?.role || 'Sin rol configurado',
      assignable: conf ? conf.assignable !== false : true,
      gitEmails: (conf?.gitEmails || []).map((e) => e.toLowerCase()),
      configurado: Boolean(conf),
    });
  }
  return equipo;
};

/**
 * Calcula las métricas y alertas del proyecto.
 *
 * @param {Object} params
 * @param {Object} params.snapshot - Snapshot normalizado de Trello.
 * @param {Object} params.config - project.config.json.
 * @param {Object} [params.github] - Resultado de obtenerActividadRepositorio.
 * @param {Date} [params.ahora]
 * @returns {Object}
 */
export function calcularMetricas({ snapshot, config, github = null, ahora = new Date() }) {
  const alertas = [];
  const alertar = (severidad, codigo, mensaje, cardIds = []) => alertas.push({ severidad, codigo, mensaje, cardIds });

  const equipo = construirEquipo(snapshot, config);
  const cards = snapshot?.cards || [];

  // ---------------------------------------------------------------------------
  // Fases (cada lista del tablero es una fase, en orden)
  // ---------------------------------------------------------------------------
  const fases = (snapshot?.lists || []).map((lista) => {
    const delaFase = cards.filter((c) => c.list?.id === lista.id);
    const completadas = delaFase.filter((c) => c.dueComplete).length;
    const fechasInicio = delaFase.map((c) => c.startDate || c.dueDate).filter(Boolean).sort();
    const fechasFin = delaFase.map((c) => c.dueDate).filter(Boolean).sort();
    const total = delaFase.length;

    return {
      id: lista.id,
      nombre: lista.name,
      total,
      completadas,
      pendientes: total - completadas,
      avance: total ? Math.round((completadas / total) * 100) : 100,
      inicio: fechaCorta(fechasInicio[0]),
      fin: fechaCorta(fechasFin[fechasFin.length - 1]),
    };
  });

  const faseActual = fases.find((f) => f.pendientes > 0) || null;
  const totalTarjetas = cards.length;
  const totalCompletadas = cards.filter((c) => c.dueComplete).length;

  // ---------------------------------------------------------------------------
  // Fecha de entrega
  // ---------------------------------------------------------------------------
  const deadline = config?.deadline ? new Date(`${fechaCorta(config.deadline)}T23:59:59`) : null;
  const diasRestantes = deadline ? diasEntre(ahora, deadline) : null;

  if (deadline && diasRestantes < 0) {
    alertar('CRITICA', 'ENTREGA_VENCIDA', `La fecha de entrega (${fechaCorta(config.deadline)}) ya pasó y quedan ${totalTarjetas - totalCompletadas} tareas pendientes.`);
  }

  // ---------------------------------------------------------------------------
  // Tareas pendientes
  // ---------------------------------------------------------------------------
  const pendientes = cards
    .filter((c) => !c.dueComplete)
    .map((c) => {
      const due = c.dueDate ? new Date(c.dueDate) : null;
      const horasRestantes = due ? Math.round((due.getTime() - ahora.getTime()) / HORA) : null;
      const responsables = (c.assignees || []).map((a) => equipo.get(a.id)).filter(Boolean);
      return {
        id: c.id,
        nombre: c.name,
        fase: c.list?.name,
        inicio: fechaCorta(c.startDate),
        vence: fechaCorta(c.dueDate),
        horasRestantes,
        vencida: horasRestantes !== null && horasRestantes < 0,
        responsables: responsables.map((r) => r.name),
        responsableIds: responsables.map((r) => r.trelloMemberId),
        tieneDescripcion: Boolean(c.description?.trim()),
        fueraDePlazo: Boolean(deadline && due && due > deadline),
      };
    })
    .sort((a, b) => (a.vence || '9999').localeCompare(b.vence || '9999'));

  const vencidas = pendientes.filter((t) => t.vencida);
  if (vencidas.length) {
    alertar('ALTA', 'TAREAS_VENCIDAS',
      `${vencidas.length} tarea(s) vencida(s) sin completar: ${vencidas.map((t) => `"${t.nombre}" (venció ${t.vence})`).join(', ')}.`,
      vencidas.map((t) => t.id));
  }

  const proximas = pendientes.filter((t) => !t.vencida && t.horasRestantes !== null && t.horasRestantes <= 48);
  if (proximas.length) {
    alertar('MEDIA', 'VENCEN_EN_48H',
      `${proximas.length} tarea(s) vencen en las próximas 48 horas: ${proximas.map((t) => `"${t.nombre}" (${t.vence})`).join(', ')}.`,
      proximas.map((t) => t.id));
  }

  const fueraDePlazo = pendientes.filter((t) => t.fueraDePlazo);
  if (fueraDePlazo.length) {
    alertar('ALTA', 'FUERA_DE_PLAZO',
      `${fueraDePlazo.length} tarea(s) vencen después de la fecha de entrega: ${fueraDePlazo.map((t) => `"${t.nombre}"`).join(', ')}.`,
      fueraDePlazo.map((t) => t.id));
  }

  const sinResponsable = pendientes.filter((t) => t.responsables.length === 0);
  if (sinResponsable.length) {
    alertar('MEDIA', 'SIN_RESPONSABLE',
      `${sinResponsable.length} de ${pendientes.length} tareas pendientes no tienen responsable asignado en Trello.`,
      sinResponsable.map((t) => t.id));
  }

  const conRevisor = pendientes.filter((t) => t.responsableIds.some((id) => equipo.get(id)?.assignable === false));
  if (conRevisor.length) {
    alertar('MEDIA', 'REVISOR_ASIGNADO',
      `Hay tareas asignadas a personas que no ejecutan tareas (revisores): ${conRevisor.map((t) => `"${t.nombre}"`).join(', ')}.`,
      conRevisor.map((t) => t.id));
  }

  // ---------------------------------------------------------------------------
  // Equipo y repositorio
  // ---------------------------------------------------------------------------
  const commits = github?.disponible ? github.commits : [];
  const miembroPorEmail = new Map();
  for (const m of equipo.values()) m.gitEmails.forEach((e) => miembroPorEmail.set(e, m));

  const resumenEquipo = Array.from(equipo.values()).map((m) => {
    const propios = commits.filter((c) => miembroPorEmail.get(c.email) === m);
    const porTipo = {};
    propios.forEach((c) => { porTipo[c.tipo] = (porTipo[c.tipo] || 0) + 1; });
    return {
      name: m.name,
      trelloMemberId: m.trelloMemberId,
      role: m.role,
      assignable: m.assignable,
      tareasPendientesAsignadas: pendientes.filter((t) => t.responsableIds.includes(m.trelloMemberId)).length,
      commits: propios.length,
      commitsPorTipo: porTipo,
      ultimoCommit: fechaCorta(propios[0]?.fecha),
    };
  });

  const noConfigurados = Array.from(equipo.values()).filter((m) => !m.configurado);
  if (config?.team && noConfigurados.length) {
    alertar('INFO', 'MIEMBRO_SIN_CONFIGURAR',
      `Miembros del tablero sin rol en project.config.json: ${noConfigurados.map((m) => m.trelloUsername).join(', ')}.`);
  }

  let repositorio = { disponible: false, error: github?.error || 'GitHub no consultado.' };
  if (github?.disponible) {
    const porTipo = {};
    commits.forEach((c) => { porTipo[c.tipo] = (porTipo[c.tipo] || 0) + 1; });

    const ultimo = commits[0]?.fecha ? new Date(commits[0].fecha) : null;
    const diasSinCommits = ultimo ? Math.floor((ahora.getTime() - ultimo.getTime()) / DIA) : null;

    const inicioFase = faseActual?.inicio ? new Date(`${faseActual.inicio}T00:00:00`) : null;
    const featEnEstabilizacion = faseActual && PATRON_FASE_ESTABILIZACION.test(faseActual.nombre) && inicioFase
      ? commits.filter((c) => c.tipo === 'feat' && new Date(c.fecha) >= inicioFase)
      : [];

    repositorio = {
      disponible: true,
      repositorio: github.repositorio,
      ventanaDesde: fechaCorta(github.desde),
      totalCommits: commits.length,
      commitsPorTipo: porTipo,
      diasSinCommits,
      ci: github.ci,
      featEnFaseActual: featEnEstabilizacion.map((c) => ({ sha: c.sha, fecha: fechaCorta(c.fecha), mensaje: c.mensaje })),
      autoresNoIdentificados: [...new Set(commits.filter((c) => !miembroPorEmail.has(c.email)).map((c) => c.autor))],
    };

    if (github.ci?.resultado === 'failure') {
      alertar('ALTA', 'CI_FALLIDO',
        `El último pipeline de CI en ${github.branch} falló (${fechaCorta(github.ci.fecha)}, commit: "${github.ci.commit}"). Revisar antes de seguir integrando.`);
    }

    if (featEnEstabilizacion.length) {
      alertar('MEDIA', 'FUNCIONALIDADES_EN_FASE_DE_PRUEBAS',
        `Entraron ${featEnEstabilizacion.length} commit(s) de funcionalidad nueva (feat) durante "${faseActual.nombre}", ` +
        `una fase de estabilización: ${featEnEstabilizacion.slice(0, 5).map((c) => `"${c.mensaje}"`).join(', ')}. ` +
        'Las funciones nuevas en esta etapa aumentan el riesgo de no cerrar las pruebas a tiempo.');
    }

    if (pendientes.length && diasSinCommits !== null && diasSinCommits >= 3) {
      alertar('MEDIA', 'REPOSITORIO_INACTIVO', `No hay commits en ${github.branch} desde hace ${diasSinCommits} días y quedan ${pendientes.length} tareas pendientes.`);
    }

    const conCommits = resumenEquipo.filter((m) => m.commits > 0);
    const top = conCommits.sort((a, b) => b.commits - a.commits)[0];
    if (top && commits.length >= 10 && top.commits / commits.length >= 0.7) {
      alertar('INFO', 'CONCENTRACION_DE_COMMITS',
        `${top.name} concentra ${Math.round((top.commits / commits.length) * 100)}% de los commits recientes. Considerar distribuir el trabajo técnico pendiente.`);
    }
  }

  alertas.sort((a, b) => SEVERIDAD_ORDEN[a.severidad] - SEVERIDAD_ORDEN[b.severidad]);

  return {
    fechaCorte: ahora.toISOString(),
    entrega: deadline ? { fecha: fechaCorta(config.deadline), diasRestantes } : null,
    avanceGlobal: totalTarjetas ? Math.round((totalCompletadas / totalTarjetas) * 100) : 0,
    totalTareas: totalTarjetas,
    tareasCompletadas: totalCompletadas,
    faseActual: faseActual?.nombre || 'Todas las fases completadas',
    fases,
    tareasPendientes: pendientes,
    equipo: resumenEquipo,
    repositorio,
    alertas,
  };
}

export default { calcularMetricas };
