import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const GITHUB_API = 'https://api.github.com';
const MAX_PAGINAS = 5; // hasta 500 commits por consulta

/**
 * Extrae el tipo de Conventional Commit ("feat", "fix", "docs"...) del mensaje.
 * @param {string} mensaje
 * @returns {string} tipo en minúsculas u "otro"
 */
export const tipoDeCommit = (mensaje = '') => {
  const match = /^(\w+)(\([^)]*\))?!?:/.exec(mensaje.trim());
  return match ? match[1].toLowerCase() : 'otro';
};

const crearCliente = () =>
  axios.create({
    baseURL: GITHUB_API,
    timeout: 15000,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });

/**
 * Obtiene la actividad del repositorio: commits desde una fecha y el último run de CI.
 * Nunca lanza: si GitHub falla, retorna { disponible: false, error } para que la auditoría continúe.
 *
 * @param {{ owner: string, name: string, branch?: string }} repository
 * @param {{ desde: Date }} opciones
 * @returns {Promise<Object>}
 */
export async function obtenerActividadRepositorio(repository, { desde }) {
  if (!repository?.owner || !repository?.name) {
    return { disponible: false, error: 'Repositorio no configurado en project.config.json.' };
  }

  const cliente = crearCliente();
  const ruta = `/repos/${repository.owner}/${repository.name}`;
  const branch = repository.branch || 'main';

  try {
    const commits = [];
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const { data } = await cliente.get(`${ruta}/commits`, {
        params: { sha: branch, since: desde.toISOString(), per_page: 100, page: pagina },
      });
      commits.push(...data);
      if (data.length < 100) break;
    }

    let ci = null;
    try {
      const { data } = await cliente.get(`${ruta}/actions/runs`, { params: { branch, per_page: 1 } });
      const run = data.workflow_runs?.[0];
      if (run) {
        ci = {
          nombre: run.name,
          estado: run.status,
          resultado: run.conclusion,
          fecha: run.created_at,
          url: run.html_url,
          commit: run.head_commit?.message?.split('\n')[0] || null,
        };
      }
    } catch (error) {
      console.warn('[GitHub] No se pudo consultar el estado del CI:', error.message);
    }

    return {
      disponible: true,
      repositorio: `${repository.owner}/${repository.name}`,
      branch,
      desde: desde.toISOString(),
      commits: commits.map((c) => {
        const mensaje = c.commit?.message?.split('\n')[0] || '';
        return {
          sha: c.sha?.slice(0, 7),
          mensaje,
          tipo: tipoDeCommit(mensaje),
          autor: c.commit?.author?.name || 'desconocido',
          email: (c.commit?.author?.email || '').toLowerCase(),
          fecha: c.commit?.author?.date,
        };
      }),
      ci,
    };
  } catch (error) {
    const estado = error.response?.status;
    const detalle = error.response?.data?.message || error.message;
    console.warn(`[GitHub] No se pudo obtener la actividad del repositorio (${estado || 'red'}): ${detalle}`);
    return { disponible: false, error: `GitHub ${estado || ''} ${detalle}`.trim() };
  }
}

export default { obtenerActividadRepositorio, tipoDeCommit };
