/**
 * Environment configuration, resolved and validated once at import time.
 *
 * Fails loudly rather than starting up half-configured: a demo that boots and then
 * silently signs tokens with a default secret is worse than one that refuses to boot.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(HERE, '..', '..');
export const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

const DEFAULT_JWT_SECRET = 'replace-me-with-a-long-random-string';

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const config = {
  nodeEnv,
  isProduction,
  port: int(process.env.PORT, 4000),

  mongoUri: process.env.MONGO_URI || '',
  useInMemoryDb: bool(process.env.USE_IN_MEMORY_DB, false),

  jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),
  setupToken: process.env.SETUP_TOKEN || '',

  corsOrigins,
  seedPassword: process.env.SEED_PASSWORD || 'demo1234',

  /**
   * Firebase project id. Optional — see config/firebase.js. When unset, the phone-OTP
   * exchange endpoint reports 501 and password login is unaffected.
   */
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || '',

  /**
   * Whether a Firebase phone-OTP login is allowed to CREATE an account.
   *
   * Default false, and that default matters. Firebase proves control of a phone number;
   * it says nothing about whether that person is a health worker, which PHC they belong
   * to, or what they may read. Auto-provisioning would let anyone with a working SIM
   * create an account in this system.
   *
   * With it off, phone OTP can only sign in to an account an administrator already
   * created (via the seed or the SETUP_TOKEN-gated register endpoint). That keeps the
   * "who is allowed in" decision with a human.
   */
  firebaseAllowSignUp: bool(process.env.FIREBASE_ALLOW_SIGNUP, false),

  /**
   * Background push notifications (Firebase Cloud Messaging).
   *
   * Separate from FIREBASE_PROJECT_ID because the two features are independent: a project
   * may be set up for phone sign-in with no Web Push credentials, or the reverse. Both must
   * be true for a push to be attempted.
   */
  pushEnabled: bool(process.env.PUSH_NOTIFICATIONS_ENABLED, false),
  /**
   * Per-user device cap. A doctor legitimately uses a couple of browsers; beyond that the
   * list is stale tokens, and every one of them costs a wasted send.
   */
  pushMaxTokensPerUser: int(process.env.PUSH_MAX_TOKENS_PER_USER, 5),
  /**
   * How long FCM should keep trying, in seconds. Four hours: a high-risk case is still worth
   * knowing about when the doctor's phone comes back online, but not the next morning, by
   * which point the dashboard is the right place to find it.
   */
  pushTtlSeconds: int(process.env.PUSH_TTL_SECONDS, 4 * 60 * 60),

  /**
   * LLM fallback for the chatbot (Gemini), OPTIONAL and off by default.
   *
   * The rule-based FAQ in shared/chatbot/ is the chatbot. This never replaces it — it only
   * answers the question the rules could not match, and only when the device is online.
   * See backend/src/services/geminiChat.js for the actual call and its safety constraints.
   *
   * Demo-scale only, deliberately: no budget cap, no per-IP limit, no response cache. Fine
   * for a free-tier key exercised by a handful of people at a pitch. A free-tier quota just
   * returns 429 when exhausted, which the caller here treats as "answer normally" — see
   * geminiChat.js. Do not leave this on unattended in a real deployment.
   */
  geminiEnabled: bool(process.env.GEMINI_ENABLED, false),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  /**
   * Model choice, and why this specific one.
   *
   * A '-latest' alias rather than a pinned version like 'gemini-2.5-flash': pinned names get
   * retired from new-user access and then return 404 NOT_FOUND for freshly created API keys,
   * which is a baffling first failure to hit during a demo. The alias is Google's own
   * indirection for exactly that.
   *
   * '-lite' rather than plain flash because this runs on the FREE tier, where the lite models
   * carry substantially the largest daily request allowance. Tested against this project's
   * key: flash-latest, 2.0-flash and 2.0-flash-lite were all already exhausted (429) while
   * flash-lite-latest still had headroom. For rephrasing a few curated FAQ answers, the
   * quality difference does not matter; running out of quota mid-pitch does.
   *
   * Override with GEMINI_MODEL if a specific version is needed.
   */
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
};

/** Collected at import, surfaced by the caller so the messages appear in one block. */
export const configWarnings = [];

if (config.jwtSecret === DEFAULT_JWT_SECRET) {
  if (isProduction) {
    throw new Error(
      'JWT_SECRET is still the placeholder value. Set a real secret before running in production.',
    );
  }
  configWarnings.push(
    'JWT_SECRET is the placeholder from .env.example. Fine for local development, never for a real deployment.',
  );
}

if (!config.setupToken) {
  configWarnings.push(
    'SETUP_TOKEN is not set, so /api/auth/register can only create field-worker (asha) accounts. ' +
      'Use "npm run seed" to create the demo doctor and district-officer logins.',
  );
}

if (!config.mongoUri && !config.useInMemoryDb) {
  configWarnings.push(
    'Neither MONGO_URI nor USE_IN_MEMORY_DB is set. Falling back to an in-process MongoDB ' +
      '(first run downloads a mongod binary). Set MONGO_URI to use Atlas instead.',
  );
  config.useInMemoryDb = true;
}

if (isProduction && config.useInMemoryDb) {
  throw new Error('USE_IN_MEMORY_DB must not be enabled in production: all data is lost on restart.');
}

if (config.firebaseProjectId && process.env.FIREBASE_AUTH_EMULATOR_HOST && isProduction) {
  throw new Error(
    'FIREBASE_AUTH_EMULATOR_HOST is set in production. The emulator accepts unsigned tokens, ' +
      'so anyone could mint a valid login. Unset it.',
  );
}

if (config.firebaseAllowSignUp) {
  configWarnings.push(
    'FIREBASE_ALLOW_SIGNUP is enabled: anyone who can receive an SMS on a valid Indian mobile ' +
      'number can create a field-worker account. Intended for demos only.',
  );
}

if (config.geminiEnabled && !config.geminiApiKey) {
  configWarnings.push(
    'GEMINI_ENABLED is true but GEMINI_API_KEY is not set. The chatbot will fall back to the ' +
      'rule engine exactly as if Gemini were disabled.',
  );
}
if (config.geminiEnabled) {
  configWarnings.push(
    'GEMINI_ENABLED is on: unmatched chatbot questions are sent to Gemini. Demo-scale only — ' +
      'no budget cap or per-caller limit. Fine for a free-tier key at a pitch; turn it off ' +
      'afterwards.',
  );
}
