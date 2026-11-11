# Despliegue gratuito (Supabase + Render + GitHub Actions)

```
GitHub Actions (L-V 08:00 y viernes 17:00, hora de Ecuador)
   └─ Trello + GitHub + Gemini → guarda acciones en Supabase → envía correo
                                                   │
Correo → botón Aprobar → Render (web) → lee Supabase → aplica en Trello
```

| Pieza | Para qué | Plan |
|---|---|---|
| **Supabase** | Base de datos de acciones pendientes (persistente) | Free |
| **Render** | Servidor web con HTTPS para los botones del correo | Free (se duerme tras 15 min; despierta en ~30 s al primer clic) |
| **GitHub Actions** | Ejecuta la auditoría diaria y el reporte semanal | Gratis en repositorios públicos |

> ⚠️ Nunca subas al repositorio `.env` ni `project.config.json`. Todos los secretos van en los paneles de GitHub y Render.

---

## 1. Supabase (base de datos)

1. Crea un proyecto **nuevo** en <https://supabase.com> (separado del de EVENTRA, para aislar datos).
2. Ve a **SQL Editor**, pega el contenido de [`supabase/acciones_pendientes.sql`](supabase/acciones_pendientes.sql) y ejecútalo.
3. En **Project Settings → API** copia:
   - `Project URL` → será `SUPABASE_URL`
   - `service_role` (secret) → será `SUPABASE_SERVICE_ROLE_KEY`

> La tabla tiene RLS activado y sin políticas: la clave pública `anon` no puede leer nada. La `service_role` **nunca** debe ir en un frontend ni en el repositorio.
>
> Supabase pausa proyectos gratuitos tras 7 días sin actividad; la auditoría diaria lo mantiene activo.

## 2. Render (servidor web)

1. En <https://render.com> → **New → Blueprint** → conecta el repositorio `smart-project-agent`. Render leerá [`render.yaml`](render.yaml).
2. Completa las variables marcadas como secretas:

| Variable | Valor |
|---|---|
| `APP_BASE_URL` | La URL que Render asigna, p. ej. `https://smart-project-agent.onrender.com` (sin `/` final) |
| `PROJECT_CONFIG_JSON` | El contenido de `project.config.json` en una sola línea (ver abajo) |
| `TRELLO_API_KEY`, `TRELLO_TOKEN` | Los mismos de tu `.env` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Del paso 1 |

   `ADMIN_TOKEN` se genera solo. `TRELLO_DRY_RUN` empieza en `true` (simulación): cámbialo a `false` cuando quieras que las aprobaciones modifiquen Trello.

3. Para obtener `PROJECT_CONFIG_JSON` en una línea:
   ```bash
   node -e "console.log(JSON.stringify(require('./project.config.json')))"
   ```
4. Comprueba: `https://TU-APP.onrender.com/health` debe responder `{"status":"ok",...}`.

> En producción el servidor **no arranca** si falta `ADMIN_TOKEN` (≥32 caracteres), si `APP_BASE_URL` no es `https://` o si falta Supabase. Si el deploy falla, revisa los logs de Render.

## 3. GitHub Actions (auditorías programadas)

En el repositorio → **Settings → Secrets and variables → Actions**:

**Secrets** (pestaña *Secrets*):

| Secret | Valor |
|---|---|
| `PROJECT_CONFIG_JSON` | Igual que en Render |
| `GEMINI_API_KEY` | Tu clave de Google AI Studio |
| `TRELLO_API_KEY`, `TRELLO_TOKEN` | Igual que en Render |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Igual que en Render |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Los de tu `.env` (para Gmail usa una *contraseña de aplicación*) |
| `GH_REPO_TOKEN` | *(Opcional)* Token de GitHub de solo lectura. El repo de EVENTRA es público, así que funciona sin él. |

**Variables** (pestaña *Variables*):

| Variable | Valor |
|---|---|
| `APP_BASE_URL` | La misma URL de Render (los botones del correo apuntan aquí) |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS` | *(Opcionales)* |

### Probar sin esperar al horario
**Actions → Auditoría programada → Run workflow** → elige `diaria` o `semanal`.

## 4. Verificación final

1. Ejecuta el workflow `diaria` manualmente.
2. Llega el correo → pulsa **Aprobar** en una propuesta → se abre Render (el primer clic puede tardar ~30 s) → **Confirmar**.
3. Con `TRELLO_DRY_RUN=true` verás "Aprobada (simulación)". Cambia a `false` en Render para operar de verdad.
4. Consultar acciones registradas:
   ```bash
   curl -H "x-admin-token: TU_ADMIN_TOKEN" https://TU-APP.onrender.com/api/pending-actions
   ```

## Seguridad aplicada

- Tokens de aprobación de 192 bits; en la base de datos solo se guarda su **hash SHA-256**.
- Los enlaces caducan a los **14 días** (`ACTION_TTL_DAYS`).
- El enlace del correo solo muestra una confirmación; el cambio requiere un POST (los escáneres de correo no pueden aprobar).
- `ADMIN_TOKEN` solo por header, comparación en tiempo constante.
- Cabeceras: `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, CSP restrictiva, HSTS, `nosniff`, sin `X-Powered-By`.
- Workflows con permisos mínimos (`contents: read`) y sin ejecuciones simultáneas.
- Validación determinista contra Trello antes de proponer cualquier cambio, y aprobación humana obligatoria.
