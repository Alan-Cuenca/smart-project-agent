import { sanitizarParametrosTrello, tieneCambios } from '../integrations/trello.js';

/**
 * Validación determinista (sin IA) de las acciones propuestas por el Agente Aprobador
 * contra el snapshot real de Trello. Es la última barrera antes de pedir aprobación al Gestor:
 * una acción que no supera esta validación nunca llega al correo ni puede ejecutarse.
 *
 * Reglas:
 * - La tarjeta (idCard) debe existir en el tablero.
 * - La fecha límite propuesta debe ser válida, futura y no posterior a la entrega (si hay deadline).
 * - La lista destino y los miembros deben existir en el tablero.
 * - No se puede asignar a miembros marcados como "assignable": false (p. ej. revisores).
 * - La acción debe contener al menos un cambio real (fecha, lista, responsables o comentario).
 *
 * @param {Object} dictamen - Salida del Agente Aprobador.
 * @param {Object} snapshot - Snapshot normalizado de Trello.
 * @param {Object} [opciones]
 * @param {Date} [opciones.ahora=new Date()]
 * @param {Object} [opciones.config] - project.config.json (team, deadline).
 * @returns {{ dictamen: Object, descartadas: Array<{ itemCode: string, cardName: string, motivos: string[] }> }}
 */
export function validarAccionesContraTrello(dictamen, snapshot, { ahora = new Date(), config = null } = {}) {
  const cardsPorId = new Map((snapshot?.cards || []).map((c) => [c.id, c]));
  const listIds = new Set((snapshot?.lists || []).map((l) => l.id));
  const miembrosPorId = new Map((snapshot?.members || []).map((m) => [m.id, m]));

  const noAsignables = new Set(
    (config?.team || []).filter((m) => m.assignable === false).map((m) => m.trelloUsername?.toLowerCase())
  );
  const deadline = config?.deadline ? new Date(`${String(config.deadline).slice(0, 10)}T23:59:59`) : null;

  const validas = [];
  const descartadas = [];

  for (const item of dictamen?.actionItems || []) {
    const motivos = [];
    const params = { ...item.trelloExecutionParams, idCard: item.trelloExecutionParams?.idCard || item.cardId };
    const saneados = sanitizarParametrosTrello(params);
    const { cardId, queryParams, comment } = saneados;

    const card = cardId ? cardsPorId.get(cardId) : null;
    if (!card) motivos.push(`La tarjeta "${cardId || 'sin ID'}" no existe en el tablero.`);

    // Una "reprogramación" al mismo día que la fecha actual no es un cambio real: se descarta ese campo.
    if (card && queryParams.due && card.dueDate && queryParams.due.slice(0, 10) === String(card.dueDate).slice(0, 10)) {
      delete queryParams.due;
      delete params.due;
    }

    if (params.due && !queryParams.due) motivos.push(`Fecha inválida: "${params.due}".`);
    if (queryParams.due && new Date(queryParams.due) <= ahora) {
      motivos.push(`La nueva fecha (${queryParams.due}) no es futura.`);
    }
    if (queryParams.due && deadline && new Date(queryParams.due) > deadline) {
      motivos.push(`La nueva fecha (${queryParams.due}) es posterior a la entrega del proyecto (${config.deadline}).`);
    }

    if (queryParams.idList && !listIds.has(queryParams.idList)) {
      motivos.push(`La lista destino "${queryParams.idList}" no existe en el tablero.`);
    }

    const idsMiembros = queryParams.idMembers ? queryParams.idMembers.split(',') : [];
    const inexistentes = idsMiembros.filter((id) => !miembrosPorId.has(id));
    if (inexistentes.length > 0) {
      motivos.push(`Miembros inexistentes en el tablero: ${inexistentes.join(', ')}.`);
    }
    const revisores = idsMiembros
      .map((id) => miembrosPorId.get(id))
      .filter((m) => m && noAsignables.has(m.username?.toLowerCase()));
    if (revisores.length > 0) {
      motivos.push(`No se puede asignar tareas a ${revisores.map((m) => m.fullName || m.username).join(', ')} (no ejecuta tareas según la configuración del equipo).`);
    }

    if (!tieneCambios(saneados)) {
      motivos.push('La acción no contiene ningún cambio aplicable en Trello.');
    }

    if (motivos.length > 0) {
      descartadas.push({ itemCode: item.itemCode, cardName: item.cardName, motivos });
      continue;
    }

    validas.push({
      ...item,
      cardId,
      cardName: card.name, // nombre real, no el que escribió la IA
      trelloExecutionParams: { idCard: cardId, ...queryParams, ...(comment ? { comment } : {}) },
    });
  }

  return { dictamen: { ...dictamen, actionItems: validas }, descartadas };
}

export default { validarAccionesContraTrello };
