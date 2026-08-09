# MAIN_PROMPT — AI-Powered Early Disease Risk Prediction & Rural Health Access Platform

> **Status:** this is the original project brief, kept for reference.
> For **current state and who is doing what**, read [`prompts/00-SHARED-CONTEXT.md`](prompts/00-SHARED-CONTEXT.md).

## Problem statement (IEMH4-HC-01)

Rural and semi-urban India lacks timely diagnostics. Chronic diseases (diabetes,
hypertension, cardiovascular disease, anaemia) are caught late because PHCs (Primary Health
Centres) are overloaded and ASHA/ANM workers have no digital decision-support tools. This
platform predicts early-stage disease risk from easily collectible data and connects at-risk
patients to the nearest care — built specifically for low-connectivity, low-literacy rural
users.

## Target users

- **ASHA/ANM workers** — village-level health workers, low digital literacy, used in the field
- **Patients** — often low-literacy, prefer speaking over typing, intermittent or no internet
- **PHC doctors** — need a dashboard of flagged high-risk patients in their area
- **District health officers** — need trend visibility across multiple PHCs

## Scope decisions

A 36-hour hackathon build. Not everything gets built to production quality.

### Build for real — must work end to end in the demo

1. Diabetes risk-assessment form → explainable ML prediction (decision tree)
2. Offline-first PWA — record entry works with no internet, syncs when back online
3. PHC dashboard — real-time list of flagged high-risk patients, live-updating
4. Voice input for vitals entry (browser Web Speech API; Hindi, Bengali, English)
5. In-app real-time alert to the PHC dashboard when a patient is flagged high risk (Socket.io)
6. Basic rule-based FAQ chatbot in Hindi, Bengali and English

### Fake for the demo — UI exists, no real backend logic; say so if asked

1. Teleconsultation — booking UI plus a fake "connecting…" screen and call layout. No real
   WebRTC or Twilio.
2. SMS fallback alerts — mentioned in the pitch as "designed for"; no SMS API integration.

### Skip entirely — future work in the pitch only

1. ABDM/NDHM interoperability — genuinely out of scope for 36 hours
2. OCR for scanning printed vitals — voice input covers this need
3. Real encryption infrastructure beyond standard HTTPS, bcrypt and JWT

## Disease focus: diabetes (v1)

Using the Pima Indians Diabetes public dataset for prototype training.

**Known limitation, to be stated upfront in the pitch:** this dataset is sourced from Pima
Native American women, not an Indian population. The feature relationships (glucose, BMI, age,
family history → risk) are medically valid cross-population, but this is a prototype. Real
deployment would retrain on ICMR-INDIAB or NFHS-5 data. State this explicitly if judges ask —
it shows rigour, not weakness.

Dataset columns: `Pregnancies`, `Glucose`, `BloodPressure`, `SkinThickness`, `Insulin`, `BMI`,
`DiabetesPedigreeFunction`, `Age`, `Outcome` (0/1).

Mapped to a health-worker-friendly form:

| Dataset column | Form field |
| --- | --- |
| `Glucose` | "Blood sugar level (mg/dL)" |
| `BloodPressure` | "Diastolic BP (mm Hg)" |
| `BMI` | calculated from height and weight (worker enters both, app computes BMI) |
| `DiabetesPedigreeFunction` | simplified to "Do you have a parent/sibling with diabetes?" (Yes/No) |
| `Age` | direct input |
| `Pregnancies` | only shown for female patients |
| `SkinThickness` / `Insulin` | often missing in the field; dataset median used as default if absent, and the explanation says so |

> **Implementation note added during the build:** rather than converting the Yes/No family
> history answer into a fake pedigree score at serving time, the feature is binarised **at
> training time** at the train-split median. Training and serving therefore see the same
> feature definition, avoiding train/serve skew. See `ml/README.md`.

## Language support

Primary: **Bengali, Hindi**. Fallback: **English**.

All patient- and worker-facing UI text (form labels, chatbot, risk explanations, voice
prompts) uses translation keys, with a `translations.json` per language, built in from the
start rather than bolted on later.

## Tech stack

- **Frontend** — React + Vite + TypeScript, PWA via `vite-plugin-pwa`, offline storage via
  `dexie` (IndexedDB wrapper)
- **Backend** — Node.js + Express + MongoDB Atlas + Mongoose
- **Real-time alerts** — Socket.io
- **ML** — Python + scikit-learn (`DecisionTreeClassifier`) trained offline, with the trained
  tree's logic ported to plain JS. No Python server at runtime: it removes a whole deployable
  service and lets the prediction run offline in the browser.
- **Voice** — browser-native Web Speech API (no install, no API key)
- **Auth** — JWT + bcrypt

## Folder structure

```
SwasthBharat/
├── README.md
├── MAIN_PROMPT.md              (this file)
├── frontend/                   React PWA — ASHA worker + patient + doctor views
├── backend/                    Express API + Socket.io + MongoDB models
├── shared/                     risk engine + chatbot rules, imported by BOTH sides
│   ├── risk/
│   └── chatbot/
├── ml/                         Python training script + exported decision tree logic
│   ├── train_model.py
│   ├── train_model.mjs         Node equivalent (no Python toolchain needed)
│   ├── data/                   dataset
│   ├── export/                 outputs decision_tree_rules.js
│   └── reports/                training report
└── prompts/                    sub-prompts, one per person
```

> `shared/` was added during the build and is not in the original plan. It exists because the
> risk engine and chatbot rules must be byte-identical in the browser and on the API — if they
> ever diverged, a patient could be shown one risk level in the field and a doctor a different
> one on the dashboard.

## Demo flow

1. ASHA worker opens the PWA (works with Wi-Fi toggled off) and speaks or types a patient's
   vitals in Bengali or Hindi
2. Risk engine returns: "HIGH RISK — because: blood sugar 165 mg/dL (elevated), BMI 31 (obese
   range), family history present" — plain language, not a percentage alone
3. Patient or worker taps "Book consultation" → fake connecting screen → call UI
4. Simultaneously the PHC dashboard, open on a second screen, shows the new high-risk case
   appear live via Socket.io, with no refresh
5. Worker asks the chatbot in Bengali "what should I eat if I have high sugar?" and gets a
   rule-based answer
6. Turn off Wi-Fi mid-demo, add another patient record, turn Wi-Fi back on, and show it sync
   automatically — this single moment is the strongest proof point

## Team split (3 people)

- **Person A** — ML (`ml/`), decision tree → JS export, backend API routes
- **Person B** — frontend PWA: forms, offline sync, voice input, i18n
- **Person C** — dashboard, Socket.io real-time alerts, chatbot, teleconsult UI

Each brief in `prompts/` maps to one of these areas. Feed the relevant one to Kiro depending
on who is driving that module.
