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
 * In-flight connection promise, cached across invocations.
 *
 * Required for serverless (Vercel): a warm function container keeps module state between
 * requests, but several requests can arrive before the first connection resolves. Without
 * this, each one would call `mongoose.connect` again and exhaust the Atlas connection
 * limit. Stored on `globalThis` because a platform may load the module more than once.
 */
const CACHE_KEY = '__swasthbharat_mongoose__';
globalThis[CACHE_KEY] = globalThis[CACHE_KEY] || { promise: null };

/**
 * Opens the database connection.
 *
 * @returns {Promise<{uri: string, inMemory: boolean}>}
 */
export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return { uri: mongoose.connection.host, inMemory: Boolean(memoryServer) };
  }

  // A connection is already being established by an earlier request: wait for it rather
  // than opening a second one.
  if (globalThis[CACHE_KEY].promise) {
    return globalThis[CACHE_KEY].promise;
  }

  globalThis[CACHE_KEY].promise = openConnection().catch((error) => {
    // Clear the cache so the next request can retry rather than replaying the failure.
    globalThis[CACHE_KEY].promise = null;
    throw error;
  });

  return globalThis[CACHE_KEY].promise;
}

async function openConnection() {

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
    /**
     * Locally: fail fast instead of hanging for 30s when Atlas is unreachable — during a
     * live demo you want to know immediately that you should flip to the in-memory DB.
     *
     * On serverless: 8s is not enough. A cold function has to do DNS resolution for the
     * SRV record, a TLS handshake and replica-set discovery before the first query, and
     * that legitimately exceeds 8s on a cold start — which would surface as a "database
     * unreachable" error on a perfectly healthy cluster.
     */
    serverSelectionTimeoutMS: process.env.VERCEL ? 20000 : 8000,
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
