/**
 * Vercel serverless entry point for the whole Express API.
 *
 * ### Why this file exists at the project root, not inside backend/
 *
 * The API imports the risk engine and chatbot rules from `shared/`, which sits alongside
 * `backend/` rather than inside it (one implementation, used by the frontend too). Vercel
 * only deploys files under the project's Root Directory, so the root has to be the folder
 * that contains BOTH `backend/` and `shared/` — this one.
 *
 * ### Why the Express app is reused, not rewritten
 *
 * `createApp()` is the exact same application object that `backend/src/server.js` runs
 * locally, so routing, auth, validation and error handling behave identically whether the
 * API is running on a laptop or as a Vercel function. Only the *transport* differs: there
 * is no `server.listen()` here, because the platform owns the HTTP server and hands each
 * request straight to this handler.
 *
 * ### What is NOT available here, and why
 *
 * Socket.io is not initialised. A serverless function cannot hold a WebSocket open — it is
 * started per request and frozen afterwards. The emit helpers in `backend/src/realtime/io.js`
 * all no-op when Socket.io was never initialised, so route code that "pushes an alert" stays
 * unchanged and simply does nothing. The dashboard polls instead (see
 * `frontend/src/pages/DoctorDashboardPage.tsx`).
 */

import { createApp } from '../backend/src/app.js';
import { connectDatabase } from '../backend/src/db/connect.js';

/**
 * Built once per container, not per request.
 *
 * A warm function reuses module scope, so keeping these at module level means an already
 * warm instance answers without rebuilding the router tree or reopening the database.
 */
const app = createApp();

export default async function handler(req, res) {
  try {
    // Cached inside connectDatabase: concurrent requests share one connection attempt.
    await connectDatabase();
  } catch (error) {
    // Logged so the reason is visible in the platform's function logs even if the response
    // body is ever trimmed down again.
    console.error('[api] database connection failed:', error);

    /**
     * The reason is returned, not hidden.
     *
     * A connection failure here is a deployment misconfiguration — a missing MONGO_URI, an
     * Atlas IP allow-list that does not include the platform, a password that was not
     * URL-encoded — and every one of those is indistinguishable from the others behind a
     * generic message. Mongoose's message names the host and the failure mode but never the
     * credentials, so there is nothing secret in it.
     */
    res.status(503).json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Could not reach the database. Check MONGO_URI and the Atlas IP allow-list.',
        details: {
          reason: error?.message ?? String(error),
          /** Which mode was attempted, so "it used the wrong one" is immediately visible. */
          mongoUriConfigured: Boolean(process.env.MONGO_URI),
          useInMemoryDb: process.env.USE_IN_MEMORY_DB ?? '(unset)',
          nodeEnv: process.env.NODE_ENV ?? '(unset)',
        },
      },
    });
    return;
  }

  return app(req, res);
}
