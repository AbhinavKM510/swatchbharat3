/**
 * Express application factory.
 *
 * Kept separate from server.js so the app can be constructed without opening a port —
 * useful for scripts and for the end-to-end demo check.
 */

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';

export function createApp() {
  const app = express();

  // Behind a single reverse proxy in deployment; needed for express-rate-limit to see
  // the real client IP rather than the proxy's.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The API serves JSON only, so CSP here would just be noise. The PWA is served
      // separately by the static host.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: curl, mobile webview, server-to-server. Allowed.
        if (!origin) return callback(null, true);
        if (config.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: true,
    }),
  );

  // Sync batches carry many records at once, so the default 100kb limit is too tight.
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));

  if (!config.isProduction) {
    app.use(morgan('dev'));
  } else {
    app.use(morgan('combined'));
  }

  app.get('/', (_req, res) => {
    res.json({
      name: 'SwasthBharat API',
      description: 'Early disease risk prediction and rural health access platform',
      docs: '/api/health',
      modelTransparency: '/api/model',
    });
  });

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
