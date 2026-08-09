import { randomUUID } from 'node:crypto';

/**
 * Server-side UUID, used only as a fallback when a client did not supply a `clientId`
 * (for example a curl request, or the seed script). Real app traffic always brings its
 * own id, generated on the device before the record could possibly be sent.
 */
export function newClientId(prefix = 'srv') {
  return `${prefix}_${randomUUID()}`;
}

/** Loose UUID/clientId sanity check — rejects empty strings and absurd lengths. */
export function isValidClientId(value) {
  return typeof value === 'string' && value.trim().length >= 8 && value.trim().length <= 128;
}

/** Fake teleconsult session id. Deliberately prefixed so it is never mistaken for real. */
export function newSimulatedSessionId() {
  return `sim-${randomUUID()}`;
}
