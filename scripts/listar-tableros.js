import dotenv from 'dotenv';
import { TrelloIntegration } from '../src/integrations/trello.js';

dotenv.config();

/**
 * Lista los tableros de Trello accesibles con TRELLO_API_KEY / TRELLO_TOKEN
 * para copiar el ID correcto en project.config.json (campo trelloBoardId).
 */
(async () => {
  try {
    const trello = new TrelloIntegration({ boardId: 'no-requerido' });
    const tableros = await trello.getMyBoards();

    if (!tableros?.length) {
      console.log('No se encontraron tableros abiertos para estas credenciales.');
      return;
    }

    console.log('\nTableros disponibles (copia el ID en project.config.json → "trelloBoardId"):\n');
    console.table(tableros.map((t) => ({ id: t.id, nombre: t.name, url: t.url })));
  } catch (error) {
    console.error('Error consultando Trello:', error.message);
    process.exit(1);
  }
})();
