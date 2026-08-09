# SwasthBharat

AI-powered early disease risk screening and rural health access — built for ASHA field
workers, PHC doctors, and district health officers.

## The problem

Rural India's diagnostic gap isn't a lack of health workers — it's a lack of decision
support at the point of contact. ASHA workers visit villages with no way to tell a
routine visit from an urgent one, and PHCs are too overloaded to know who to see first.
SwasthBharat gives a field worker with a phone a plain-language risk read at the moment
of the visit, and gives the PHC a live feed of who needs attention first — designed to
keep working even when the network doesn't.

## What it does

- ASHA worker enters a patient's vitals (glucose, BP, height/weight, family history) in
  Bengali, Hindi, or English — by voice or typing.
- Instantly get a risk band (LOW / MODERATE / HIGH) with plain-language reasons, not
  just a number.
- High-risk cases can be booked for a consultation, and the PHC dashboard sees the new
  case appear **live** (Socket.io), no refresh needed.
- Works offline: a screening taken with no signal is saved on the device and synced
  automatically once connectivity returns — no data loss, no duplicates.
- A rule-based FAQ chatbot answers common questions in all three languages.
- A small neural network gives a second opinion alongside the decision tree, and
  explains which factors drove its score.

## Quick start

> The app itself lives in the
> [`SwasthBharat-b0a58f121e010d5422105d2f71cb400eea165949/`](./SwasthBharat-b0a58f121e010d5422105d2f71cb400eea165949)
> folder. Run all commands below from inside it.

Requires **Node.js 20+**. No Python needed — the ML model ships as plain JavaScript.

```bash
npm run setup                            # installs backend + frontend deps
cp backend/.env.example backend/.env     # PowerShell: Copy-Item backend/.env.example backend/.env
```

Open `backend/.env` and set `JWT_SECRET` to any long random string (everything else can
stay as-is — the app runs against an in-memory database by default, no MongoDB setup
needed).

Then, in two terminals:

```bash
npm run dev:api      # http://localhost:4000
npm run dev:web      # http://localhost:5173
```

Open `http://localhost:5173` and log in with one of the demo accounts below. Demo data
is seeded automatically on first API startup.

### Demo logins

Password `demo1234` for every account.

| Role | Phone | Name | PHC |
| --- | --- | --- | --- |
| ASHA worker (Bengali) | `9800000001` | Sunita Das | Haringhata |
| ASHA worker (Hindi) | `9800000002` | Rekha Kumari | Chakdaha |
| PHC doctor | `9800000010` | Dr. Arun Ghosh | Haringhata |
| PHC doctor | `9800000011` | Dr. Ravi Sharma | Chakdaha |
| District officer | `9800000020` | Dr. Meera Nair | Nadia district |

To see the live-alert flow, open the ASHA worker (`9800000001`) and the doctor
(`9800000010`) in two tabs — they're at the same PHC — submit a high-risk screening as
the worker, and watch it appear instantly on the doctor's dashboard.

### Verifying it works

```bash
npm run check:api        # 79 assertions covering the full demo flow
```

## Architecture, in short

```
  ml/  -->  decision tree trained on health data
             |
             v
  shared/risk/decision_tree_rules.js   (plain JS: same tree, same result everywhere)
             |
        +----+----+
        |         |
        v         v
    frontend   backend
   (browser,   (Express
   offline-    API, for
   capable)    audit/sync)
```

The risk model is trained once and exported as plain JavaScript, imported by both the
React frontend and the Express backend. That means the exact same prediction runs
**offline, in the browser** — no Python inference server, no network dependency for a
result at the point of care.

Everything else is a standard stack: Express + Socket.io + MongoDB (in-memory for local
dev) on the backend, a TypeScript/React PWA on the frontend, with offline-first local
storage (Dexie/IndexedDB) and a background sync queue.

## Honest scope

| Fully working | Simulated for the demo | Not built |
| --- | --- | --- |
| Risk model + explanations, offline scoring | Teleconsult video call — booking and live PHC notification are real, the call itself is a placeholder screen | ABDM/NDHM health-ID interoperability |
| Live dashboard alerts via Socket.io | SMS fallback alerts — needs a licensed sender | OCR of printed vitals (voice input covers this) |
| Offline capture + sync, no duplicate records | | |
| FAQ chatbot in 3 languages | | |
| Neural network second opinion with per-feature explanations | | |

Optional features (phone-OTP login, push notifications, Firebase Hosting deploy) exist
but are off by default and never required to run or judge the app — see
`backend/.env.example` and `frontend/.env.example` if you want to enable them.

## The model's limitation, upfront

The risk model is trained on the Pima Indians Diabetes dataset (768 records, adult Pima
women) — not an Indian population. What transfers across populations is the
*direction* of the relationships (higher glucose, BMI, age, and family history all
raise risk); what doesn't transfer is exact calibration. The app uses Indian clinical
reference ranges (WHO Asian-Indian BMI cut-offs) in its explanations, and a real
deployment would retrain on Indian cohort data (ICMR-INDIAB or NFHS-5). Held-out
accuracy is 71%, recall 78% — recall is deliberately prioritized, since for a screening
tool a missed case matters more than a false alarm.

More detail on the model, training, and full architecture rationale: see
[`ml/README.md`](./SwasthBharat-b0a58f121e010d5422105d2f71cb400eea165949/ml/README.md).

## Repository layout

```
ml/         Model training (decision tree + neural network) and the JS export both produce.
shared/     Risk-scoring engine and chatbot FAQ rules — shared by frontend and backend.
backend/    Express API, Socket.io, MongoDB models, verification scripts.
frontend/   TypeScript/React PWA — ASHA app, doctor dashboard, district trends view.
```
