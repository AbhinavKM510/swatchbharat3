# SwasthBharat — Architecture & Workflow (Presentation Notes)

This document is written to be turned directly into slides. Each section below maps
roughly to one slide or slide group.

---

## 1. One-line pitch

SwasthBharat is an offline-first diabetes risk screening platform that lets an ASHA
field worker get an instant, explainable risk read for a patient during a home visit —
even with no network — and puts that result in front of a PHC doctor live, the moment
it happens.

---

## 2. The problem (slide: "why")

- ASHA (field health) workers visit villages with no decision support: no way to tell
  a routine visit from an urgent one.
- PHCs (Primary Health Centres) are overloaded and have no way to triage who to see
  first.
- Rural connectivity is unreliable — any tool that needs the network at the point of
  care will fail exactly when it's needed most.
- A missed early warning sign (borderline glucose, family history) usually goes
  unrecorded because nothing downstream of it changes.

---

## 3. The three user roles (slide: "who uses it")

| Role | Device | What they do |
| --- | --- | --- |
| **ASHA worker** | Phone, in the village | Screens patients, sees instant risk result, books consult for high-risk cases |
| **PHC doctor** | Laptop/tablet, at the health centre | Sees new high-risk cases arrive live, reviews and acts on them |
| **District officer** | Laptop, at the district office | Sees aggregated trends across all PHCs in the district |

All three are the *same app* — one PWA, role-based views, one login screen.

---

## 4. End-to-end workflow (slide: "how it works" — the core demo narrative)

```
 ASHA WORKER                          PHC DOCTOR
 ───────────                          ──────────
 1. Opens app, picks language
    (Bengali / Hindi / English)
 2. Enters patient vitals
    (glucose, BP, height/weight,
    family history) — types or
    speaks it
 3. Risk engine scores it
    INSTANTLY, on the device,
    offline if needed
        │
        ▼
 4. Sees risk band: LOW /
    MODERATE / HIGH — with
    plain-language reasons
    ("high risk because glucose
    165 and BMI 31")
        │
        ├── if HIGH risk ──────────►  5. Case appears LIVE on the
        │    taps "Book                  dashboard — no refresh —
        │    consultation"                via a real-time push
        │                                 (Socket.io)
        │                             6. Doctor reviews, can mark
        │                                acknowledged / consulted
        │
 7. If offline when screened:
    record saved on-device,
    syncs automatically the
    moment signal returns —
    no data loss, no duplicates
```

**The moment worth demoing live:** open the ASHA screen and the doctor dashboard side
by side on two devices/tabs. Submit a high-risk screening as the worker. Watch it
appear on the doctor's screen with no refresh.

---

## 5. What happens to one screening, technically (slide: "under the hood")

```
Form input (glucose, BP, height, weight, family history, ...)
        │
        ▼
Validation  (range checks — shared by device AND server, so a typo like
             "1650" glucose can never reach the model)
        │
        ▼
Feature vector (8 features, fixed order)
        │
        ▼
Decision tree  ──────► risk band (LOW / MODERATE / HIGH) + probability
   (trained model,        │
    runs in the browser,  ▼
    same JS on server) Plain-language reasons
                        (built from clinical reference ranges,
                         NOT from the tree's internal thresholds —
                         a health worker needs "blood sugar 165 is in
                         the diabetes range", not "node 3, split 157.5")
        │
        ▼
Neural network second opinion (independent model, same inputs)
        │
        ▼
Per-feature attribution (which factors drove the neural score, and
                          by how much — full transparency, not a black box)
        │
        ▼
Stored record (if online) ──► emitted over Socket.io to the PHC's room
                               ──► doctor dashboard updates live
        │
        ▼
If offline: saved to IndexedDB on-device ──► background sync queue
             ──► flushes automatically once connectivity returns
```

---

## 6. System architecture (slide: "components")

```
                     ┌─────────────────────────────┐
                     │   ml/  (training, offline)   │
                     │   Decision tree + neural net  │
                     │   trained once, exported as   │
                     │   plain JavaScript             │
                     └───────────────┬───────────────┘
                                     │
                     ┌───────────────▼───────────────┐
                     │  shared/  risk engine + chatbot │
                     │  ONE implementation, imported   │
                     │  by both sides below            │
                     └───────┬─────────────────┬───────┘
                             │                 │
                 ┌───────────▼──────┐  ┌───────▼────────────┐
                 │   frontend/       │  │   backend/          │
                 │   React + TS PWA  │  │   Express + Socket.io│
                 │   - offline-first │  │   - MongoDB          │
                 │     (IndexedDB)   │  │   - auth (JWT)       │
                 │   - service worker│  │   - real-time alerts │
                 │   - installable   │  │   - sync endpoint    │
                 └───────────────────┘  └──────────────────────┘
```

**Why the risk model is plain JavaScript, not a Python service:** offline scoring is a
hard requirement, not a nice-to-have. A prediction that has to reach a Python inference
server over the network cannot work in a village with no signal. Training happens once,
offline, in Node/Python; the *result* ships as a JS function bundled into the app.

---

## 7. The offline-sync trick (slide: "why it never loses data")

Every patient and every screening gets a UUID **generated on the device**, before any
network call (`clientId`). This one design choice is what makes the offline path work:

- A screening can reference a patient the server has never seen yet.
- Replaying the same sync batch twice **updates**, never duplicates.
- A worker who loses signal mid-visit and retries doesn't create a second patient
  record.

Using the server's database ID as the only identity would make all three impossible.

---

## 8. Two models, one decision (slide: "the ML angle")

| | Decision tree | Neural network |
| --- | --- | --- |
| Role | **Decides the risk band** | Second opinion only |
| Why | Small, fast, explainable in ≤4 comparisons | Explains itself across *all 8* input features, not just the ones the tree happened to split on |
| Runs | Offline, in the browser, plain JS | Offline, in the browser, plain JS |

When the two models disagree on a patient's band, that patient is near a decision
boundary — flagged for the doctor as worth a second look, sooner.

Held-out performance: **71% accuracy, 78% recall, ROC-AUC 0.81** — recall is
deliberately prioritized over precision, because for a screening tool a missed
diabetic case matters more than a false alarm.

---

## 9. Real-time layer (slide: "how the live alert works")

- Socket.io, with **rooms** scoped to each PHC (`phc:<id>`) and district
  (`district:<name>`).
- A doctor's dashboard only ever receives events for their own PHC — the room name is
  derived from their JWT, never from anything the client claims. This is also what
  keeps one PHC's patient data from ever reaching another PHC's doctor.
- Events: new screening created, high-risk alert, review status changed, teleconsult
  requested, offline sync completed.

---

## 10. Tech stack (slide: "what it's built with")

| Layer | Tech |
| --- | --- |
| Frontend | React 18 + TypeScript, Vite, PWA (service worker, installable), Dexie/IndexedDB for offline storage |
| Backend | Node.js + Express, Socket.io, MongoDB (Mongoose) |
| Auth | JWT, bcrypt; optional Firebase phone-OTP login |
| ML | Decision tree (Node/scikit-learn) + PyTorch neural net, both exported to plain JS |
| i18n | Bengali, Hindi, English — full UI + chatbot |
| Realtime | Socket.io rooms, scoped by PHC/district |

---

## 11. Honest scope (slide: "what's real vs. simulated" — judges respect this)

| Fully working | Simulated for the demo | Not built |
| --- | --- | --- |
| Risk scoring + explanations, fully offline | Teleconsult video call — booking and live PHC notification are real; the call screen itself is a placeholder | ABDM/NDHM health-ID interoperability |
| Live dashboard alerts (Socket.io) | SMS fallback alerts — needs a licensed sender | OCR of printed vitals (voice input covers this need) |
| Offline capture + auto-sync, no duplicate records | | |
| FAQ chatbot in 3 languages | | |
| Neural network second opinion with per-feature explanations | | |

---

## 12. The model's honest limitation (slide: "what we're upfront about")

The risk model is trained on the **Pima Indians Diabetes dataset** (768 records, adult
Pima women) — not an Indian population. What transfers across populations is the
*direction* of the relationships (higher glucose/BMI/age/family history → higher risk);
what doesn't transfer is exact calibration. The app compensates by using **Indian
clinical reference ranges** (WHO Asian-Indian BMI cut-offs) in its plain-language
explanations, while the model itself would be retrained on Indian cohort data
(ICMR-INDIAB / NFHS-5) for a real deployment.

---

## 13. Deployment architecture (slide: "how it's deployed", if asked)

```
Vercel (static hosting)                  Render (Node process)
────────────────────────                 ──────────────────────
React PWA build (dist/)                  Express API + Socket.io
                         ── /api/* ──►    MongoDB (in-memory for demo)
                         ◄── live data ──
```

- Vercel hosts the frontend only (static files + service worker).
- Render runs the actual backend — it needs a persistent process for Socket.io and the
  in-memory database, which a serverless platform can't provide.
- The two are wired together with `VITE_API_BASE_URL` (frontend → knows where the API
  is) and `CORS_ORIGINS` (backend → allows the frontend's origin).

---

## Suggested slide order

1. Title + one-line pitch
2. The problem (rural diagnostic gap)
3. Who uses it (3 roles)
4. Live demo / workflow walkthrough (section 4)
5. Under the hood: one screening's journey (section 5)
6. Why offline-first matters + the `clientId` trick (section 7)
7. Two models, one decision (section 8)
8. Real-time alerts across PHCs (section 9)
9. Tech stack (section 10)
10. Honest scope + model limitation (sections 11–12)
11. What's next / thank you
