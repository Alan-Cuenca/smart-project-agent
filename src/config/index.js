import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

const CAMPOS_OBLIGATORIOS = ['projectName', 'trelloBoardId', 'projectManagerEmail'];

// Valores del archivo de ejemplo: si aparecen, la configuración no fue personalizada.
const VALORES_DE_EJEMPLO = new Set(['65b1234567890abcdef12345', 'pm@example.com']);

/**
 * Carga y valida project.config.json.
 * Ya no se usa project.config.example.json como respaldo: auditar un tablero
 * ficticio o enviar correos a pm@example.com fallaba de forma silenciosa.
 *
 * @param {string} [customPath]
 * @returns {Object} Configuración del proyecto validada.
 */
export const loadProjectConfig = (customPath) => {
  const configPath = customPath || process.env.PROJECT_CONFIG_PATH || path.join(rootDir, 'project.config.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `[Config] No se encontró ${configPath}. Copia project.config.example.json a project.config.json ` +
      'y completa el ID real del tablero (usa "npm run trello:boards") y el correo del Gestor.'
    );
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    throw new Error(`[Config] project.config.json no es un JSON válido: ${error.message}`);
  }

  const faltantes = CAMPOS_OBLIGATORIOS.filter((campo) => !String(config[campo] || '').trim());
  if (faltantes.length > 0) {
    throw new Error(`[Config] Faltan campos obligatorios en project.config.json: ${faltantes.join(', ')}`);
  }

  const deEjemplo = CAMPOS_OBLIGATORIOS.filter((campo) => VALORES_DE_EJEMPLO.has(config[campo]));
  if (deEjemplo.length > 0) {
    throw new Error(
      `[Config] project.config.json aún tiene valores de ejemplo en: ${deEjemplo.join(', ')}. Reemplázalos por los reales.`
    );
  }

  return config;
};

export default {
  loadProjectConfig,
};
