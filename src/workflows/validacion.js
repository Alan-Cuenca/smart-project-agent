import { sanitizarParametrosTrello } from '../integrations/trello.js';

/**
 * Validación determinista (sin IA) de las acciones propuestas por el Agente Aprobador
 * contra el snapshot real de Trello. Es la última barrera antes de pedir aprobación al Gestor:
 * una acción que no supera esta validación nunca llega al correo ni puede ejecutarse.
 *
 * Reglas:
 * - La tarjeta (idCard) debe existir en el tablero.
 * - La fecha límite propuesta debe ser válida y futura.
 * - La lista destino y los miembros deben existir en el tablero.
 * - La acción debe contener al menos un cambio real.
 *
 * @param {Object} dictamen - Salida del Agente Aprobador.
 * @param {Object} snapshot - Snapshot normalizado de Trello.
 * @param {Date} [ahora=new Date()]
 * @returns {{ dictamen: Object, descartadas: Array<{ itemCode: string, cardName: string, motivos: string[] }> }}
 */
export function validarAccionesContraTrello(dictamen, snapshot, ahora = new Date()) {
  const cardsPorId = new Map((snapshot?.cards || []).map((c) => [c.id, c]));
  const listIds = new Set((snapshot?.lists || []).map((l) => l.id));
  const memberIds = new Set((snapshot?.members || []).map((m) => m.id));

  const validas = [];
  const descartadas = [];

  for (const item of dictamen?.actionItems || []) {
    const motivos = [];
    const params = { ...item.trelloExecutionParams, idCard: item.trelloExecutionParams?.idCard || item.cardId };
    const { cardId, queryParams } = sanitizarParametrosTrello(params);

    const card = cardId ? cardsPorId.get(cardId) : null;
    if (!card) motivos.push(`La tarjeta "${cardId || 'sin ID'}" no existe en el tablero.`);

    if (params.due && !queryParams.due) motivos.push(`Fecha inválida: "${params.due}".`);
    if (queryParams.due && new Date(queryParams.due) <= ahora) {
      motivos.push(`La nueva fecha (${queryParams.due}) no es futura.`);
    }

    if (queryParams.idList && !listIds.has(queryParams.idList)) {
      motivos.push(`La lista destino "${queryParams.idList}" no existe en el tablero.`);
    }

    const miembrosInvalidos = (queryParams.idMembers ? queryParams.idMembers.split(',') : [])
      .filter((id) => !memberIds.has(id));
    if (miembrosInvalidos.length > 0) {
      motivos.push(`Miembros inexistentes en el tablero: ${miembrosInvalidos.join(', ')}.`);
    }

    if (Object.keys(queryParams).length === 0) {
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
      trelloExecutionParams: { idCard: cardId, ...queryParams },
    });
  }

  return { dictamen: { ...dictamen, actionItems: validas }, descartadas };
}

export default { validarAccionesContraTrello };
