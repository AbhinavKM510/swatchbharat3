/**
 * Seeds demo data.
 *
 *   npm run seed          add anything missing, leave existing data alone
 *   npm run seed:reset    wipe the seeded collections first
 *
 * Why generated data and not a fixture file: the assessments are scored by the real risk
 * engine through the real ingestion service, so the seeded dashboard shows genuine model
 * output. A hand-written fixture would let a wrong band sit in the database unnoticed.
 *
 * The distribution is chosen so the demo screens are not empty and not uniformly red:
 * roughly a third high risk, a spread across three PHCs and thirty days, a realistic mix
 * of voice entry and offline capture.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { config } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './db/connect.js';
import { Assessment } from './models/Assessment.js';
import { ChatQuery } from './models/ChatQuery.js';
import { Patient } from './models/Patient.js';
import { Phc } from './models/Phc.js';
import { TeleconsultRequest } from './models/TeleconsultRequest.js';
import { User } from './models/User.js';
import { ingestAssessment } from './services/assessmentService.js';
import { newSimulatedSessionId } from './utils/ids.js';
import { answerQuestion } from '../../shared/chatbot/index.js';

const RESET = process.argv.includes('--reset');
const SEED = 20260808;

/** Deterministic PRNG so repeated seeds produce the same demo data. */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(SEED);
const pick = (list) => list[Math.floor(rng() * list.length)];
const between = (min, max) => min + rng() * (max - min);
const intBetween = (min, max) => Math.floor(between(min, max + 1));

const DISTRICT = 'Nadia';
const STATE = 'West Bengal';

const PHC_SEEDS = [
  {
    code: 'NAD-PHC-01',
    name: 'Haringhata Primary Health Centre',
    block: 'Haringhata',
    villages: ['Mollabelia', 'Sabdalpur', 'Nagarukhra', 'Fatepur', 'Kanchrapara Gram'],
    location: { lat: 22.9631, lng: 88.5619 },
    contactPhone: '03473222111',
  },
  {
    code: 'NAD-PHC-02',
    name: 'Chakdaha Primary Health Centre',
    block: 'Chakdaha',
    villages: ['Ghetugachhi', 'Tatla', 'Sarati', 'Rautari', 'Silinda'],
    location: { lat: 23.0752, lng: 88.5158 },
    contactPhone: '03473222222',
  },
  {
    code: 'NAD-PHC-03',
    name: 'Krishnanagar Primary Health Centre',
    block: 'Krishnanagar I',
    villages: ['Bhaluka', 'Dogachhi', 'Jaleswar', 'Ruipukur', 'Asannagar'],
    location: { lat: 23.4009, lng: 88.5017 },
    contactPhone: '03472222333',
  },
];

const USER_SEEDS = [
  {
    name: 'Sunita Das',
    phone: '9800000001',
    role: 'asha',
    language: 'bn',
    phcCode: 'NAD-PHC-01',
    villages: ['Mollabelia', 'Sabdalpur', 'Nagarukhra'],
  },
  {
    name: 'Rekha Kumari',
    phone: '9800000002',
    role: 'asha',
    language: 'hi',
    phcCode: 'NAD-PHC-02',
    villages: ['Ghetugachhi', 'Tatla'],
  },
  {
    name: 'Aparna Mondal',
    phone: '9800000003',
    role: 'asha',
    language: 'bn',
    phcCode: 'NAD-PHC-03',
    villages: ['Bhaluka', 'Dogachhi'],
  },
  {
    name: 'Dr. Arun Ghosh',
    phone: '9800000010',
    role: 'doctor',
    language: 'bn',
    phcCode: 'NAD-PHC-01',
    villages: [],
  },
  {
    name: 'Dr. Ravi Sharma',
    phone: '9800000011',
    role: 'doctor',
    language: 'hi',
    phcCode: 'NAD-PHC-02',
    villages: [],
  },
  {
    name: 'Dr. Meera Nair',
    phone: '9800000020',
    role: 'officer',
    language: 'en',
    phcCode: 'NAD-PHC-01',
    villages: [],
  },
];

const FEMALE_NAMES = [
  'Anjali Bibi', 'Kalpana Ghosh', 'Rina Mondal', 'Shefali Das', 'Jyotsna Roy',
  'Parul Sardar', 'Mamata Biswas', 'Sabitri Halder', 'Rehana Khatun', 'Basanti Pal',
  'Sushila Devi', 'Lakshmi Barman', 'Nasima Begum', 'Tapasi Adhikari', 'Kabita Saha',
];

const MALE_NAMES = [
  'Nurul Haque', 'Sanjib Mondal', 'Bijoy Das', 'Ramen Sarkar', 'Habibur Rahman',
  'Sukumar Ghosh', 'Ashok Biswas', 'Dilip Halder', 'Manik Roy', 'Sekhar Pal',
];

/**
 * Generates one plausible screening.
 *
 * The vitals are drawn from three profiles rather than one uniform range, because a
 * uniform draw produces a population that looks nothing like a real village screening
 * list — you get no clear low-risk patients and no clear high-risk ones.
 */
function randomVitals() {
  const profile = rng();
  const sex = rng() < 0.68 ? 'female' : 'male'; // ASHA outreach skews female
  let age;
  let glucose;
  let bmiTarget;
  let diastolic;

  if (profile < 0.45) {
    // Healthy younger adult
    age = intBetween(21, 38);
    glucose = Math.round(between(78, 112));
    bmiTarget = between(17.5, 23.5);
    diastolic = Math.round(between(62, 80));
  } else if (profile < 0.75) {
    // Middle-aged, borderline
    age = intBetween(35, 52);
    glucose = Math.round(between(105, 145));
    bmiTarget = between(22.5, 28.5);
    diastolic = Math.round(between(74, 88));
  } else {
    // Older, multiple risk factors
    age = intBetween(45, 71);
    glucose = Math.round(between(140, 235));
    bmiTarget = between(26, 36);
    diastolic = Math.round(between(82, 100));
  }

  const heightCm = Math.round(sex === 'female' ? between(143, 163) : between(155, 176));
  const metres = heightCm / 100;
  const weightKg = Math.round(bmiTarget * metres * metres * 10) / 10;

  return {
    sex,
    age,
    glucoseMgDl: glucose,
    glucoseMeasurementType: rng() < 0.75 ? 'fasting' : 'random',
    diastolicBpMmHg: diastolic,
    heightCm,
    weightKg,
    familyHistoryDiabetes: rng() < 0.42,
    pregnancies: sex === 'female' ? intBetween(0, 5) : 0,
    // Usually unmeasured in the field, which is the realistic case and exercises the
    // median-imputation path plus the "defaults were used" disclosure.
    skinThicknessMm: rng() < 0.18 ? intBetween(18, 42) : null,
    insulinMuUml: rng() < 0.1 ? intBetween(40, 220) : null,
  };
}

async function resetCollections() {
  console.log('Resetting seeded collections...');
  await Promise.all([
    Assessment.deleteMany({}),
    Patient.deleteMany({}),
    TeleconsultRequest.deleteMany({}),
    ChatQuery.deleteMany({}),
    User.deleteMany({}),
    Phc.deleteMany({}),
  ]);
}

async function seedPhcs() {
  const phcs = [];
  for (const seed of PHC_SEEDS) {
    const phc = await Phc.findOneAndUpdate(
      { code: seed.code },
      { $set: { ...seed, district: DISTRICT, state: STATE } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    phcs.push(phc);
  }
  console.log(`PHCs ready: ${phcs.map((p) => p.code).join(', ')}`);
  return phcs;
}

async function seedUsers(phcs) {
  const phcByCode = new Map(phcs.map((phc) => [phc.code, phc]));
  const passwordHash = await User.hashPassword(config.seedPassword);
  const users = [];

  for (const seed of USER_SEEDS) {
    const phc = phcByCode.get(seed.phcCode);
    const user = await User.findOneAndUpdate(
      { phone: seed.phone },
      {
        $set: {
          name: seed.name,
          role: seed.role,
          language: seed.language,
          phc: phc._id,
          district: DISTRICT,
          villages: seed.villages,
          isActive: true,
        },
        $setOnInsert: { passwordHash },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).populate('phc');
    users.push(user);
  }

  console.log(`Users ready: ${users.length}`);
  return users;
}

async function seedAssessments(users, phcs) {
  const workers = users.filter((user) => user.role === 'asha');
  const phcById = new Map(phcs.map((phc) => [phc._id.toString(), phc]));

  const existing = await Assessment.countDocuments({});
  if (existing > 0) {
    console.log(`Assessments already present (${existing}), skipping generation.`);
    return { created: 0, byBand: {} };
  }

  const byBand = { LOW: 0, MODERATE: 0, HIGH: 0 };
  const created = [];
  const TOTAL = 46;

  for (let index = 0; index < TOTAL; index += 1) {
    const worker = workers[index % workers.length];
    const phc = phcById.get(String(worker.phc._id || worker.phc));
    const vitals = randomVitals();

    // Spread over the last 30 days, business hours, so charts have shape.
    const daysBack = Math.floor(rng() * 30);
    const capturedAt = new Date();
    capturedAt.setDate(capturedAt.getDate() - daysBack);
    capturedAt.setHours(intBetween(9, 17), intBetween(0, 59), 0, 0);

    const name = vitals.sex === 'female' ? pick(FEMALE_NAMES) : pick(MALE_NAMES);
    const offline = rng() < 0.38;
    const voice = rng() < 0.45;

    const { assessment } = await ingestAssessment({
      record: {
        clientId: `seed_as_${SEED}_${index}`,
        patient: {
          clientId: `seed_pt_${SEED}_${index}`,
          name,
          age: vitals.age,
          sex: vitals.sex,
          phone: rng() < 0.6 ? `9${intBetween(100000000, 999999999)}` : '',
          village: pick(phc.villages),
          capturedAt,
        },
        input: vitals,
        capturedAt,
        language: worker.language,
        inputMethod: voice ? (rng() < 0.5 ? 'voice' : 'mixed') : 'typed',
      },
      user: worker,
      source: offline ? 'offline-sync' : 'online',
      // No sockets during seeding: nobody is listening, and emitting would be misleading.
      emitEvents: false,
    });

    byBand[assessment.riskBand] += 1;
    created.push(assessment);
  }

  // Move some older high-risk cases through the review workflow, so the doctor's queue
  // shows a realistic mix rather than 15 untouched cases.
  const doctors = users.filter((user) => user.role === 'doctor');
  const highRisk = created.filter((a) => a.riskBand === 'HIGH');
  for (const assessment of highRisk) {
    const roll = rng();
    if (roll > 0.55) continue; // leave the rest pending
    const doctor = doctors.find(
      (d) => String(d.phc._id || d.phc) === String(assessment.phc),
    );
    if (!doctor) continue;

    assessment.reviewStatus = roll < 0.2 ? 'closed' : roll < 0.38 ? 'consulted' : 'acknowledged';
    assessment.reviewedBy = doctor._id;
    assessment.reviewedAt = new Date(assessment.capturedAt.getTime() + 36e5);
    assessment.reviewNote =
      assessment.reviewStatus === 'closed'
        ? 'Confirmed by lab FBS. Started on metformin, review in 4 weeks.'
        : 'Called patient, advised fasting blood sugar test at PHC.';
    await assessment.save();
  }

  console.log(`Assessments created: ${created.length}`, byBand);
  return { created: created.length, byBand };
}

async function seedTeleconsults(users) {
  if ((await TeleconsultRequest.countDocuments({})) > 0) {
    console.log('Teleconsult requests already present, skipping.');
    return;
  }

  const highRisk = await Assessment.find({ riskBand: 'HIGH' })
    .sort({ capturedAt: -1 })
    .limit(4)
    .populate('patient');

  const workerById = new Map(users.map((user) => [user._id.toString(), user]));
  let count = 0;

  for (const assessment of highRisk) {
    const worker = workerById.get(String(assessment.createdBy));
    await TeleconsultRequest.create({
      clientId: `seed_tc_${SEED}_${count}`,
      patient: assessment.patient._id,
      assessment: assessment._id,
      phc: assessment.phc,
      district: assessment.district,
      requestedBy: assessment.createdBy,
      reason: 'High risk screening, patient needs doctor review',
      preferredLanguage: worker?.language ?? 'bn',
      status: count === 0 ? 'requested' : count === 1 ? 'completed' : 'requested',
      sessionId: newSimulatedSessionId(),
      isSimulated: true,
      requestedAt: new Date(assessment.capturedAt.getTime() + 12e5),
      ...(count === 1
        ? { completedAt: new Date(assessment.capturedAt.getTime() + 18e5), durationSeconds: 420 }
        : {}),
    });
    count += 1;
  }

  console.log(`Teleconsult requests created: ${count} (all simulated)`);
}

async function seedChatQueries(users) {
  if ((await ChatQuery.countDocuments({})) > 0) {
    console.log('Chat queries already present, skipping.');
    return;
  }

  const asked = [
    ['শর্করা বেশি হলে কী খাব?', 'bn'],
    ['ডায়াবেটিসের লক্ষণ কী?', 'bn'],
    ['রোজ কতটা হাঁটা দরকার?', 'bn'],
    ['शुगर बढ़ी हो तो क्या खाएँ?', 'hi'],
    ['खून की कमी के लिए क्या खाएँ', 'hi'],
    ['मधुमेह क्या है', 'hi'],
    ['where can I get a blood test', 'en'],
    ['pair me ghav hai', 'en'],
    // Genuinely unmatched, so the /api/chatbot/unmatched backlog is not empty:
    ['thyroid er jonno ki korbo', 'bn'],
    ['can I drink coconut water daily', 'en'],
  ];

  const worker = users.find((user) => user.role === 'asha');
  let count = 0;

  for (const [question, language] of asked) {
    const answer = answerQuestion(question, language);
    const askedAt = new Date();
    askedAt.setDate(askedAt.getDate() - intBetween(0, 20));

    await ChatQuery.create({
      question,
      language: answer.language,
      intentId: answer.intentId,
      matched: answer.matched,
      escalated: answer.escalate,
      askedBy: worker?._id ?? null,
      district: DISTRICT,
      source: rng() < 0.4 ? 'offline-sync' : 'online',
      askedAt,
    });
    count += 1;
  }

  console.log(`Chat queries logged: ${count}`);
}

export function printDemoLogins() {
  console.log(`\nDemo logins (password for all: ${config.seedPassword})`);
  console.log('  ASHA worker (Bengali)      9800000001   Sunita Das        Haringhata PHC');
  console.log('  ASHA worker (Hindi)        9800000002   Rekha Kumari      Chakdaha PHC');
  console.log('  ASHA worker (Bengali)      9800000003   Aparna Mondal     Krishnanagar PHC');
  console.log('  PHC doctor                 9800000010   Dr. Arun Ghosh    Haringhata PHC');
  console.log('  PHC doctor                 9800000011   Dr. Ravi Sharma   Chakdaha PHC');
  console.log('  District health officer    9800000020   Dr. Meera Nair    Nadia district');
  console.log('\nFor the live-alert demo, log the doctor in on a second screen before');
  console.log('submitting a high-risk screening as the ASHA worker.');
}

/**
 * Seeds the database. Assumes a connection is already open, so the server can call this
 * in-process.
 *
 * That matters for in-memory mode: `npm run seed` there would populate a throwaway mongod
 * that dies with the script, leaving the server with an empty database. The server seeds
 * itself instead (see server.js).
 *
 * @param {{reset?: boolean, quiet?: boolean}} [options]
 */
export async function runSeed({ reset = false, quiet = false } = {}) {
  if (reset) await resetCollections();

  const phcs = await seedPhcs();
  const users = await seedUsers(phcs);
  const assessments = await seedAssessments(users, phcs);
  await seedTeleconsults(users);
  await seedChatQueries(users);

  if (!quiet) printDemoLogins();

  return { phcs: phcs.length, users: users.length, ...assessments };
}

/** True when this file was started directly (`node src/seed.js`) rather than imported. */
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  connectDatabase()
    .then(async () => {
      if (config.useInMemoryDb) {
        console.warn(
          '\nNote: USE_IN_MEMORY_DB is on, so this seeded database is discarded when the script exits.\n' +
            'The server seeds itself automatically on startup in this mode — you do not need to run this.\n',
        );
      }
      await runSeed({ reset: RESET });
      await disconnectDatabase();
    })
    .catch(async (error) => {
      console.error('\nSeeding failed:', error);
      await mongoose.connection.close().catch(() => {});
      process.exit(1);
    });
}
