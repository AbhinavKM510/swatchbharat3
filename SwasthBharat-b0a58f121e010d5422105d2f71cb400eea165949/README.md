# SwasthBharat

AI-powered early disease risk screening and rural health access, built for ASHA field
workers, PHC doctors and district health officers.

## The problem

Rural India's diagnostic gap is not a lack of health workers, it is a lack of decision
support at the point of contact. ASHA workers visit villages with no way to tell a
routine visit from an urgent one; primary health centres (PHCs) are overloaded and
cannot triage who to see first; and a family history or a borderline blood sugar reading
often goes unrecorded because nothing downstream of it changes. SwasthBharat gives a
field worker with a phone a plain-language risk read at the moment of the visit, and
gives the PHC a live feed of who needs attention first — designed to work when the
network does not.

## What it does

1. An ASHA worker opens the PWA, switches to Bengali or Hindi, and dictates or types a
   patient's vitals (glucose, blood pressure, height/weight, family history).
2. The result shows a risk band — LOW, MODERATE or HIGH — with plain-language reasons,
   not just a percentage ("high risk because blood sugar is 165 and BMI is 31").
3. For a high-risk case, the worker taps "Book consultation". A connecting screen leads
   into a call layout (see [Scope](#scope) — the call itself is simulated).
4. The PHC dashboard, open on a second device, shows the new case appear **live** via
   Socket.io, no refresh needed.
5. A built-in FAQ chatbot answers common questions (e.g. diet, symptoms) in Bengali,
   Hindi or English, with a medical disclaimer and an escalation path for emergencies.
6. If the worker loses signal mid-visit, the record is captured to the device first and
   syncs automatically the moment connectivity returns — no data loss, no duplicate
   records on retry.
7. Alongside the decision tree's result, a small neural network scores the same reading
   independently and explains itself feature by feature. It does not decide the risk
   band — see [Two models](#two-models-tree-and-a-neural-second-opinion) — but when the
   two disagree, that patient is flagged as worth a doctor's attention sooner.
8. Optionally, a worker can sign in with a phone-OTP SMS code instead of a password, and
   a doctor can turn on phone notifications for high-risk cases that arrive while their
   dashboard is closed. Both are Firebase-backed, both are off unless explicitly
   configured, and neither changes how the app behaves without them — see
   [Optional Firebase features](#optional-firebase-features).

## Quick start

Requires Node.js 20+. No Python is needed to run the app (see
[Architecture](#architecture) for why).

```bash
npm run setup                            # installs backend + frontend deps
cp backend/.env.example backend/.env     # PowerShell: Copy-Item backend/.env.example backend/.env
# edit backend/.env — at minimum set JWT_SECRET to any long random string
```

Then, in two separate terminals:

```bash
npm run dev:api      # http://localhost:4000
npm run dev:web      # http://localhost:5173
```

The API seeds itself with demo data on first startup when running against the default
in-memory database (`USE_IN_MEMORY_DB=true` in `backend/.env`). No separate seed step is
required for a local run.

To verify the backend end to end (79 assertions covering the whole demo flow):

```bash
npm run check:api
```

To verify the things a technical reviewer usually probes — cross-PHC role isolation,
Firebase phone sign-in and push-device registration (both correct whether or not
Firebase is configured on this server), and login rate limiting:

```bash
npm run check:security
```

Run `check:security` *after* `check:api`, not before: it deliberately exhausts the
login rate limiter, so logins will be refused with `TOO_MANY_ATTEMPTS` for the rest of
the 10-minute window. Restarting the API clears it.

To verify the two locale files stay in lockstep with English (missing keys, empty
values, mismatched `{placeholders}`):

```bash
npm run check:i18n
```

To re-check the neural second opinion against its own committed metadata (read-only, no
Python needed):

```bash
npm run ml:verify
```

### Demo logins

Password `demo1234` for all accounts.

| Role | Phone | Name | PHC |
| --- | --- | --- | --- |
| ASHA worker (Bengali) | `9800000001` | Sunita Das | Haringhata |
| ASHA worker (Hindi) | `9800000002` | Rekha Kumari | Chakdaha |
| PHC doctor | `9800000010` | Dr. Arun Ghosh | Haringhata |
| PHC doctor | `9800000011` | Dr. Ravi Sharma | Chakdaha |
| District officer | `9800000020` | Dr. Meera Nair | Nadia district |

For the live-alert demo, the ASHA worker and doctor need to be at the same PHC — use
`9800000001` (Sunita) and `9800000010` (Dr. Ghosh), both Haringhata.

Running this on more than one laptop for a shared demo? See
`prompts/00-SHARED-CONTEXT.md` for how to point multiple frontends at one shared
backend (or one shared MongoDB Atlas instance), since each laptop otherwise runs its
own throwaway in-memory database.

## Deploying

This deploys the **frontend only**, to Firebase Hosting. The backend (Express +
Socket.io + MongoDB) is not a Firebase product and keeps running wherever you already
run it — a laptop on the venue LAN, a small VM, or a platform like Render or Fly. This
mirrors what `prompts/00-SHARED-CONTEXT.md` already asks the team to set up for a
multi-laptop demo (Option 1 there); Hosting is a third option when a LAN address is not
reachable across attendees' phones, or when you want a link that survives you leaving.

```bash
npm i -g firebase-tools     # once, per machine
firebase login              # once, per machine
cp .firebaserc.example .firebaserc
# edit .firebaserc — set your Firebase project id
```

Point the frontend at wherever the API actually runs (Hosting serves static files only,
so there is no dev-server proxy in production):

```bash
# frontend/.env.local (gitignored)
VITE_API_BASE_URL=https://your-backend-host
```

Add that Hosting origin to the backend's `CORS_ORIGINS` (`backend/.env`) — the
Socket.io handshake needs it as much as the REST calls do — then build and deploy:

```bash
npm run deploy:web
```

`firebase.json` (committed) sets the two things that matter for a PWA specifically:
`sw.js` and `firebase-messaging-sw.js` are served `no-cache` so an installed app never
gets stuck on a stale service worker, while everything under `/assets/` is
content-hashed and cached for a year, since a new build always gets a new filename.

Offline reload, PWA install, and the neural second opinion all work identically once
deployed — nothing about Hosting changes how the app runs, it only changes where the
static files are served from.

## Architecture

```
  ml/train_model.{mjs,py}  -->  decision tree fitted on the Pima Indians dataset
           |
           v
  shared/risk/decision_tree_rules.js   (plain JS: the tree + predict function)
           |
     +-----+-----+
     |           |
     v           v
  frontend    backend
  (browser,   (Express
  offline-    API, for
  capable)    audit/sync)
```

The decision tree is trained once (in Node or in scikit-learn — see `ml/README.md`) and
exported as **plain JavaScript**, not served from a Python process. That same file is
imported directly by both the React frontend and the Express backend, so the exact same
tree produces the exact same result whichever side evaluates it.

This is deliberate, for two reasons:

- **Offline is a hard requirement, not a nice-to-have.** An ASHA worker in a village
  with no signal still needs a risk result immediately. A prediction that has to reach a
  Python inference service over the network cannot satisfy that; a function bundled
  into the service-worker-cached PWA can.
- **One less deployable service.** No Python process in the request path means nothing
  else that can be down, misconfigured, or need its own hosting during the demo or in
  production.

Everything else is a conventional split: Express + Socket.io + MongoDB (or an in-memory
Mongo instance for local development) on the backend, a TypeScript/React PWA on the
frontend, with IndexedDB (Dexie) for offline-first local storage and a background sync
queue that flushes once connectivity returns.

### One identity, generated on the device

Every patient and screening record carries a `clientId` — a UUID generated **on the
device, before any network call**. That is what makes the offline path work: a queued
screening can reference a patient the server has never seen, replaying a sync batch
upserts instead of duplicating, and a worker who loses signal mid-visit and retries does
not create a second patient. Using the server's ObjectId as the only identity would make
all three impossible.

Because of that, `POST /api/teleconsult` accepts either `patientId` (the server id, once
synced) or `patientClientId` (the device id). A worker who screened someone while
offline can book a consultation the moment they regain signal, without waiting for a
sync round trip first.

## Two models: tree and a neural second opinion

The decision tree above is trained twice — once in Node, once in scikit-learn — and a
small PyTorch MLP (8 → 16 → 8 → 1, 289 parameters) is trained on the identical rows as a
second opinion, independently cross-checked against a Keras implementation of the same
architecture. All of this is exported to plain JavaScript the same way the tree is: no
tensor runtime ships to the browser, no Python process sits in the request path, and the
neural model runs offline exactly like the tree does.

**The tree decides the risk band. The neural network does not.** Two criteria were fixed
before training (ROC-AUC ≥ 0.83, recall ≥ 0.80) and re-checked on every retrain via
`npm run ml:compare:all`; the trained network did not meet them — it trades away recall,
which is the wrong trade for a screening tool — so it stays a second opinion. It earns its
place two ways instead:

- **Per-feature attributions.** A depth-4 tree can only explain itself with the at most
  four comparisons on the path it happened to take, and has nothing to say about a
  feature it never split on. Integrated gradients attribute the neural score across all
  eight inputs, exactly (the attributions provably sum to the score — see
  `ml/README.md` for how a naive implementation gets this wrong by a few percent).
- **Disagreement as a signal.** When the tree and the network place the same patient in
  different bands, that patient is near a decision boundary — worth a doctor's attention
  sooner. The doctor dashboard surfaces this as a count, separate from (and less alarming
  than) the "device and server disagreed" data-quality warning that already existed.

Full detail — architecture, promotion-gate results, the PyTorch/Keras cross-validation,
and why integrated gradients needed an exact (not sampled) implementation:
[`ml/README.md`](ml/README.md) and [`ml/reports/neural_report.md`](ml/reports/neural_report.md).

## Optional Firebase features

Three Firebase integrations exist, all off unless explicitly configured, and none of
them change the app's behaviour when they are not:

| Feature | What it adds | Configured via |
| --- | --- | --- |
| Phone-OTP sign-in | An SMS code instead of a password. Firebase only proves the phone number; the server exchanges the resulting token for this app's own JWT, so role/PHC scoping and Socket.io are unaffected. | `backend/.env` (`FIREBASE_PROJECT_ID` + credentials) and `frontend/.env.local` (`VITE_ENABLE_PHONE_SIGNIN=true`) |
| Background push (FCM) | Notifies a doctor of a high-risk case when their dashboard tab is **closed**. Socket.io already covers an open tab; this is the fallback the project's brief calls out (SMS alerts, unbuilt because it needs a licensed sender) made buildable a different way. | `PUSH_NOTIFICATIONS_ENABLED=true` plus a Web Push (VAPID) key |
| Hosting | Deploys the frontend to a real URL instead of a LAN address — see [Deploying](#deploying). | `firebase.json` (committed) + your own `.firebaserc` |

Two things worth knowing regardless of whether you turn these on:

- **Recipients for push are computed server-side, from the database, by PHC — never
  from anything the client asserts.** FCM's topic feature would have let a client choose
  its own audience, which would route straight around the cross-PHC isolation
  `check:security` asserts. There is deliberately no endpoint anywhere that accepts a
  PHC, a topic, or a target user for a push registration.
- **Both features degrade to a clear "not configured" response, never a hang or a
  crash.** A screening still succeeds even if a push send fails outright — verified by
  submitting a high-risk case with push configured but the messaging service
  unreachable, which returned 201 in under 100 ms with the failure logged, not thrown.

See `backend/.env.example` and `frontend/.env.example` for the full list of variables,
including how to point at the local Firebase Auth emulator for development with no
project and no SMS quota.

## Scope

| Built and working | Optional, off by default | Simulated for the demo | Out of scope |
| --- | --- | --- | --- |
| ML training + JS export (`ml/`) — reproducible, held-out accuracy 71.4%, recall 77.8%, ROC-AUC 0.806 | Firebase phone-OTP sign-in — real token exchange, verified with the config unset and with the Auth emulator; a genuine SMS round trip needs a real project | Teleconsult video call — booking, queue and live PHC notification are real; there is no WebRTC/Twilio and `sessionId` is prefixed `sim-`. Every response says so via `isSimulated: true` | ABDM / NDHM health-ID interoperability |
| Neural second opinion (`ml/train_neural.py`) — PyTorch, cross-validated against Keras, exported to JS the same way the tree is | Background push notifications (FCM) — server-side recipient resolution verified, a screening verified to succeed even when the push send fails; real delivery to a browser needs a live project and Web Push certificate | SMS fallback alerts — designed for, not integrated (needs a licensed, DLT-registered Indian sender) | OCR of printed vitals (voice input covers the need) |
| `shared/risk/` scoring engine — demo case (glucose 165, BMI 31, family history) returns HIGH, 95%, with correct reasons | Firebase Hosting for the frontend | | Encryption beyond HTTPS + bcrypt + JWT |
| `shared/chatbot/` FAQ — 30/30 intent-matching cases across Bengali, Hindi, English | | | |
| Backend API + Socket.io — 79/79 assertions pass, including live high-risk alerts, idempotent offline sync, and cross-PHC access isolation | | | |
| Frontend typecheck and production build (PWA, service worker, offline caching) | | | |

`GET /api/teleconsult/capabilities` returns the simulated/out-of-scope disclosures as
JSON, so the limitation is visible in the product itself, not only in this table.

## The model limitation

The risk model is trained on the Pima Indians Diabetes dataset — 768 records, adult Pima
Native American women. That is not an Indian population, and the app is explicit about
this rather than hiding it. What transfers across populations is the *direction* of the
relationships: higher glucose, higher BMI, older age and family history all raise risk.
What does not transfer is *calibration*, so the tree's internal thresholds are not
presented as validated clinical advice. The plain-language explanations use Indian
clinical reference ranges instead (WHO Asian-Indian BMI cut-offs of 23 and 25, rather
than the international 25 and 30). A real deployment would retrain on ICMR-INDIAB or
NFHS-5 cohort data. Held-out accuracy is 71%, recall 78%, ROC-AUC 0.81 — recall is
deliberately higher than precision, because for a screening tool a missed diabetic
matters more than a false alarm.

What makes the bands usable despite the calibration caveat is that they separate
monotonically on held-out data — a patient the model puts in HIGH really is far more
likely to be diabetic than one it puts in LOW:

| Band | Patients | Actually diabetic | Rate |
| --- | --- | --- | --- |
| LOW | 74 | 11 | 14.9% |
| MODERATE | 14 | 3 | 21.4% |
| HIGH | 66 | 40 | 60.6% |

That ordering is the point. It means the bands carry real triage information rather than
being arbitrary cut-offs, which is what a PHC actually needs to decide who to see first.

One more detail worth knowing: the dataset's `Glucose` column is a 2-hour oral glucose
tolerance test value, not a fasting reading. The assessment form asks which kind of
sample was taken and interprets the plain-language explanation accordingly.

Full detail, including the fitted tree, per-leaf breakdown and the risk-band separation
on held-out data: [`ml/README.md`](ml/README.md) and
[`ml/reports/training_report.md`](ml/reports/training_report.md).

## Repository layout

```
ml/         Model training — the decision tree (Node + scikit-learn trainers) AND the
             neural second opinion (PyTorch + Keras cross-validation) — plus the JS
             export both produce. Nothing here runs at request time.
shared/     Clinical/scoring logic (risk engine, including the neural second opinion)
             and the chatbot FAQ rules, imported by both the frontend and the backend so
             there is exactly one implementation.
backend/    Express API, Socket.io realtime layer, Mongoose models, the optional
             Firebase integrations (config/firebase.js, services/pushService.js), and
             the verification scripts (check-demo-flow.mjs for the demo path,
             check-security.mjs for role isolation, Firebase auth, push registration
             and rate limiting).
frontend/   TypeScript/React PWA — the ASHA worker's field app, the PHC doctor's
             dashboard, and the district officer's trends view. lib/firebaseAuth.ts and
             lib/pushMessaging.ts are dynamically imported only, so the Firebase SDK
             never enters the offline-cached bundle.
prompts/    The three-person work-division briefs used to build this project, and the
             record of what is verified working versus what is unverified. Not needed to
             run the app, but useful context for anyone continuing the work.
firebase.json, .firebaserc.example
            Firebase Hosting config for the frontend only — see Deploying above.
```
