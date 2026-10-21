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
- `GET /api/test-agent`: Dispara la auditoría manual del flujo multiagente y responde de inmediato al cliente mientras se procesa y despacha el correo al PM.
- `GET /webhook/decision`: Endpoint interactivo Human-in-the-Loop para registrar aprobaciones y rechazos emitidos por el Gestor desde los botones del correo.
- `POST /webhook/repo-update`: Endpoint receptor genérico de eventos de actualización de repositorios (commits, pushes, PRs).
