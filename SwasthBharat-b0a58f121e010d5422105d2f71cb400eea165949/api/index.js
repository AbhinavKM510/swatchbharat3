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
    // Answer in the API's own error shape rather than letting the platform return an
    // opaque 500 — the frontend switches on `error.code`.
    res.status(503).json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Could not reach the database. Check MONGO_URI and the Atlas IP allow-list.',
        ...(process.env.NODE_ENV === 'production' ? {} : { details: { reason: error.message } }),
      },
    });
    return;
  }

  return app(req, res);
}
