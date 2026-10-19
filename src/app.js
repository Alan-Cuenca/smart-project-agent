import express from 'express';
import dotenv from 'dotenv';
import { loadProjectConfig } from './config/index.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Generic Webhook Endpoint for Repository Updates
 * Receives webhook payloads from GitHub, GitLab, or any generic VCS/CI-CD pipeline.
 */
app.post('/webhook/repo-update', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[Webhook] Repository update received:');

    // Attempt to load current project configuration
    let projectConfig = null;
    try {
      projectConfig = loadProjectConfig();
    } catch (configErr) {
      console.warn('[Webhook] Could not load active project configuration:', configErr.message);
    }

    // Extract generic repository update information
    const repository = payload?.repository?.name || payload?.repository || projectConfig?.projectName || 'Unknown Repository';
    const ref = payload?.ref || payload?.branch || 'Unknown Branch/Ref';
    const commitsCount = Array.isArray(payload?.commits) ? payload.commits.length : 0;
    const sender = payload?.sender?.login || payload?.pusher?.name || payload?.author || 'Unknown Sender';

    console.log(`[Webhook] Project: ${repository} | Ref: ${ref} | Commits: ${commitsCount} | Sender: ${sender}`);

    // Return generic acknowledgment
    return res.status(200).json({
      status: 'success',
      message: 'Repository update received and queued for audit processing',
      timestamp: new Date().toISOString(),
      details: {
        repository,
        ref,
        commitsCount,
        sender,
        configuredProject: projectConfig?.projectName || null,
      },
    });
  } catch (error) {
    console.error('[Webhook] Error processing repository update:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while processing repository update',
      error: error.message,
    });
  }
});

// Start server only when executed directly
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[Server] Smart Project Agent running on port ${PORT}`);
    console.log(`[Server] Webhook endpoint available at POST http://localhost:${PORT}/webhook/repo-update`);
  });
}

export default app;
