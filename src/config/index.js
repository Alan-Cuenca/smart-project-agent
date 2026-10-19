import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

/**
 * Loads project configuration from project.config.json or project.config.example.json as fallback.
 * @param {string} [customPath]
 * @returns {Object} Parsed project configuration
 */
export const loadProjectConfig = (customPath) => {
  const primaryPath = customPath || path.join(rootDir, 'project.config.json');
  const fallbackPath = path.join(rootDir, 'project.config.example.json');

  let configPath = primaryPath;

  if (!fs.existsSync(configPath)) {
    if (fs.existsSync(fallbackPath)) {
      console.warn(`[Config] ${configPath} not found. Falling back to ${fallbackPath}`);
      configPath = fallbackPath;
    } else {
      throw new Error(`[Config] Neither project.config.json nor project.config.example.json could be found.`);
    }
  }

  try {
    const rawData = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(rawData);
    return config;
  } catch (error) {
    console.error(`[Config] Error loading project configuration from ${configPath}:`, error.message);
    throw error;
  }
};

export default {
  loadProjectConfig,
};
