/**
 * Server entry point: connect to MongoDB, start HTTP, attach Socket.io.
 *
 * The database is connected BEFORE the port opens. A server that accepts requests it
 * cannot serve produces confusing 500s during a demo; failing to start is clearer.
 */

import http from 'node:http';
import { config, configWarnings } from './config/env.js';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './db/connect.js';
import { initRealtime } from './realtime/io.js';

async function main() {
  if (configWarnings.length > 0) {
    console.warn('\nConfiguration notes:');
    for (const warning of configWarnings) console.warn(`  ! ${warning}`);
    console.warn('');
  }

  console.log('Connecting to MongoDB...');
  const { inMemory } = await connectDatabase();
  console.log(
    inMemory
      ? 'Connected to an in-process MongoDB (data is discarded on shutdown).'
      : 'Connected to MongoDB.',
  );

  /**
   * In-memory mode starts empty every time, and `npm run seed` cannot help because that
   * script's database dies with the script. So seed in-process. Guarded on an empty user
   * collection, so a real Atlas database is never touched.
   */
  if (inMemory) {
    const { User } = await import('./models/User.js');
    if ((await User.countDocuments({})) === 0) {
      console.log('Empty in-memory database, seeding demo data...');
      const { runSeed } = await import('./seed.js');
      await runSeed();
    }
  }

  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);

  await new Promise((resolve) => server.listen(config.port, resolve));

  console.log(`\nSwasthBharat API listening on http://localhost:${config.port}`);
  console.log(`  health           GET  /api/health`);
  console.log(`  model card       GET  /api/model`);
  console.log(`  allowed origins  ${config.corsOrigins.join(', ')}`);
  console.log(`  realtime         Socket.io attached (JWT required on handshake)`);

  // Stated at startup because "the OTP button does nothing" is otherwise a slow diagnosis,
  // and because an emulator in use is something you want to notice, not discover.
  const { firebaseStatus } = await import('./config/firebase.js');
  const firebase = firebaseStatus();
  console.log(
    firebase.configured
      ? `  phone sign-in    POST /api/auth/firebase (project ${firebase.projectId}` +
          `${firebase.emulator ? ', AUTH EMULATOR' : ''})`
      : '  phone sign-in    not configured, password login only (see backend/.env.example)',
  );
  console.log('');

  const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down...`);
    server.close();
    try {
      await disconnectDatabase();
    } catch (error) {
      console.error('Error closing the database connection:', error.message);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('\nFailed to start the server:\n');
  console.error(error.message);
  if (!config.isProduction && error.stack) console.error(`\n${error.stack}`);
  process.exit(1);
});
