# Smart Project Agent

Agente Inteligente de Seguimiento y Auditoría de Proyectos completamente genérico y agnóstico de plataforma.

## 📌 Arquitectura del Sistema

El sistema está diseñado para auditar cualquier proyecto de software mediante archivos de configuración desacoplados (`project.config.json`), recibiendo eventos en tiempo real mediante webhooks y procesándolos con agentes impulsados por IA (LangChain / Google Gemini) para alertar al Project Manager según métricas, avances o anomalías.

```
smart-project-agent/
├── src/
│   ├── agents/          # Agentes inteligentes (LangChain / Google Gemini)
│   ├── config/          # Cargador agnóstico de configuración de proyectos
│   ├── integrations/    # Integraciones externas (GitHub, Trello, etc.)
│   ├── notifications/   # Módulos de alerta (Nodemailer, etc.)
│   │   └── mailer.js
│   ├── workflows/       # Flujos de auditoría y automatización
│   └── app.js           # Servidor Express y endpoints de webhook
├── .env.example         # Plantilla de variables de entorno
├── project.config.example.json # Plantilla de configuración genérica del proyecto
├── package.json
└── README.md
```

## ☁️ Producción (gratis)

Para que funcione sin tu PC encendida: **Supabase** (datos) + **Render** (botones del correo) + **GitHub Actions** (auditorías programadas). Guía paso a paso en [DEPLOY.md](DEPLOY.md).

## 🚀 Inicio Rápido

### 1. Instalación de dependencias
```bash
npm install
```

### 2. Configuración de variables de entorno
Copia el archivo `.env.example` a `.env` y completa las credenciales:
```bash
cp .env.example .env
```

Variables disponibles:
- `GEMINI_API_KEY`: API Key para los modelos de Google Gemini (capa gratuita de Google AI Studio).
- `TRELLO_API_KEY` & `TRELLO_TOKEN`: Credenciales para auditar tableros en Trello.
- `GITHUB_TOKEN`: Token para consultar repositorios y pull requests.
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`: Configuración de servidor de correo para alertas dinámicas.

### 3. Configuración del Proyecto Auditado
Copia `project.config.example.json` a `project.config.json` y personaliza los datos:
```json
{
  "projectName": "Mi Proyecto",
  "repositoryUrl": "https://github.com/org/repo",
  "trelloBoardId": "65b1234567890abcdef12345",
  "projectManagerEmail": "pm@empresa.com"
}
```

### 4. Ejecución del Servidor
Modo desarrollo (con recarga automática):
```bash
npm run dev
```

Modo producción:
```bash
npm start
```

### 5. Prueba Manual del Agente (CLI)
Para ejecutar la auditoría de forma manual e inmediata desde la consola sin esperar el cronjob:
```bash
npm run test:agent
```

## 📡 Endpoints Disponibles

- `GET /health`: Verificación del estado del servicio y métricas activas.
- `GET /api/test-agent` *(requiere `x-admin-token` si `ADMIN_TOKEN` está definido)*: Dispara la auditoría manual del flujo multiagente.
- `GET /api/pending-actions?status=PENDING` *(admin)*: Lista las acciones registradas (sin tokens).
- `GET /webhook/decision?actionId&token&decision`: Página de confirmación que se abre desde los botones del correo. **No modifica nada.**
- `POST /webhook/decision`: Registra la decisión del Gestor y, si aprueba, aplica el cambio en Trello.
- `POST /webhook/repo-update`: Endpoint receptor genérico de eventos de actualización de repositorios (commits, pushes, PRs).

## 🧭 Cómo analiza el proyecto

1. **Trello:** cada lista del tablero es una **fase** secuencial; una tarea está terminada cuando su fecha está marcada como completada.
2. **GitHub:** commits de los últimos 14 días (por tipo `feat`/`fix`/`docs`… y por persona) y el resultado del último CI.
3. **Métricas deterministas** (`src/analysis/metricas.js`, sin IA): avance por fase, días para la entrega, tareas vencidas o que vencen en 48 h, tareas fuera de plazo, tareas sin responsable, revisores con tareas asignadas, CI fallido, funcionalidades nuevas durante fases de pruebas/despliegue, repositorio inactivo y concentración de commits.
4. **Agentes (Gemini):** Ejecutor → Revisor → Aprobador interpretan esas métricas y proponen acciones: **asignar responsables** (según rol y carga), **reprogramar** (nunca después de la entrega) o **comentar en la tarjeta**.
5. **Validación en código** y aprobación del Gestor por correo (ver abajo).

### Configuración del equipo (`project.config.json`)

| Campo | Uso |
|---|---|
| `deadline` | Fecha de entrega final (`YYYY-MM-DD`). Ninguna reprogramación puede superarla. |
| `timezone` | Zona horaria de las tareas programadas (por defecto `America/Guayaquil`). |
| `repository` | `{ owner, name, branch }` del repositorio en GitHub. |
| `team[]` | `name`, `trelloUsername`, `gitEmails`, `role` y `assignable`. Con `assignable: false` (p. ej. un revisor) el agente nunca le asigna tareas. |

### Tareas programadas

| Tarea | Cuándo | Qué hace |
|---|---|---|
| Auditoría diaria | L-V 08:00 (`CRON_AUDITORIA_DIARIA`) | Ejecuta los agentes. Envía correo solo si hay acciones que aprobar o alertas ALTA/CRÍTICA. |
| Reporte semanal | Viernes 17:00 (`CRON_REPORTE_SEMANAL`) | Resumen de avance por fase, alertas y equipo. No consume cuota de Gemini. |

Usa `off` en la variable para desactivar una tarea.

## 🔒 Flujo de aprobación (Human-in-the-Loop)

1. Los agentes proponen cambios → **validación en código** contra el snapshot real de Trello (tarjeta, lista y miembros existentes; fecha futura; al menos un cambio real). Lo que no pasa se descarta y se registra en consola.
2. Cada acción válida se guarda en `data/acciones.json` con un **ID único (UUID) y un token secreto**. Sobrevive a reinicios del servidor.
3. El correo incluye enlaces con ese token. Abrirlos solo muestra una confirmación (los escáneres de enlaces del correo no pueden aprobar nada).
4. Al confirmar, el cambio se aplica en Trello. Si Trello falla, la acción queda en `FAILED` y puede reintentarse desde el mismo enlace.
5. Todo queda en `historial.log`.

> Los botones solo funcionan si el servidor está encendido y `APP_BASE_URL` es una URL accesible desde donde se abre el correo (por ejemplo, un despliegue en Render/Railway o un túnel con ngrok).

Para probar sin modificar Trello: `TRELLO_DRY_RUN=true`.

## 🧪 Tests

```bash
npm test               # tests unitarios y del flujo de aprobación (no llaman a Trello ni a Gemini)
npm run trello:boards  # lista tus tableros para obtener el trelloBoardId
```
