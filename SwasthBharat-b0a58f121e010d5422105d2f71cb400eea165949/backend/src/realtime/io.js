/**
 * Socket.io real-time layer.
 *
 * What it is for: when a field worker flags a high-risk patient, the PHC doctor's
 * dashboard has to show that case immediately, with no refresh. Polling would work but
 * would either be slow or wasteful, and the whole point of the demo moment is that the
 * card appears while everyone is watching.
 *
 * Rooms, not broadcasts. Every connection joins:
 *   phc:<phcId>        doctors and workers at one health centre
 *   district:<name>    district health officers
 *   user:<userId>      targeted messages (e.g. "your queued records synced")
 *
 * A broadcast to every socket would leak one PHC's patients to another PHC's doctor.
 * The room name is derived from the JWT, never from anything the client sends.
 */

import { Server } from 'socket.io';
import { config } from '../config/env.js';
import { verifyToken } from '../middleware/auth.js';

/** Event names, shared with the frontend. Keep in sync with frontend/src/lib/socket.ts. */
export const REALTIME_EVENTS = {
  /** A new screening was recorded (any risk band). */
  ASSESSMENT_CREATED: 'assessment:created',
  /** A high-risk screening was recorded. Drives the dashboard alert + sound. */
  HIGH_RISK_ALERT: 'assessment:high-risk',
  /** A doctor changed the review status of a case. */
  ASSESSMENT_REVIEWED: 'assessment:reviewed',
  /** A teleconsultation was requested (simulated call). */
  TELECONSULT_REQUESTED: 'teleconsult:requested',
  /** A batch of offline records finished syncing. */
  SYNC_COMPLETED: 'sync:completed',
  /** Sent to a client right after it connects, confirming which rooms it joined. */
  CONNECTED: 'connection:ready',
};

let io = null;

export function phcRoom(phcId) {
  return `phc:${String(phcId)}`;
}

export function districtRoom(district) {
  return `district:${String(district).toLowerCase()}`;
}

export function userRoom(userId) {
  return `user:${String(userId)}`;
}

/**
 * Attaches Socket.io to the HTTP server.
 *
 * @param {import('node:http').Server} httpServer
 */
export function initRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigins,
      credentials: true,
    },
    // Field devices drop off constantly. A shorter timeout means the dashboard's
    // "connected workers" count reflects reality within seconds, not minutes.
    pingTimeout: 20000,
    pingInterval: 10000,
  });

  // Authenticate during the handshake so an unauthenticated socket never joins a room.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      next(new Error('AUTH_REQUIRED'));
      return;
    }
    try {
      const payload = verifyToken(String(token));
      socket.data.user = {
        id: payload.sub,
        role: payload.role,
        phcId: payload.phcId,
        district: payload.district,
      };
      next();
    } catch {
      next(new Error('AUTH_INVALID'));
    }
  });

  io.on('connection', (socket) => {
    const { id, role, phcId, district } = socket.data.user;

    const rooms = [userRoom(id)];
    if (phcId) rooms.push(phcRoom(phcId));
    if (district) rooms.push(districtRoom(district));
    socket.join(rooms);

    socket.emit(REALTIME_EVENTS.CONNECTED, {
      userId: id,
      role,
      rooms,
      serverTime: new Date().toISOString(),
    });

    socket.on('disconnect', (reason) => {
      if (!config.isProduction) {
        console.log(`[socket] ${role} ${id} disconnected (${reason})`);
      }
    });
  });

  return io;
}

export function getIo() {
  return io;
}

/**
 * Emits to one PHC's room. Safe to call before Socket.io is initialised (during tests or
 * a script run) — it simply does nothing rather than throwing.
 */
export function emitToPhc(phcId, event, payload) {
  if (!io || !phcId) return;
  io.to(phcRoom(phcId)).emit(event, payload);
}

export function emitToDistrict(district, event, payload) {
  if (!io || !district) return;
  io.to(districtRoom(district)).emit(event, payload);
}

export function emitToUser(userId, event, payload) {
  if (!io || !userId) return;
  io.to(userRoom(userId)).emit(event, payload);
}

/** Live connection counts, surfaced on the dashboard as a "listening" indicator. */
export async function realtimeStats() {
  if (!io) return { enabled: false, connectedSockets: 0 };
  const sockets = await io.fetchSockets();
  const byRole = sockets.reduce((acc, socket) => {
    const role = socket.data?.user?.role || 'unknown';
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});
  return { enabled: true, connectedSockets: sockets.length, byRole };
}
