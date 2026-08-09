/**
 * Socket.io client.
 *
 * Only used by the read-side screens (the PHC dashboard and the district view). Writes
 * never go over the socket: an assessment must survive a dead connection, and a socket
 * emit gives no durable guarantee. HTTP + IndexedDB queue handles writes; the socket only
 * pushes notifications.
 *
 * Event names mirror `backend/src/realtime/io.js`.
 */

import { io, type Socket } from 'socket.io-client';
import { getToken } from '@/lib/api';

export const REALTIME_EVENTS = {
  ASSESSMENT_CREATED: 'assessment:created',
  HIGH_RISK_ALERT: 'assessment:high-risk',
  ASSESSMENT_REVIEWED: 'assessment:reviewed',
  TELECONSULT_REQUESTED: 'teleconsult:requested',
  SYNC_COMPLETED: 'sync:completed',
  CONNECTED: 'connection:ready',
} as const;

const SOCKET_URL = import.meta.env.VITE_API_BASE_URL ?? '';

let socket: Socket | null = null;

/**
 * Returns the shared socket, creating it on first use.
 *
 * Reconnection is left on with a capped backoff: a field device flickers in and out of
 * coverage constantly, and a dashboard that stays dead after one drop is useless.
 */
export function getSocket(): Socket {
  if (socket) return socket;

  socket = io(SOCKET_URL, {
    // The JWT is read lazily on each connection attempt so a token refresh or a re-login
    // is picked up without recreating the socket.
    auth: (callback) => callback({ token: getToken() }),
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 10000,
    autoConnect: false,
  });

  return socket;
}

export function connectSocket(): Socket {
  const instance = getSocket();
  if (!instance.connected) instance.connect();
  return instance;
}

/** Called on logout: the next user must not inherit the previous user's rooms. */
export function disconnectSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}
