/**
 * Account provisioning for real (non-seed) logins.
 *
 *   node scripts/manage-users.mjs list
 *   node scripts/manage-users.mjs create --name "Nilesh Paul" --phone 9876543210 --role doctor --phc NAD-PHC-01
 *   node scripts/manage-users.mjs password --phone 9876543210
 *   node scripts/manage-users.mjs deactivate --phone 9876543210
 *
 * ### Why a script and not a signup screen
 *
 * There is deliberately no self-service registration UI in this app. `role` decides how much
 * patient data an account can read — `asha` sees only its own submissions, `doctor` sees every
 * patient at a PHC, `officer` sees a whole district — so letting a visitor pick their own role
 * would hand away exactly the isolation that check-security.mjs exists to prove. Provisioning
 * is an administrative act performed by whoever controls the server, which is also how real
 * deployments work: an ASHA worker does not sign herself up, her district office enrols her.
 *
 * ### Why `create` goes through the HTTP API instead of writing to Mongo
 *
 * `POST /api/auth/register` already does phone normalisation, the 8-character password floor,
 * the role whitelist, the PHC lookup, the duplicate-number conflict, and the SETUP_TOKEN gate
 * for privileged roles. Re-implementing any of that here would mean two sets of rules that
 * drift apart, and the copy in a convenience script is the one that would rot. So this asks
 * the server, and the server stays the single authority on what a valid account is.
 *
 * `password` and `deactivate` DO go straight to Mongo, because no endpoint exposes them. That
 * is intentional on the API's part: a password-change route needs its own threat model
 * (current-password proof, session invalidation, rate limiting) and inventing a half version
 * of it to save a terminal command would be a poor trade.
 *
 * ### Passwords are never taken as arguments unless you insist
 *
 * By default this prompts, with echo off. A password passed as `--password` lands in your
 * PowerShell history file and in the process list, so that flag warns and exists only for
 * scripted setup.
 */

import mongoose from 'mongoose';
import { config } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/connect.js';
import { Phc } from '../src/models/Phc.js';
import { USER_ROLES, User } from '../src/models/User.js';

const BASE = process.env.CHECK_BASE_URL || `http://localhost:${config.port}`;

/**
 * Mirrors MIN_PASSWORD_LENGTH in auth.routes.js.
 *
 * Duplicated rather than imported because importing the router would pull in express, the
 * rate limiter and the Firebase admin SDK just to read one integer. It is checked here only
 * to fail fast with a clear message before a network round trip; the server's copy remains
 * the one that actually enforces it, including for the `password` command below.
 */
const MIN_PASSWORD_LENGTH = 8;

/**
 * ASCII only, including the dashes. This text is printed to a Windows console whose default
 * codepage turns an em dash into mojibake, and a provisioning tool that looks broken invites
 * doubt about whether it did the right thing.
 */
const ROLE_BLURB = {
  asha: 'field worker - sees only the screenings they submit',
  doctor: 'PHC doctor - sees every patient at their PHC',
  officer: 'district officer - sees aggregates for the whole district',
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

/** Same reduction to 10 national digits the login and register routes use. */
function normalisePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function isValidPhone(phone) {
  return /^[6-9]\d{9}$/.test(phone);
}

/**
 * Reads a line from the terminal without echoing it.
 *
 * Iterates the characters of each chunk rather than treating a chunk as one keypress: in raw
 * mode a paste arrives as a single multi-character chunk, and a pasted password ending in a
 * newline would otherwise be stored with the newline embedded and then silently fail to match
 * at login.
 */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(
        new Error(
          'No interactive terminal available for a hidden prompt.\n' +
            'Pass --password explicitly if you are running this from a script.',
        ),
      );
      return;
    }

    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          // Ctrl+C
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        // Ignore other control characters (arrow keys arrive as escape sequences).
        if (char < ' ') continue;
        value += char;
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * Obtains a password, either from the flag or by prompting twice.
 *
 * Confirms by re-entry because the input is invisible and a typo in a provisioning step
 * surfaces later as an unexplainable "wrong password" on a machine you no longer have.
 */
async function resolvePassword(args) {
  if (typeof args.password === 'string') {
    console.warn(
      '  ! --password was passed on the command line, so it is now in your shell history.\n' +
        '    Clear it, or prefer the interactive prompt next time.',
    );
    return args.password;
  }

  const first = await promptHidden('  Password (min 8 chars, not shown): ');
  if (first.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const second = await promptHidden('  Confirm password:                 ');
  if (first !== second) throw new Error('The two passwords did not match.');
  return first;
}

async function withDatabase(run) {
  const { inMemory } = await connectDatabase();
  if (inMemory) {
    console.warn(
      '  ! Connected to an IN-MEMORY database, so this change disappears when the process exits.\n' +
        '    Set USE_IN_MEMORY_DB=false and MONGO_URI in backend/.env to affect the real database.',
    );
  }
  try {
    return await run();
  } finally {
    await disconnectDatabase();
  }
}

async function commandList() {
  await withDatabase(async () => {
    // passwordHash is select:false; requested only to report WHETHER one exists. The hash
    // itself is never printed.
    const users = await User.find({})
      .select('+passwordHash')
      .populate('phc')
      .sort({ role: 1, phone: 1 });

    if (users.length === 0) {
      console.log('\nNo accounts yet. Run "npm run seed" for the demo logins.');
      return;
    }

    console.log(`\n${users.length} account(s) in "${mongoose.connection.name}":\n`);
    console.log('  phone       role     password  otp  active  name / PHC');
    console.log('  ' + '-'.repeat(72));
    for (const user of users) {
      const row = [
        user.phone.padEnd(11),
        user.role.padEnd(8),
        (user.hasPassword() ? 'yes' : 'no').padEnd(9),
        (user.firebaseUid ? 'yes' : 'no').padEnd(4),
        (user.isActive ? 'yes' : 'NO').padEnd(7),
        // ASCII separator on purpose: the Windows console codepage renders a middle dot
        // as mojibake, and this table is meant to be readable in the terminal it ships with.
        `${user.name}${user.phc ? ` - ${user.phc.name}` : ''}`,
      ].join(' ');
      console.log(`  ${row}`);
    }
    console.log(
      '\n  "password" = can log in with a password.  "otp" = linked to a Firebase phone sign-in.',
    );
  });
}

async function commandCreate(args) {
  const phone = normalisePhone(args.phone);
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const role = typeof args.role === 'string' ? args.role : 'asha';
  const phcCode = typeof args.phc === 'string' ? args.phc.toUpperCase().trim() : '';
  const language = typeof args.language === 'string' ? args.language : 'hi';

  if (!name) throw new Error('--name is required.');
  if (!isValidPhone(phone)) {
    throw new Error(
      `--phone must be a 10-digit Indian mobile number starting 6-9 (got "${args.phone ?? ''}").`,
    );
  }
  if (!USER_ROLES.includes(role)) {
    throw new Error(`--role must be one of: ${USER_ROLES.join(', ')}`);
  }
  if (!phcCode) {
    throw new Error(
      'A PHC is required so records file correctly. Pass --phc, e.g. --phc NAD-PHC-01.\n' +
        'Run "node scripts/manage-users.mjs list" after seeding to see which PHCs exist.',
    );
  }
  if (role !== 'asha' && !config.setupToken) {
    throw new Error(
      `Creating a "${role}" account requires SETUP_TOKEN to be set in backend/.env.\n` +
        'That gate exists because this role can read patient data beyond its own submissions.',
    );
  }

  console.log(`\nCreating a ${role} account (${ROLE_BLURB[role]})`);
  console.log(`  name  : ${name}`);
  console.log(`  phone : ${phone}`);
  console.log(`  PHC   : ${phcCode}`);
  const password = await resolvePassword(args);

  const villages =
    typeof args.villages === 'string'
      ? args.villages.split(',').map((v) => v.trim()).filter(Boolean)
      : [];

  let response;
  try {
    response = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Only sent when needed. An asha registration must not depend on the token existing.
        ...(role !== 'asha' ? { 'x-setup-token': config.setupToken } : {}),
      },
      body: JSON.stringify({ name, phone, password, role, language, phcCode, villages }),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the API at ${BASE}.\n` +
        'Start it with "npm start" in backend/ and try again.\n' +
        `(${error.message})`,
    );
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const code = payload?.error?.code || `HTTP_${response.status}`;
    const message = payload?.error?.message || 'Registration failed.';
    if (code === 'PHONE_IN_USE') {
      throw new Error(
        `${message}\nTo change that account's password instead, run:\n` +
          `  node scripts/manage-users.mjs password --phone ${phone}`,
      );
    }
    throw new Error(`${code}: ${message}`);
  }

  const user = payload.user;
  console.log(`\n  Created. ${user.name} - ${user.role} at ${user.phc?.name ?? 'no PHC'}`);
  console.log(`  Log in at the web app with ${user.phone} and the password you just set.`);
}

async function commandPassword(args) {
  const phone = normalisePhone(args.phone);
  if (!isValidPhone(phone)) {
    throw new Error(`--phone must be a 10-digit Indian mobile number (got "${args.phone ?? ''}").`);
  }

  await withDatabase(async () => {
    const user = await User.findOne({ phone }).populate('phc');
    if (!user) {
      throw new Error(
        `No account with phone ${phone}.\n` +
          'Run "node scripts/manage-users.mjs list" to see which accounts exist.',
      );
    }

    console.log(`\nSetting a new password for ${user.name} (${user.role})`);
    const password = await resolvePassword(args);
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    // updateOne rather than doc.save(): passwordHash is select:false, and assigning a
    // deselected path then saving is the kind of thing that works until a Mongoose upgrade
    // decides otherwise. A targeted $set has no such ambiguity.
    await User.updateOne(
      { _id: user._id },
      { $set: { passwordHash: await User.hashPassword(password) } },
    );

    console.log(`  Password updated for ${phone}.`);
    console.log('  Existing JWTs stay valid until they expire. Restart the API to cut them off now.');
  });
}

async function commandDeactivate(args) {
  const phone = normalisePhone(args.phone);
  if (!isValidPhone(phone)) {
    throw new Error(`--phone must be a 10-digit Indian mobile number (got "${args.phone ?? ''}").`);
  }
  const activate = Boolean(args.activate);

  await withDatabase(async () => {
    const result = await User.findOneAndUpdate(
      { phone },
      { $set: { isActive: activate } },
      { new: true },
    );
    if (!result) throw new Error(`No account with phone ${phone}.`);
    console.log(
      `\n  ${result.name} (${phone}) is now ${result.isActive ? 'ACTIVE' : 'DISABLED'}.` +
        (result.isActive ? '' : '\n  Login returns 403 ACCOUNT_DISABLED for this number.'),
    );
  });
}

function usage() {
  console.log(`
Account provisioning for SwasthBharat.

  list
      Show every account, its role, PHC, and whether it has a password / OTP link.

  create --name "<full name>" --phone <10 digits> --role <asha|doctor|officer>
         --phc <PHC code> [--language bn|hi|en] [--villages "A,B"]
      Create an account through the API. Prompts for the password.
      doctor and officer additionally require SETUP_TOKEN in backend/.env.
      Requires the API to be running.

  password --phone <10 digits>
      Set a new password for an existing account. Talks to MongoDB directly,
      so the API does not need to be running.

  deactivate --phone <10 digits> [--activate]
      Disable an account, or re-enable it with --activate.

Roles:
  asha     ${ROLE_BLURB.asha}
  doctor   ${ROLE_BLURB.doctor}
  officer  ${ROLE_BLURB.officer}

To change the six demo accounts' shared password instead, set SEED_PASSWORD in
backend/.env and re-run "npm run seed".
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  switch (command) {
    case 'list':
      await commandList();
      break;
    case 'create':
      await commandCreate(args);
      break;
    case 'password':
      await commandPassword(args);
      break;
    case 'deactivate':
      await commandDeactivate(args);
      break;
    default:
      usage();
      if (command) {
        console.error(`Unknown command: "${command}"`);
        process.exitCode = 1;
      }
  }
}

main().catch((error) => {
  console.error(`\n  ${error.message}\n`);
  process.exitCode = 1;
});
