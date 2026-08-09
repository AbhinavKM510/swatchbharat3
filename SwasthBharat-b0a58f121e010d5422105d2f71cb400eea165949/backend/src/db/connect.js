/**
 * MongoDB connection.
 *
 * Two modes, because a hackathon demo cannot depend on venue wifi reaching Atlas:
 *
 *   1. MONGO_URI set            -> connect to MongoDB Atlas (the intended deployment)
 *   2. USE_IN_MEMORY_DB=true    -> spin up an in-process mongod via mongodb-memory-server
 *
 * Mode 2 is a devDependency loaded dynamically, so production installs
 * (`npm ci --omit=dev`) never pull it in.
 */

import mongoose from 'mongoose';
import { config } from '../config/env.js';

let memoryServer = null;

mongoose.set('strictQuery', true);

/**
 * Opens the database connection.
 *
 * @returns {Promise<{uri: string, inMemory: boolean}>}
 */
export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return { uri: mongoose.connection.host, inMemory: Boolean(memoryServer) };
  }

  let uri = config.mongoUri;
  const inMemory = config.useInMemoryDb;

  if (inMemory) {
    let MongoMemoryServer;
    try {
      ({ MongoMemoryServer } = await import('mongodb-memory-server'));
    } catch {
      throw new Error(
        'USE_IN_MEMORY_DB is on but "mongodb-memory-server" is not installed.\n' +
          'Run "npm install" inside backend/, or set MONGO_URI to a MongoDB Atlas connection string.',
      );
    }
    memoryServer = await MongoMemoryServer.create({ instance: { dbName: 'swasthbharat' } });
    uri = memoryServer.getUri('swasthbharat');
  }

  if (!uri) {
    throw new Error('No MongoDB connection string available. Set MONGO_URI in backend/.env.');
  }

  await mongoose.connect(uri, {
    // Fail fast instead of hanging for 30s when Atlas is unreachable — during a live
    // demo you want to know immediately that you should flip to the in-memory DB.
    serverSelectionTimeoutMS: 8000,
  });

  return { uri, inMemory };
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

export function databaseStatus() {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return {
    state: states[mongoose.connection.readyState] ?? 'unknown',
    inMemory: Boolean(memoryServer),
    name: mongoose.connection.name || null,
  };
}
