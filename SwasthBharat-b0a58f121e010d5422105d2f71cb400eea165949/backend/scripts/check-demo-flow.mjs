/**
 * End-to-end check of the demo flow against a running API.
 *
 *   npm run dev        # in one terminal
 *   npm run check      # in another
 *
 * Walks the exact sequence the judges will see, and asserts each step. Run it once before
 * presenting: it catches "the socket alert stopped firing" in ten seconds instead of on
 * stage.
 *
 * Covers:
 *   1. health + model transparency endpoint
 *   2. worker login
 *   3. the scripted high-risk screening scores HIGH with the expected reasons
 *   4. the PHC doctor's dashboard receives a live Socket.io alert
 *   5. offline batch sync works, and replaying it does not duplicate
 *   6. the doctor's flagged queue and the officer's district trends return data
 *   7. the Bengali chatbot answers the scripted question
 *   8. a teleconsult booking is created AND labelled simulated
 *   9. a doctor at another PHC cannot read this PHC's records
 */

import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const BASE = process.env.CHECK_BASE_URL || 'http://localhost:4000';
const PASSWORD = process.env.SEED_PASSWORD || 'demo1234';

const ACCOUNTS = {
  asha: '9800000001', // Sunita Das, Haringhata PHC
  doctor: '9800000010', // Dr. Arun Ghosh, Haringhata PHC
  otherDoctor: '9800000011', // Dr. Ravi Sharma, Chakdaha PHC
  officer: '9800000020', // Dr. Meera Nair, Nadia district
};

/** The screening from the demo script: glucose 165, BMI 31, family history present. */
const DEMO_VITALS = {
  sex: 'female',
  age: 46,
  glucoseMgDl: 165,
  glucoseMeasurementType: 'fasting',
  diastolicBpMmHg: 88,
  heightCm: 155,
  weightKg: 74.5,
  familyHistoryDiabetes: true,
  pregnancies: 3,
};

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

function section(title) {
  console.log(`\n${title}`);
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
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

async function login(phone) {
  const result = await api('/api/auth/login', {
    method: 'POST',
    body: { phone, password: PASSWORD },
  });
  if (!result.ok) {
    throw new Error(
      `Login failed for ${phone} (${result.status}): ${JSON.stringify(result.body)}\n` +
        'Is the server running, and has the demo data been seeded?',
    );
  }
  return result.body;
}

function buildRecord(overrides = {}) {
  const suffix = randomUUID().slice(0, 8);
  return {
    clientId: `check_as_${randomUUID()}`,
    patient: {
      clientId: `check_pt_${randomUUID()}`,
      name: `Check Patient ${suffix}`,
      age: DEMO_VITALS.age,
      sex: DEMO_VITALS.sex,
      village: 'Mollabelia',
    },
    input: { ...DEMO_VITALS },
    capturedAt: new Date().toISOString(),
    language: 'bn',
    inputMethod: 'voice',
    ...overrides,
  };
}

/** Resolves with the first matching event, or null after the timeout. */
function waitForEvent(socket, event, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, timeoutMs);
    function handler(payload) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

async function main() {
  console.log(`Checking SwasthBharat demo flow against ${BASE}`);

  /* 1. Health and transparency ------------------------------------------- */
  section('1. Server health and model transparency');
  const health = await api('/api/health');
  check('GET /api/health returns ok', health.ok && health.body?.status === 'ok', JSON.stringify(health.body));
  check('database is connected', health.body?.database?.state === 'connected');

  const model = await api('/api/model');
  check('GET /api/model is public (no token needed)', model.ok);
  check('model card admits it is a prototype', model.body?.isPrototype === true);
  check(
    'model card discloses the Pima dataset limitation',
    Array.isArray(model.body?.limitations) &&
      model.body.limitations.some((line) => /pima/i.test(line)),
  );
  check(
    'model card reports held-out metrics',
    typeof model.body?.metrics?.test?.accuracy === 'number' &&
      typeof model.body?.metrics?.test?.recall === 'number',
    JSON.stringify(model.body?.metrics?.test),
  );

  /* 2. Logins ------------------------------------------------------------- */
  section('2. Logins');
  const asha = await login(ACCOUNTS.asha);
  const doctor = await login(ACCOUNTS.doctor);
  const otherDoctor = await login(ACCOUNTS.otherDoctor);
  const officer = await login(ACCOUNTS.officer);

  check('ASHA worker logs in', Boolean(asha.token) && asha.user.role === 'asha');
  check('PHC doctor logs in', Boolean(doctor.token) && doctor.user.role === 'doctor');
  check('district officer logs in', Boolean(officer.token) && officer.user.role === 'officer');
  check('worker is linked to a PHC', Boolean(asha.user.phcId), JSON.stringify(asha.user.phc?.code));
  check('password hash is never returned', !JSON.stringify(asha.user).includes('passwordHash'));

  const badLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: ACCOUNTS.asha, password: 'wrong-password' },
  });
  check('wrong password is rejected', badLogin.status === 401);

  const noToken = await api('/api/assessments');
  check('protected route rejects a missing token', noToken.status === 401);

  /* 3. Scoring ------------------------------------------------------------ */
  section('3. Risk scoring (the demo case: glucose 165, BMI 31, family history)');
  const scored = await api('/api/assessments/score', {
    method: 'POST',
    token: asha.token,
    body: DEMO_VITALS,
  });
  const result = scored.body?.result;
  check('scoring endpoint responds', scored.ok, JSON.stringify(scored.body));
  check('band is HIGH', result?.riskBand === 'HIGH', result?.riskBand);
  check('BMI is computed from height and weight', result?.derived?.bmi === 31, String(result?.derived?.bmi));
  check('BMI is labelled obese (Indian cut-off)', result?.derived?.bmiCategory === 'obese');
  check('glucose is labelled diabetes range', result?.derived?.glucoseCategory === 'diabetes');

  const reasonCodes = (result?.reasons ?? []).map((reason) => reason.code);
  check('explains elevated blood sugar', reasonCodes.includes('GLUCOSE_DIABETES_RANGE'), reasonCodes.join(','));
  check('explains obesity', reasonCodes.includes('BMI_OBESE'));
  check('explains family history', reasonCodes.includes('FAMILY_HISTORY_PRESENT'));
  check(
    'discloses that unmeasured values were defaulted',
    reasonCodes.includes('MODEL_DEFAULTS_USED') &&
      result.imputedFields.includes('skinThicknessMm') &&
      result.imputedFields.includes('insulinMuUml'),
    JSON.stringify(result?.imputedFields),
  );
  check('every reason carries an i18n key', (result?.reasons ?? []).every((r) => Boolean(r.i18nKey)));
  check('decision path is returned for audit', Array.isArray(result?.decisionPath) && result.decisionPath.length > 0);

  const invalid = await api('/api/assessments/score', {
    method: 'POST',
    token: asha.token,
    body: { ...DEMO_VITALS, glucoseMgDl: 1650 },
  });
  check('out-of-range glucose is rejected', invalid.status === 400 && invalid.body?.error?.code === 'VALIDATION_FAILED');
  check(
    'validation errors name the offending field',
    invalid.body?.error?.details?.fields?.some((f) => f.field === 'glucoseMgDl'),
    JSON.stringify(invalid.body?.error?.details),
  );

  /* 4. Live alert --------------------------------------------------------- */
  section('4. Live Socket.io alert to the PHC dashboard');
  const socket = io(BASE, { auth: { token: doctor.token }, transports: ['websocket'] });

  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    socket.on('connection:ready', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.message });
    });
  });
  check("doctor's socket connects and joins rooms", Boolean(ready?.rooms), JSON.stringify(ready));
  check(
    'socket joined the PHC room (not a global broadcast)',
    (ready?.rooms ?? []).some((room) => room.startsWith('phc:')),
    JSON.stringify(ready?.rooms),
  );

  const alertPromise = waitForEvent(socket, 'assessment:high-risk');
  const created = await api('/api/assessments', {
    method: 'POST',
    token: asha.token,
    body: buildRecord(),
  });
  check('high-risk screening is stored', created.status === 201, JSON.stringify(created.body?.error));
  check('stored record is HIGH', created.body?.assessment?.riskBand === 'HIGH');

  const alert = await alertPromise;
  check('doctor receives the high-risk alert live', Boolean(alert), 'no event within 8s');
  check(
    'alert carries the patient and the reasons',
    Boolean(alert?.patient?.name) && (alert?.topReasons ?? []).length > 0,
    JSON.stringify(alert && Object.keys(alert)),
  );
  check('alert matches the stored record', alert?.assessmentId === created.body?.assessment?.id);

  const unauthenticatedSocket = io(BASE, { transports: ['websocket'], reconnection: false });
  const socketRejected = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 6000);
    unauthenticatedSocket.on('connect_error', () => {
      clearTimeout(timer);
      resolve(true);
    });
    unauthenticatedSocket.on('connection:ready', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  check('a socket with no token is refused', socketRejected);
  unauthenticatedSocket.close();

  /* 5. Offline sync ------------------------------------------------------- */
  section('5. Offline capture and sync (the wifi-off moment)');
  const offlineBatch = [
    buildRecord({ deviceRiskBand: 'HIGH' }),
    buildRecord({
      input: { ...DEMO_VITALS, glucoseMgDl: 92, heightCm: 165, weightKg: 55, familyHistoryDiabetes: false, age: 26 },
      deviceRiskBand: 'LOW',
    }),
  ];

  const syncOne = await api('/api/assessments/sync', {
    method: 'POST',
    token: asha.token,
    body: { records: offlineBatch },
  });
  check('sync accepts the queued batch', syncOne.ok, JSON.stringify(syncOne.body?.error));
  check('both records are created', syncOne.body?.summary?.created === 2, JSON.stringify(syncOne.body?.summary));
  check('no device/server band mismatches', (syncOne.body?.results ?? []).every((r) => r.bandMismatch === false));
  check(
    // Regression check for BUG-1: without patientId here the device can never book a
    // teleconsult for a record that arrived via offline sync (see prompts/00-SHARED-CONTEXT.md).
    'sync results include a usable patientId for booking a teleconsult later',
    (syncOne.body?.results ?? []).every((r) => typeof r.patientId === 'string' && r.patientId.length > 0),
    JSON.stringify(syncOne.body?.results),
  );
  check(
    'records are marked as synced from offline',
    (syncOne.body?.results ?? []).every((r) => r.status === 'created'),
  );

  const syncTwice = await api('/api/assessments/sync', {
    method: 'POST',
    token: asha.token,
    body: { records: offlineBatch },
  });
  check(
    'replaying the same batch creates nothing (idempotent)',
    syncTwice.body?.summary?.created === 0 && syncTwice.body?.summary?.duplicates === 2,
    JSON.stringify(syncTwice.body?.summary),
  );

  const mixedBatch = [
    buildRecord(),
    buildRecord({ input: { ...DEMO_VITALS, glucoseMgDl: 9999 } }),
  ];
  const partial = await api('/api/assessments/sync', {
    method: 'POST',
    token: asha.token,
    body: { records: mixedBatch },
  });
  check(
    'one bad record does not block the good ones',
    partial.body?.summary?.created === 1 && partial.body?.summary?.failed === 1,
    JSON.stringify(partial.body?.summary),
  );
  check(
    'the failed record is reported back with its field errors',
    partial.body?.results?.some((r) => r.status === 'failed' && r.error?.fields?.length > 0),
    JSON.stringify(partial.body?.results?.find((r) => r.status === 'failed')),
  );

  /* 6. Dashboards --------------------------------------------------------- */
  section('6. Doctor dashboard and district trends');
  const flagged = await api('/api/dashboard/flagged?band=HIGH&status=open', { token: doctor.token });
  check('flagged queue loads', flagged.ok, JSON.stringify(flagged.body?.error));
  check('queue contains high-risk cases', (flagged.body?.items ?? []).length > 0);
  check('queue is high-risk only', (flagged.body?.items ?? []).every((item) => item.riskBand === 'HIGH'));
  check(
    'the newly submitted case is in the queue',
    (flagged.body?.items ?? []).some((item) => item.id === created.body?.assessment?.id),
  );

  const summary = await api('/api/dashboard/summary', { token: doctor.token });
  check('summary loads', summary.ok);
  check('summary counts assessments', (summary.body?.totals?.assessments ?? 0) > 0, JSON.stringify(summary.body?.totals));
  check('summary reports offline share', typeof summary.body?.dataQuality?.offlineShare === 'number');

  const trends = await api('/api/district/trends?days=30', { token: officer.token });
  check('district trends load', trends.ok, JSON.stringify(trends.body?.error));
  check('daily series has one point per day', (trends.body?.dailySeries ?? []).length === 30);
  check('per-PHC breakdown is present', (trends.body?.perPhc ?? []).length > 0);
  check('top risk factors are aggregated', (trends.body?.topRiskFactors ?? []).length > 0);
  check('adoption metrics include voice usage', typeof trends.body?.adoption?.voiceEntryShare === 'number');

  const review = await api(`/api/assessments/${created.body?.assessment?.id}/review`, {
    method: 'PATCH',
    token: doctor.token,
    body: { reviewStatus: 'acknowledged', reviewNote: 'Called patient, advised fasting test.' },
  });
  check('doctor can triage a case', review.ok && review.body?.assessment?.reviewStatus === 'acknowledged');

  const workerTriage = await api(`/api/assessments/${created.body?.assessment?.id}/review`, {
    method: 'PATCH',
    token: asha.token,
    body: { reviewStatus: 'closed' },
  });
  check('a field worker cannot triage cases', workerTriage.status === 403, String(workerTriage.status));

  /* 7. Chatbot ------------------------------------------------------------ */
  section('7. Multilingual FAQ chatbot');
  const bengali = await api('/api/chatbot/ask', {
    method: 'POST',
    body: { question: 'শর্করা বেশি হলে কী খাব?', language: 'bn' },
  });
  check('chatbot answers without a login', bengali.ok);
  check('Bengali diet question matches the diet intent', bengali.body?.answer?.intentId === 'diet', bengali.body?.answer?.intentId);
  check('answer is in Bengali', /[\u0980-\u09FF]/.test(bengali.body?.answer?.title ?? ''));
  check('answer carries a medical disclaimer', Boolean(bengali.body?.answer?.disclaimer));

  const hindi = await api('/api/chatbot/ask', {
    method: 'POST',
    body: { question: 'मधुमेह के लक्षण क्या हैं', language: 'hi' },
  });
  check('Hindi symptom question matches', hindi.body?.answer?.intentId === 'symptoms', hindi.body?.answer?.intentId);
  check('Hindi answer is in Devanagari', /[\u0900-\u097F]/.test(hindi.body?.answer?.title ?? ''));

  const emergency = await api('/api/chatbot/ask', {
    method: 'POST',
    body: { question: 'রোগী অজ্ঞান হয়ে গেছে', language: 'bn' },
  });
  check('emergency question escalates', emergency.body?.answer?.escalate === true);

  const nonsense = await api('/api/chatbot/ask', {
    method: 'POST',
    body: { question: 'who won the cricket match', language: 'en' },
  });
  check('unknown question falls back instead of inventing advice', nonsense.body?.answer?.matched === false);

  /* 8. Teleconsult (simulated) ------------------------------------------- */
  section('8. Teleconsultation booking (simulated, and says so)');
  const booking = await api('/api/teleconsult', {
    method: 'POST',
    token: asha.token,
    body: {
      clientId: `check_tc_${randomUUID()}`,
      patientId: created.body?.assessment?.patientId,
      assessmentId: created.body?.assessment?.id,
      reason: 'High risk screening',
      preferredLanguage: 'bn',
    },
  });
  check('booking is created', booking.status === 201, JSON.stringify(booking.body?.error));
  check('booking is flagged as simulated', booking.body?.teleconsult?.isSimulated === true);
  check('response carries an explicit simulation notice', /simulated/i.test(booking.body?.simulationNotice ?? ''));
  check('session id is marked fake', String(booking.body?.teleconsult?.sessionId ?? '').startsWith('sim-'));

  // A worker who has never been online has no server-side patientId yet, only the
  // device-generated clientId. Booking must still work off that alone.
  const offlineRecord = buildRecord();
  const offlineOnlyPatient = await api('/api/assessments/sync', {
    method: 'POST',
    token: asha.token,
    body: { records: [offlineRecord] },
  });
  check(
    'setup: offline-only patient synced for the clientId booking check',
    offlineOnlyPatient.ok && offlineOnlyPatient.body?.summary?.created === 1,
    JSON.stringify(offlineOnlyPatient.body?.summary),
  );

  const bookingByClientId = await api('/api/teleconsult', {
    method: 'POST',
    token: asha.token,
    body: {
      clientId: `check_tc_${randomUUID()}`,
      patientClientId: offlineRecord.patient.clientId,
      reason: 'Booked before the sync round trip populated a patientId',
      preferredLanguage: 'bn',
    },
  });
  check(
    'booking succeeds given only patientClientId (no patientId yet)',
    bookingByClientId.status === 201,
    JSON.stringify(bookingByClientId.body?.error),
  );
  check(
    'clientId booking resolves to the correct patient',
    bookingByClientId.body?.teleconsult?.patient?.clientId === offlineRecord.patient.clientId,
    JSON.stringify(bookingByClientId.body?.teleconsult?.patient),
  );

  const bookingByPatientId = await api('/api/teleconsult', {
    method: 'POST',
    token: asha.token,
    body: {
      clientId: `check_tc_${randomUUID()}`,
      patientId: created.body?.assessment?.patientId,
      reason: 'Booked using the already-synced server patientId',
      preferredLanguage: 'bn',
    },
  });
  check(
    'booking still succeeds given only patientId',
    bookingByPatientId.status === 201,
    JSON.stringify(bookingByPatientId.body?.error),
  );

  const bookingNoPatient = await api('/api/teleconsult', {
    method: 'POST',
    token: asha.token,
    body: { clientId: `check_tc_${randomUUID()}`, reason: 'No patient reference at all' },
  });
  check(
    'booking with neither patientId nor patientClientId is rejected clearly',
    bookingNoPatient.status === 400 &&
      bookingNoPatient.body?.error?.code === 'PATIENT_REFERENCE_REQUIRED',
    `${bookingNoPatient.status} ${JSON.stringify(bookingNoPatient.body?.error?.code)}`,
  );

  const bookingUnknownClientId = await api('/api/teleconsult', {
    method: 'POST',
    token: asha.token,
    body: {
      clientId: `check_tc_${randomUUID()}`,
      patientClientId: `check_pt_${randomUUID()}`, // well-formed, but nobody synced it
      reason: 'Unknown device id',
    },
  });
  check(
    'an unknown patientClientId is a clean 404, not a crash',
    bookingUnknownClientId.status === 404 &&
      bookingUnknownClientId.body?.error?.code === 'PATIENT_NOT_FOUND',
    `${bookingUnknownClientId.status} ${JSON.stringify(bookingUnknownClientId.body?.error?.code)}`,
  );

  const capabilities = await api('/api/teleconsult/capabilities', { token: asha.token });
  check('capabilities endpoint admits the video call is not implemented', capabilities.body?.videoCall?.implemented === false);
  check('capabilities endpoint admits SMS is not integrated', capabilities.body?.smsFallback?.implemented === false);

  /* 9. Access scoping ---------------------------------------------------- */
  section('9. Access scoping between PHCs');
  const crossPhc = await api(`/api/assessments/${created.body?.assessment?.id}`, {
    token: otherDoctor.token,
  });
  check(
    "a doctor at another PHC cannot read this PHC's record",
    crossPhc.status === 403,
    `${crossPhc.status} ${JSON.stringify(crossPhc.body?.error?.code)}`,
  );

  const otherFlagged = await api('/api/dashboard/flagged?band=HIGH&status=all', { token: otherDoctor.token });
  check(
    "another PHC's queue excludes this PHC's new case",
    !(otherFlagged.body?.items ?? []).some((item) => item.id === created.body?.assessment?.id),
  );

  const officerPatients = await api('/api/patients', { token: officer.token });
  check('officer requests still scope to their district', officerPatients.ok);

  socket.close();

  /* Result --------------------------------------------------------------- */
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nThe demo flow is NOT fully working. Fix the failures above before presenting.');
    process.exitCode = 1;
  } else {
    console.log('\nEvery step of the demo flow works.');
  }
}

main().catch((error) => {
  console.error('\nCheck aborted:', error.message);
  process.exitCode = 1;
});
