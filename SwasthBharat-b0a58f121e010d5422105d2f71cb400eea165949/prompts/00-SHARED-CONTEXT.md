# 00 — Shared context (all three people read this first)

Read this once before you touch anything. It is the only place that records what is
**actually built and verified** versus what is **built but never run**. Getting that
distinction wrong is how three people spend an hour re-doing finished work.

---

## Where the project actually is

The build is roughly 90% written. This is **not** a "start coding" phase. It is a
**run it, find the runtime bugs, fix, rehearse** phase.

### Verified working (do not rebuild these)

| Area | Status | How it was verified |
| --- | --- | --- |
| `ml/` training + JS export | Working | `node ml/train_model.mjs` runs. Held-out accuracy **71.4%**, recall **77.8%**, ROC-AUC **0.806**. |
| `shared/risk/` engine | Working | Demo case (glucose 165, BMI 31, family history) returns **HIGH, 95%** with the expected reasons. |
| `shared/chatbot/` FAQ | Working | 30/30 intent-matching cases pass across Bengali, Hindi, English. |
| Backend API + Socket.io | Working | `npm run check --prefix backend` → **73/73 assertions pass**, including the live high-risk alert, idempotent offline sync, and cross-PHC access isolation. |
| Frontend typecheck | Passes | `npx tsc --noEmit` → clean. |
| Frontend production build | Passes | `npx vite build` → succeeds, service worker generated, 15 precache entries, 456 KB JS (156 KB gzipped). |

One exception inside `ml/`: **`train_model.py` has never been executed**, because there is no
Python on the machine this was built on. The Node trainer (`train_model.mjs`) produced every
committed artefact and every metric quoted in this repo. The Python script is the scikit-learn
reference and should be treated as unverified code — see task A1 in Person A's brief. This does
not affect the running product, which contains no Python by design.

### Built but NEVER RUN IN A BROWSER

**Nobody has opened the frontend.** It compiles and builds, and that is all we know.
Everything below is unverified and is the bulk of the remaining work:

- Does login actually work end to end
- Does the assessment form submit and score
- Does Dexie/IndexedDB actually persist
- Does the socket connect from the browser and does the dashboard update live
- **Does offline mode actually work** (the single most important demo moment)
- Does the PWA install
- Does voice input work
- Does Bengali and Hindi text render correctly

Assume there are runtime bugs. There always are.

### Not written at all

- Root `README.md` (Person A owns this)
- Any rehearsal of the demo

---

## Bugs found by code review — ALL FOUR ARE NOW FIXED

These were identified and fixed before handoff. Verified: backend re-run to **73/73**
(one new regression assertion added), frontend `tsc --noEmit` clean, `vite build` still
succeeds. You do not need to fix these — just know they existed, in case you see references
to them elsewhere (e.g. in git history) or want to understand a past decision.

### BUG-1 — Teleconsult booking would 404 (fixed)

`ingestAssessmentBatch` in `backend/src/services/assessmentService.js` now returns
`patientId` on every sync result entry. `frontend/src/lib/sync.ts` passes it into
`markSynced`, and `SyncResultEntry` in `types.ts` carries the field. A regression check was
added to `backend/scripts/check-demo-flow.mjs` (section 5) so this cannot silently break
again — if you touch the sync response shape, run `npm run check:api` before committing.

### BUG-2 — Home screen counters capped at 10 (fixed)

Added `getHomeStats(userId)` to `frontend/src/lib/db.ts`, which scans the full
`[userId+capturedAt]` index rather than the capped "recent" list. `AshaHomePage` now sources
its "today" and "high risk" cards from that instead of `.filter()`-ing the truncated array.

### BUG-3 — Duplicate import (fixed)

`frontend/src/App.tsx` had two separate `import ... from 'react-router-dom'` statements.
Merged into one.

### BUG-4 — Dead socket cleanup logic (fixed)

Removed the no-op `useEffect(() => () => { if (!user) disconnectSocket(); }, [user])` from
`DoctorDashboardPage`. The socket disconnects on logout via `AuthContext.logout()`, which is
the only place it should.

---

## The one thing that will break your demo if you ignore it

**By default each laptop runs its own throwaway in-memory database.**

`backend/.env` ships with `USE_IN_MEMORY_DB=true`. That database lives inside the Node
process and is discarded on shutdown. Three laptops running three backends means **three
separate universes** — the ASHA worker on laptop B will submit a screening and the doctor on
laptop C will never see it, and you will waste your demo slot debugging Socket.io that is
working perfectly.

You have two options. Pick one **today**, not on demo day.

### Option 1 (recommended for the demo): one shared backend

One laptop runs the API. The others point their frontend at it.

On the API laptop, in `backend/.env`:

```
CORS_ORIGINS=http://localhost:5173,http://192.168.x.x:5173,http://192.168.x.y:5173
```

On the other laptops, create `frontend/.env.local`:

```
VITE_API_BASE_URL=http://192.168.x.x:4000
```

Find the API laptop's LAN IP with `ipconfig` (look for IPv4 Address on your Wi-Fi adapter).
The Vite dev server already binds to `0.0.0.0` (`host: true`), so this works.

Caveat: `crypto.randomUUID()` needs a secure context. `localhost` counts; a plain-HTTP LAN
address does not. The app already falls back to a timestamp-based id
(`newId()` in `AssessmentFormPage.tsx`), so it works — but be aware of it.

### Option 2: shared MongoDB Atlas

Everyone sets the same `MONGO_URI` in their own `backend/.env` and
`USE_IN_MEMORY_DB=false`. Free tier is fine. More realistic, and it survives restarts, but
it depends on the venue network reaching Atlas. **Test this before the venue.**

### Option 3: Firebase Hosting for the frontend + one shared backend

This is the same idea as Option 1 (one shared backend, everyone's browser talks to it) but
with the frontend deployed to a real URL instead of one laptop's LAN address. Useful when
the venue Wi-Fi is client-isolated (phones on the same Wi-Fi cannot reach each other's LAN
IPs — common on conference/venue networks) or when you want a link you can hand a judge
that works after you leave. See "Deploying" in the root `README.md` for the exact steps.
The backend still needs to be reachable from wherever Hosting serves the page, so add the
deployed origin to `CORS_ORIGINS` the same way you would a LAN IP.

---

## Working on three laptops from one folder

Use git. Do not sync via a shared drive — two editors writing the same file over Dropbox
will silently destroy work.

```bash
# once, on one laptop
git init
git add .
git commit -m "SwasthBharat: ml, shared engine, backend, frontend scaffold"
# push to a private repo, then the other two clone it
```

Then per person:

```bash
git checkout -b person-a-backend     # or person-b-frontend / person-c-dashboard
# ... work ...
git add <specific files>
git commit -m "..."
git push -u origin person-a-backend
```

Merge into `main` through pull requests, or just merge locally — but **merge often**, at
least every 90 minutes. Three branches diverging for six hours is how hackathon teams lose
their last two hours to conflict resolution.

### First-time setup on each laptop

```bash
npm run setup                      # installs backend + frontend deps
cp backend/.env.example backend/.env    # PowerShell: Copy-Item backend/.env.example backend/.env
# edit backend/.env — at minimum set JWT_SECRET to any long random string
```

Then two terminals:

```bash
npm run dev:api      # http://localhost:4000
npm run dev:web      # http://localhost:5173
```

Demo logins (password `demo1234` for all):

| Role | Phone | Name | PHC |
| --- | --- | --- | --- |
| ASHA worker (Bengali) | `9800000001` | Sunita Das | Haringhata |
| ASHA worker (Hindi) | `9800000002` | Rekha Kumari | Chakdaha |
| PHC doctor | `9800000010` | Dr. Arun Ghosh | Haringhata |
| PHC doctor | `9800000011` | Dr. Ravi Sharma | Chakdaha |
| District officer | `9800000020` | Dr. Meera Nair | Nadia district |

The server **seeds itself** on startup when the in-memory database is empty. You do not
need to run the seed script separately in that mode.

For the live-alert demo the ASHA worker and the doctor must be at the **same PHC** —
use `9800000001` (Sunita) and `9800000010` (Dr. Ghosh), both Haringhata.

---

## File ownership — read this to avoid merge conflicts

Three people, one repo. Stay inside your own column.

| Owner | Owns |
| --- | --- |
| **Person A** | `ml/**`, `shared/**`, `backend/**`, root `README.md` |
| **Person B** | `frontend/src/pages/{AssessmentFormPage,RiskResultPage,AshaHomePage,LoginPage}.tsx`, `frontend/src/components/{forms,VoiceInputButton,ui}.tsx`, `frontend/src/lib/{db,sync,speech}.ts`, `frontend/src/i18n/**` |
| **Person C** | `frontend/src/pages/{DoctorDashboardPage,DistrictTrendsPage,ChatbotPage,TeleconsultPage,PatientsPage,ModelCardPage}.tsx`, `frontend/src/components/{charts,risk}.tsx`, `frontend/src/lib/socket.ts` |

**Shared files — announce in chat before editing:**
`frontend/src/App.tsx`, `frontend/src/types.ts`, `frontend/src/index.css`,
`frontend/src/components/AppShell.tsx`, `frontend/src/lib/api.ts`, `frontend/package.json`

Rule for `frontend/src/i18n/locales/*.json`: **Person B owns the files**, but A and C add
keys freely. Append new keys at the end of the relevant section rather than reformatting,
and JSON merge conflicts stay trivial.

---

## Conventions already established — follow them

1. **Backend is plain JavaScript ESM.** No TypeScript, no build step. `import`/`export`,
   `.js` extensions on relative imports.
2. **Frontend is TypeScript, strict.** `npx tsc --noEmit` must stay clean.
3. **Never hardcode user-facing text.** Every string goes through `t('some.key')` and into
   all three locale files. There is a dev-time audit that logs missing keys to the console.
4. **Clinical and scoring logic lives in `shared/`**, never duplicated in the frontend or
   backend. If both sides need it, it belongs in `shared/`.
5. **Errors carry stable codes, not messages.** The API returns
   `{ error: { code, message } }`; the UI translates from `code`.
6. **Write locally first, sync second.** Any new user data must hit IndexedDB before any
   network call. This is the offline guarantee.
7. **Faked features must say they are faked, in the UI.** Teleconsult already does this.
   Keep it that way.

---

## What is intentionally fake or absent — do not "fix" these

Per the scope decision, these are deliberate. Do not spend time on them, and be honest
about them if a judge asks.

| Feature | State |
| --- | --- |
| Teleconsult video call | **UI only.** No WebRTC, no Twilio. `sessionId` is prefixed `sim-`. Every API response carries `isSimulated: true` and a `simulationNotice`. |
| SMS fallback alerts | **Not integrated.** Pitch as "designed for". Needs a DLT-registered Indian sender. |
| ABDM / NDHM interoperability | **Out of scope.** Future work. |
| OCR of printed vitals | **Out of scope.** Voice input covers the need. |
| Encryption beyond HTTPS + bcrypt + JWT | **Out of scope.** |

`GET /api/teleconsult/capabilities` returns this list as JSON, so the disclosure is in the
product and not only in the deck.

---

## The dataset limitation — everyone must be able to say this out loud

If a judge asks about the model, any of the three of you should be able to answer:

> It is trained on the Pima Indians Diabetes dataset — 768 records, adult Pima Native
> American women. That is not an Indian population, and we are explicit about it in the app
> itself. What transfers across populations is the direction of the relationships: higher
> glucose, higher BMI, older age and family history all raise risk. What does not transfer
> is calibration, so we do not present the tree's internal thresholds as clinical advice.
> The plain-language explanations use Indian clinical reference ranges instead — WHO
> Asian-Indian BMI cut-offs of 23 and 25 rather than the international 25 and 30. Production
> would retrain on ICMR-INDIAB or NFHS-5 cohort data. Held-out accuracy is 71%, recall 78%,
> ROC-AUC 0.81, and recall is deliberately higher than precision because for screening a
> missed diabetic is worse than a false alarm.

Also worth knowing: the dataset's `Glucose` column is a **2-hour oral glucose tolerance
test** value, not a fasting reading. The form asks which kind of sample was taken and
interprets the explanation accordingly. That detail tends to impress people who know the
dataset.

Full detail: `ml/README.md` and `ml/reports/training_report.md`.

---

## Definition of done for the whole team

The demo script below runs start to finish, twice, without a developer touching a keyboard
to fix anything:

1. ASHA worker opens the PWA, switches to Bengali, dictates or types a patient's vitals
2. Result shows **HIGH RISK** with plain-language reasons, not just a percentage
3. Tap "Book consultation" → connecting screen → call UI
4. The PHC dashboard on a second laptop shows the new case appear **live**, no refresh
5. Chatbot answers a Bengali question about diet
6. **Wi-Fi off → add another patient → Wi-Fi on → it syncs by itself**

Step 6 is the strongest proof point in the whole build. Rehearse it more than the others.
