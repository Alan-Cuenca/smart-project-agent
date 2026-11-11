/**
 * Escapa texto para insertarlo de forma segura en HTML.
 * Todo contenido proveniente de Trello, de la IA o de la URL debe pasar por aquí.
 * @param {unknown} valor
 * @returns {string}
 */
export const escapeHtml = (valor) =>
  String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export default { escapeHtml };
