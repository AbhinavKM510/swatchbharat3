# Person A — ML, shared engine, backend API

> Read `prompts/00-SHARED-CONTEXT.md` first.
>
> You own: `ml/**`, `shared/**`, `backend/**`, root `README.md`.
> Do not edit anything under `frontend/src/` except by asking Person B or C.

Your area is the one that is already verified working (**73/73** API assertions pass — the
teleconsult-blocking bug described below, formerly BUG-1, is already fixed and has its own
regression check). So your job is **less about building and more about (a) closing the one
remaining gap in the teleconsult flow, (b) making the model story defensible, and (c) being
the person who can answer any question about how the risk score works.**

Work through these in order. Each task has an acceptance check — run it before moving on.

---

## A1 — Confirm your baseline still passes (10 min)

Do this first so you know any later failure is yours.

```bash
npm install --prefix backend
Copy-Item backend/.env.example backend/.env    # if you do not have backend/.env yet
# edit backend/.env: set JWT_SECRET to any long random string
npm run dev:api          # terminal 1
npm run check:api        # terminal 2
```

**Accept when:** `73 passed, 0 failed`.

Also re-run the trainer to confirm the ML pipeline is reproducible on your machine:

```bash
npm run train
```

**Accept when:** it prints held-out accuracy ≈ 0.714 and recall ≈ 0.778, and rewrites
`ml/export/decision_tree_rules.js` plus `shared/risk/decision_tree_rules.js` identically
(check `git diff` — it should show only the `generatedAt` timestamp changing).

### Why there are two trainers, and which one you can trust

There is no Python on the laptop this was built on — `python.exe` resolves only to the Windows
Store stub and `py.exe` does not exist. So:

- **`ml/train_model.mjs` (Node) is what produced every committed artefact.** It was run, and
  the metrics quoted throughout this repo are measured output from it, not estimates. It
  implements CART directly in `ml/lib/cart.mjs` (~200 lines: gini, midpoint splits, balanced
  class weights) so a reviewer can confirm the tree really is fitted from data.
- **`ml/train_model.py` (scikit-learn) has never been executed.** It is the reference
  implementation and it is written to produce the identical artefact format, but treat it as
  **unverified code**. One broken f-string was already found and fixed by inspection; assume
  there may be another.

Note that Python being absent does *not* affect the running product at all. The spec always
called for the tree to be exported to plain JS with no Python service at runtime — that is why
the prediction can run offline in the browser in the first place.

**Optional, worth ~20 minutes if you have Python:** install it, then

```bash
python -m pip install -r ml/requirements.txt
python ml/train_model.py
```

Two possible outcomes, both useful:

1. It runs and produces metrics close to the Node trainer's → you have independently confirmed
   the model, and can tell a judge the tree was validated by scikit-learn. Commit whichever
   artefact you prefer.
2. It errors → fix it, because it is the script anyone retraining on ICMR-INDIAB or NFHS-5
   data will reach for first.

Expect **close but not identical** numbers either way: the two trainers shuffle their
stratified train/test split differently, so the trees are equivalent in method rather than
byte-for-byte. If the metrics come out wildly different (say accuracy below 0.65 or above
0.80), something is wrong — investigate rather than shipping it.

---

## A2 — Already fixed, just confirm it (5 min)

The teleconsult-booking 404 (device never learning the server-side patient id) is fixed:
`ingestAssessmentBatch` in `assessmentService.js` now returns `patientId` on every result
entry, and there is a regression assertion for it in `check-demo-flow.mjs` section 5
("sync results include a usable patientId..."). Confirm it is present in your `npm run
check:api` output and move on — no work needed here unless that assertion fails.

---

## A3 — Make the teleconsult booking work without a synced patient id yet (20 min)

This one is still open. There is a real scenario A2's fix does not cover: the worker is
**offline**, so the record has never synced, so there is no server-side patient id at all —
yet the UI wants to offer "book consultation" the moment they come back online, before the
sync round trip that would populate it.

Add an alternative lookup: allow `POST /api/teleconsult` to accept
`patientClientId` (the device UUID) **instead of** `patientId`, and resolve the patient by
`clientId`. Keep `patientId` working as well.

Why this is the right fix rather than a UI workaround: the device-generated `clientId` is
already the identity the whole offline system is built on. Making the teleconsult endpoint
speak the same language removes a special case instead of adding one.

**Accept when:** booking succeeds given only `patientClientId`, and still succeeds given
only `patientId`. Add both as assertions to `check-demo-flow.mjs`.

---

## A4 — Write the root `README.md` (45 min)

This is the first thing a judge or a new teammate opens, and right now it does not exist.

It must cover, in this order:

1. **One-paragraph problem statement** — rural diagnostics gap, PHC overload, ASHA workers
   with no decision support.
2. **What it does** — 6-step demo flow, as a numbered list.
3. **Quick start** — the exact commands from `prompts/00-SHARED-CONTEXT.md`, including
   the demo logins table.
4. **Architecture** — a small diagram or bullet list showing that the trained tree is
   exported to plain JS and runs in **both** the browser and the API, with no Python service
   at runtime. Explain why (offline + one less deployable).
5. **An honest scope table** with three columns: *Built and working*, *Simulated for the
   demo*, *Out of scope*. Copy the content from `00-SHARED-CONTEXT.md`. Do not soften it.
6. **The model limitation**, stated plainly, with a link to `ml/README.md`.
7. **Repository layout** — what lives in `ml/`, `shared/`, `backend/`, `frontend/`,
   `prompts/`.

**Accept when:** someone who has never seen the repo can clone it, follow the README only,
and reach a working login screen. Test this by having Person B or C follow it verbatim on
their laptop and tell you where they got stuck.

---

## A5 — Harden the two things a judge will poke at (30 min)

These are cheap and they are exactly what a technical judge tries.

1. **Rate limiting on `/api/auth/login` is 30 per 10 minutes.** Confirm it actually
   triggers (`for ($i=0; $i -lt 35; $i++) { ... }`) and returns `TOO_MANY_ATTEMPTS`, not a
   500.
2. **Confirm role isolation by hand**, not just via the test script. Log in as
   `9800000011` (Dr. Sharma, Chakdaha) and try to fetch an assessment id belonging to
   Haringhata. You should get `403 OUT_OF_SCOPE`. Being able to demonstrate this live is
   worth more than describing it.

**Accept when:** you can show both from a terminal in under 30 seconds.

---

## A6 — Prepare the model explanation you will be asked for (30 min)

You are the person who answers model questions. Get these to the point where you can pull
them up instantly:

- `ml/reports/training_report.md` — has the ASCII tree, per-leaf table, confusion matrix,
  and the risk-band separation table (LOW 14.9% → MODERATE 21.4% → HIGH 60.6% actually
  diabetic on held-out data). **That monotonic separation is your strongest single number**:
  it shows the bands mean something rather than being arbitrary cut-offs.
- `GET /api/model` — the model card as JSON, public, no auth. Have it open in a browser tab.
- `GET /api/model/tree` — the fitted tree itself.

Be ready to explain, in one sentence each:

- Why a depth-4 decision tree and not gradient boosting → explainability is the product.
- Why `class_weight="balanced"` → screening should prefer a false alarm to a missed case.
- Why zeros in the dataset are treated as missing → a BMI of 0 is not a measurement.
- Why family history is binarised **at training time** → the form asks a yes/no question, so
  training on the continuous pedigree score and serving a fake score would be train/serve
  skew.

**Accept when:** you can deliver the dataset-limitation paragraph from
`00-SHARED-CONTEXT.md` from memory, without notes.

---

## A7 — Stretch, only if A1–A6 are done

Pick in this order. Stop when time runs out; none of these are required.

1. **Second disease: hypertension risk.** You already collect diastolic BP, age, BMI and
   family history. A rule-based hypertension flag (not ML) reusing the same explanation
   structure would let you say "the platform is not diabetes-specific" with something real
   behind it. Put it in `shared/risk/hypertension.js` with the same reason-code shape.
2. **`GET /api/chatbot/unmatched`** already exists and returns the questions the rules
   failed to answer. Surface the count in the district dashboard payload so Person C can
   display it — it demonstrates a feedback loop rather than a static bot.
3. **Retrain with `max_depth=5`** and compare. If recall improves without accuracy dropping,
   ship it; if not, you have a documented reason for keeping depth 4, which is a better
   answer than "we picked 4".

---

## Things you should NOT do

- Do not switch the backend to TypeScript. It works, it has no build step, and rewriting it
  costs hours and buys nothing before the deadline.
- Do not add a Python inference service. The whole point of exporting the tree to JS is that
  there is no Python in the request path.
- Do not implement real WebRTC or a real SMS gateway. They are explicitly out of scope and
  the app already discloses that they are simulated.
- Do not "clean up" `frontend/`. Not your files, and you will conflict with B and C.
