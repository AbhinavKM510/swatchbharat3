/**
 * The two things a technical judge actually tries. Runs in a few seconds.
 *
 *   npm run dev         # in one terminal
 *   npm run check:sec   # in another
 *
 * 1. Role isolation  — a doctor at one PHC cannot read another PHC's patient record.
 * 2. Phone sign-in   — an unverified Firebase ID token can never produce a session, and
 *                      adding that route did not break password login.
 * 3. Push devices    — a device can only register itself, a field worker cannot register at
 *                      all, and no endpoint accepts a PHC or a topic to target.
 * 4. Sign-up         — public registration can create a field worker and nothing more. A
 *                      doctor or district-officer account needs the server's SETUP_TOKEN, so
 *                      a stranger cannot register their way into a PHC's patient records.
 * 5. Rate limiting   — hammering the login endpoint returns a clean 429 with a stable
 *                      error code, not a 500 and not a hang.
 *
 * ### Why the order matters
 *
 * The credential limiter in auth.routes.js is 30 requests per 10 minutes, keyed by IP,
 * and it counts EVERY request — successful logins included. So the rate-limit test is
 * deliberately last: it burns the budget for the whole window, and any login after it
 * (including `npm run check`) will get a 429 until the window rolls over.
 *
 * If you need to log in again immediately afterwards, restart the API. The limiter
 * store is in-process, so a restart clears it.
 */

const BASE = process.env.CHECK_BASE_URL || 'http://localhost:4000';
const PASSWORD = process.env.SEED_PASSWORD || 'demo1234';

const HARINGHATA_DOCTOR = '9800000010'; // Dr. Arun Ghosh
const CHAKDAHA_DOCTOR = '9800000011'; // Dr. Ravi Sharma

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, ok: response.ok, body: payload };
}

/**
 * Deletes an account this script created.
 *
 * The sign-up section has to create a real account to prove the field-worker path works, and
 * there is no API to undo that — deliberately, since a self-service "delete my account"
 * endpoint on a system of clinical records is a much larger decision than a test's
 * convenience.
 *
 * So this reaches into MongoDB directly, and does so as BEST EFFORT: the rest of this file
 * talks only HTTP and therefore works against a deployed server, where this process has no
 * database credentials. A failure here is reported and skipped rather than failing the run,
 * because "could not tidy up" is not a security finding. The account left behind is an
 * inactive field worker scoped to its own (empty) submissions.
 *
 * Imported dynamically so a run against a remote BASE never pays for loading mongoose.
 */
async function removeUserByPhone(phone) {
  try {
    const [{ connectDatabase, disconnectDatabase }, { User }] = await Promise.all([
      import('../src/db/connect.js'),
      import('../src/models/User.js'),
    ]);
    const { inMemory } = await connectDatabase();
    if (inMemory) {
      // An in-process database is not the one the API under test is using.
      await disconnectDatabase();
      console.log('  ..    skipped cleanup: this process would spawn its own in-memory DB');
      return;
    }
    await User.deleteOne({ phone });
    await disconnectDatabase();
    console.log(`  ..    cleaned up the sign-up test account (${phone})`);
  } catch (error) {
    console.log(`  ..    could not clean up ${phone} (${error.message}); safe to delete by hand`);
  }
}

async function login(phone) {
  const result = await api('/api/auth/login', {
    method: 'POST',
    body: { phone, password: PASSWORD },
  });
  if (!result.ok) {
    throw new Error(
      `Login failed for ${phone} (${result.status}): ${JSON.stringify(result.body?.error)}\n` +
        'If this is TOO_MANY_ATTEMPTS, a previous run used up the rate-limit budget.\n' +
        'Restart the API to clear it, then run this again.',
    );
  }
  return result.body;
}

async function main() {
  console.log(`Checking SwasthBharat security posture against ${BASE}`);

  /* 1. Role isolation across PHCs ---------------------------------------- */
  console.log('\n1. Role isolation (cross-PHC record access)');

  const ghosh = await login(HARINGHATA_DOCTOR);
  const sharma = await login(CHAKDAHA_DOCTOR);
  check(
    'the two doctors really are at different PHCs',
    ghosh.user.phcId && sharma.user.phcId && ghosh.user.phcId !== sharma.user.phcId,
    `${ghosh.user.phc?.name} vs ${sharma.user.phc?.name}`,
  );

  const ghoshQueue = await api('/api/dashboard/flagged?band=HIGH&status=all', {
    token: ghosh.token,
  });
  const target = (ghoshQueue.body?.items ?? [])[0];
  check('found a Haringhata record to attempt access on', Boolean(target?.id));

  const asSharma = await api(`/api/assessments/${target?.id}`, { token: sharma.token });
  check(
    "the other PHC's doctor is refused with 403 OUT_OF_SCOPE",
    asSharma.status === 403 && asSharma.body?.error?.code === 'OUT_OF_SCOPE',
    `${asSharma.status} ${JSON.stringify(asSharma.body?.error?.code)}`,
  );

  const asGhosh = await api(`/api/assessments/${target?.id}`, { token: ghosh.token });
  check(
    'the owning PHC\'s doctor can still read it (the rule is scope, not a blanket block)',
    asGhosh.status === 200,
    `${asGhosh.status} ${JSON.stringify(asGhosh.body?.error?.code)}`,
  );

  // `?mine=true` exists for the PWA's post-login restore, which downloads a worker's own
  // screenings back into IndexedDB. It must only ever NARROW what scopeFilterFor allows —
  // a filter that could widen scope would be a hole straight through the checks above.
  const ghoshAll = await api('/api/assessments?limit=200', { token: ghosh.token });
  const ghoshMine = await api('/api/assessments?limit=200&mine=true', { token: ghosh.token });
  check(
    'mine=true never returns more records than the caller\'s normal scope',
    typeof ghoshAll.body?.total === 'number' &&
      typeof ghoshMine.body?.total === 'number' &&
      ghoshMine.body.total <= ghoshAll.body.total,
    `mine=${ghoshMine.body?.total} of scope=${ghoshAll.body?.total}`,
  );
  check(
    'and every record it returns was created by the caller',
    (ghoshMine.body?.items ?? []).every((item) => item.createdBy?.id === ghosh.user.id),
    `${(ghoshMine.body?.items ?? []).filter((i) => i.createdBy?.id !== ghosh.user.id).length} foreign`,
  );

  /* 2. Firebase phone sign-in (optional feature, mandatory invariants) ---- */
  //
  // Before the rate-limit test: /api/auth/firebase shares the credential limiter, so
  // these requests need budget.
  //
  // Phone sign-in is optional, so the expected status codes depend on whether a project is
  // configured. What does NOT depend on configuration — and is the whole point of this
  // section — is that an unverified token can never produce a session.
  console.log('\n2. Firebase phone sign-in');

  const health = await api('/api/health');
  const firebaseConfigured = Boolean(health.body?.firebase?.configured);
  console.log(
    `  ..    firebase ${firebaseConfigured ? 'IS' : 'is NOT'} configured on this server` +
      `${health.body?.firebase?.emulator ? ' (auth emulator)' : ''}`,
  );

  const noToken = await api('/api/auth/firebase', { method: 'POST', body: {} });
  const garbageToken = await api('/api/auth/firebase', {
    method: 'POST',
    body: { idToken: 'not.a.real.token' },
  });

  // The invariant, true in every configuration: no verification, no session.
  check(
    'a request with no ID token never returns a session token',
    !noToken.body?.token,
    `body keys: ${Object.keys(noToken.body ?? {}).join(', ')}`,
  );
  check(
    'a forged ID token never returns a session token',
    !garbageToken.body?.token,
    `body keys: ${Object.keys(garbageToken.body ?? {}).join(', ')}`,
  );

  if (firebaseConfigured) {
    check(
      'a missing ID token is rejected as a bad request',
      noToken.status === 400 && noToken.body?.error?.code === 'ID_TOKEN_REQUIRED',
      `${noToken.status} ${noToken.body?.error?.code}`,
    );
    check(
      'a forged ID token is rejected as unauthorised',
      garbageToken.status === 401 && garbageToken.body?.error?.code === 'FIREBASE_TOKEN_INVALID',
      `${garbageToken.status} ${garbageToken.body?.error?.code}`,
    );
    check(
      'the rejection does not leak why the token was invalid',
      !/expired|malformed|revoked|signature/i.test(garbageToken.body?.error?.message ?? ''),
      garbageToken.body?.error?.message,
    );
  } else {
    // 501 rather than 404: the endpoint exists, this deployment has not enabled it.
    check(
      'the endpoint reports 501 NOT configured rather than failing obscurely',
      garbageToken.status === 501 && garbageToken.body?.error?.code === 'FIREBASE_NOT_CONFIGURED',
      `${garbageToken.status} ${garbageToken.body?.error?.code}`,
    );
  }

  // Firebase must not have become a way to read internals. `firebaseUid` links an account
  // to a Firebase user and has no business in an API response.
  check(
    'the user payload exposes neither passwordHash nor firebaseUid',
    !('passwordHash' in ghosh.user) && !('firebaseUid' in ghosh.user),
    `keys: ${Object.keys(ghosh.user).join(', ')}`,
  );

  // The regression that matters most: adding a second sign-in route must not have
  // disturbed the first one.
  const passwordStillWorks = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: CHAKDAHA_DOCTOR, password: PASSWORD },
  });
  check(
    'password login still works alongside the phone-OTP route',
    passwordStillWorks.status === 200 && Boolean(passwordStillWorks.body?.token),
    `${passwordStillWorks.status} ${passwordStillWorks.body?.error?.code ?? ''}`,
  );

  /* 3. Push notification registration ------------------------------------ */
  //
  // The interesting property here is STRUCTURAL: there is no way to say who should receive
  // an alert. A device registers itself against its own account and the server derives
  // recipients from the database, by PHC. FCM topics would have let the client pick its own
  // audience, which would have routed straight around section 1.
  console.log('\n3. Push notification registration');

  const pushConfigured = Boolean(health.body?.push?.configured);
  console.log(`  ..    push ${pushConfigured ? 'IS' : 'is NOT'} configured on this server`);

  const anonymousRegister = await api('/api/notifications/token', {
    method: 'POST',
    body: { token: 'fake-fcm-token' },
  });
  check(
    'registering a device without a token is refused',
    anonymousRegister.status === 401,
    `${anonymousRegister.status} ${anonymousRegister.body?.error?.code}`,
  );

  // An ASHA worker never receives these alerts, so must not be able to register a device.
  // Otherwise the system stores a push credential it will never use, and a later change
  // could start delivering patient names to the wrong audience.
  const asha = await login('9800000001');
  const ashaRegister = await api('/api/notifications/token', {
    method: 'POST',
    token: asha.token,
    body: { token: 'fake-fcm-token' },
  });
  check(
    'a field worker cannot register for doctor alerts (403)',
    ashaRegister.status === 403 && ashaRegister.body?.error?.code === 'ROLE_NOT_PERMITTED',
    `${ashaRegister.status} ${ashaRegister.body?.error?.code}`,
  );

  const doctorRegister = await api('/api/notifications/token', {
    method: 'POST',
    token: ghosh.token,
    body: { token: 'fake-fcm-token-for-check' },
  });
  if (pushConfigured) {
    check(
      'a doctor can register a device',
      doctorRegister.status === 201 && doctorRegister.body?.registered === true,
      `${doctorRegister.status} ${doctorRegister.body?.error?.code ?? ''}`,
    );
    // Clean up so the check does not leave a bogus token behind for a real send to fail on.
    await api('/api/notifications/token', {
      method: 'DELETE',
      token: ghosh.token,
      body: { token: 'fake-fcm-token-for-check' },
    });
  } else {
    check(
      'registration reports 501 when push is not configured',
      doctorRegister.status === 501 && doctorRegister.body?.error?.code === 'PUSH_NOT_CONFIGURED',
      `${doctorRegister.status} ${doctorRegister.body?.error?.code}`,
    );
  }

  const pushStatusResponse = await api('/api/notifications/status', { token: ghosh.token });
  check(
    'the status endpoint never returns raw device tokens',
    pushStatusResponse.status === 200 &&
      !JSON.stringify(pushStatusResponse.body ?? {}).includes('fake-fcm-token'),
    JSON.stringify(pushStatusResponse.body),
  );

  /* 4. Self-service sign-up ---------------------------------------------- */
  //
  // Sign-up is the one place a stranger can create state in this system, so the property
  // that matters is what they CANNOT create. `role` decides how much patient data an account
  // reads — doctor sees a whole PHC, officer a whole district — so if registration could
  // grant those, section 1 would be decoration.
  //
  // Before the rate-limit test, because /api/auth/register shares the credential limiter.
  console.log('\n4. Self-service sign-up (public account creation)');

  const phcList = await api('/api/auth/phcs');
  const somePhc = (phcList.body?.items ?? [])[0];
  check(
    'the PHC list is readable without a login, so sign-up can offer a picker',
    phcList.status === 200 && Boolean(somePhc?.code),
    `${phcList.status} ${(phcList.body?.items ?? []).length} items`,
  );

  // A public endpoint should return the minimum. Villages, GPS and the office phone are
  // not secret, but they are also not needed to fill a dropdown, and this route has no
  // authentication in front of it.
  check(
    'the public PHC list exposes no fields beyond code, name, block and district',
    somePhc && Object.keys(somePhc).sort().join(',') === 'block,code,district,name',
    `keys: ${Object.keys(somePhc ?? {}).join(', ')}`,
  );

  /** Unique each run so a re-run is not blocked by its own leftovers. */
  const throwaway = () => `9${String(Date.now()).slice(-9)}`;

  const asDoctor = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Self Promoted',
      phone: throwaway(),
      password: 'long-enough-password',
      role: 'doctor',
      phcCode: somePhc?.code,
    },
  });
  check(
    'sign-up cannot create a DOCTOR without the setup token (403)',
    asDoctor.status === 403 && asDoctor.body?.error?.code === 'SETUP_TOKEN_REQUIRED',
    `${asDoctor.status} ${asDoctor.body?.error?.code}`,
  );
  check(
    'and it returns no session token when it refuses',
    !asDoctor.body?.token,
    `body keys: ${Object.keys(asDoctor.body ?? {}).join(', ')}`,
  );

  const asOfficer = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Self Promoted',
      phone: throwaway(),
      password: 'long-enough-password',
      role: 'officer',
      phcCode: somePhc?.code,
    },
  });
  check(
    'sign-up cannot create a DISTRICT OFFICER without the setup token (403)',
    asOfficer.status === 403 && asOfficer.body?.error?.code === 'SETUP_TOKEN_REQUIRED',
    `${asOfficer.status} ${asOfficer.body?.error?.code}`,
  );

  const wrongToken = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Self Promoted',
      phone: throwaway(),
      password: 'long-enough-password',
      role: 'doctor',
      phcCode: somePhc?.code,
      setupToken: 'guessed-wrong',
    },
  });
  check(
    'a wrong setup token is refused too, not merely a missing one',
    wrongToken.status === 403 && wrongToken.body?.error?.code === 'SETUP_TOKEN_REQUIRED',
    `${wrongToken.status} ${wrongToken.body?.error?.code}`,
  );

  // The field-worker path must still work, or sign-up is useless. This account is created
  // for real and then deleted at the end of the section.
  const ashaPhone = throwaway();
  const asAsha = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Check Signup Worker',
      phone: ashaPhone,
      password: 'long-enough-password',
      role: 'asha',
      language: 'bn',
      phcCode: somePhc?.code,
    },
  });
  check(
    'sign-up CAN create a field worker, and returns a session',
    asAsha.status === 201 && asAsha.body?.user?.role === 'asha' && Boolean(asAsha.body?.token),
    `${asAsha.status} role=${asAsha.body?.user?.role} ${asAsha.body?.error?.code ?? ''}`,
  );
  check(
    'the new account is filed against the PHC that was chosen',
    asAsha.body?.user?.phc?.code === somePhc?.code,
    `${asAsha.body?.user?.phc?.code} vs ${somePhc?.code}`,
  );
  check(
    'the sign-up response leaks neither passwordHash nor firebaseUid',
    asAsha.body?.user && !('passwordHash' in asAsha.body.user) && !('firebaseUid' in asAsha.body.user),
    `keys: ${Object.keys(asAsha.body?.user ?? {}).join(', ')}`,
  );

  // A brand-new field worker has submitted nothing, so their view must be empty rather
  // than showing the PHC's existing caseload.
  const newWorkerQueue = await api('/api/dashboard/flagged?band=HIGH&status=all', {
    token: asAsha.body?.token,
  });
  check(
    'a newly signed-up worker sees zero existing records, not the PHC caseload',
    newWorkerQueue.status === 200 && (newWorkerQueue.body?.items ?? []).length === 0,
    `${newWorkerQueue.status} count=${(newWorkerQueue.body?.items ?? []).length}`,
  );

  const duplicate = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Check Signup Worker',
      phone: ashaPhone,
      password: 'long-enough-password',
      role: 'asha',
      phcCode: somePhc?.code,
    },
  });
  check(
    'a second sign-up on the same number is a clean 409, not a duplicate account',
    duplicate.status === 409 && duplicate.body?.error?.code === 'PHONE_IN_USE',
    `${duplicate.status} ${duplicate.body?.error?.code}`,
  );

  const shortPassword = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Too Short',
      phone: throwaway(),
      password: 'abc',
      role: 'asha',
      phcCode: somePhc?.code,
    },
  });
  check(
    'a password under 8 characters is rejected server-side, not just in the browser',
    shortPassword.status === 400 && shortPassword.body?.error?.code === 'PASSWORD_TOO_SHORT',
    `${shortPassword.status} ${shortPassword.body?.error?.code}`,
  );

  // Remove the account this section created, so repeated runs do not accumulate users.
  await removeUserByPhone(ashaPhone);

  /* 5. Login rate limiting ----------------------------------------------- */
  // Last on purpose: this consumes the limiter budget for the whole window.
  console.log('\n5. Login rate limiting (30 per 10 min, counts every attempt)');

  const statuses = [];
  const codes = new Set();
  for (let i = 0; i < 35; i += 1) {
    const attempt = await api('/api/auth/login', {
      method: 'POST',
      body: { phone: HARINGHATA_DOCTOR, password: 'deliberately-wrong' },
    });
    statuses.push(attempt.status);
    if (attempt.body?.error?.code) codes.add(attempt.body.error.code);
  }

  const rejected = statuses.filter((status) => status === 429);
  const serverErrors = statuses.filter((status) => status >= 500);

  check('the limiter actually triggers', rejected.length > 0, `statuses seen: ${[...new Set(statuses)].join(', ')}`);
  check(
    'it answers 429 TOO_MANY_ATTEMPTS, not a 500',
    rejected.length > 0 && codes.has('TOO_MANY_ATTEMPTS') && serverErrors.length === 0,
    `codes seen: ${[...codes].join(', ')}`,
  );
  check(
    'wrong passwords before the limit are 401, not silently accepted',
    statuses.every((status) => status === 401 || status === 429),
    `statuses seen: ${[...new Set(statuses)].join(', ')}`,
  );

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  } else {
    console.log('\nRole isolation and rate limiting both behave as intended.');
    console.log('Note: the login limiter is now saturated. Restart the API before');
    console.log('running npm run check, or wait out the 10-minute window.');
  }
}

main().catch((error) => {
  console.error('\nCheck aborted:', error.message);
  process.exitCode = 1;
});
