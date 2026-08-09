# Merge — COMPLETED

Three working copies consolidated into `SwasthBharat`. This file now records what was
actually done and why, including the two things deliberately **not** taken.

**Verification after merge:**

| Check | Result |
| --- | --- |
| `npm run check:api` | **79 passed, 0 failed** (was 73 before merge) |
| `npm run check:security` | **7 passed, 0 failed** (new suite from Person A) |
| `npm run check:web` (tsc) | clean |
| `vite build` | succeeds, 15 precache entries, 466 KB JS / 159 KB gzipped |
| i18n audit | **360 keys × 3 languages, 0 missing, 0 extra, placeholders all match** |

Rollback available at `Desktop/_SwasthBharat-premerge-backup` (107 source files), plus git
commit `7316747`.

---

## Merged FROM SwasthBharat2 (Person A)

| Feature | How | Notes |
| --- | --- | --- |
| **Root `README.md`** | copied | 207 lines. The target had none. |
| **`backend/scripts/check-security.mjs`** | copied + `check:security` script | Cross-PHC denial, rate-limiter behaviour. 7 assertions. |
| **Teleconsult `patientClientId` fallback** | whole file | Booking now works for a record that has not synced yet. This was the one genuinely-unbuilt task. |
| **5 new demo-flow assertions** | whole file | A's copy already contained the target's BUG-1 assertion, so it was a clean superset — no hand-merge needed. |
| **`ml/requirements.txt`** + **`ml/README.md`** | copied | Documents a real wall A hit: pinned versions have no wheels for Python 3.14, so pip tries to compile numpy from source. Fix is `--only-binary=:all:` unpinned. |
| **`ml/train_model.py`** | copied | A's version after actually running it. |
| **`VITE_SHOW_DEMO_LOGINS`** | new `frontend/.env.local` + `.env.example` | See below — this one nearly cost the demo. |

### The `VITE_SHOW_DEMO_LOGINS` catch

`LoginPage` hides the tap-to-fill demo chips outside dev builds, so a real deployment never
advertises credentials. But the offline-reload and PWA-install demos **only work on the
production build** — so the demo runs from `:4173`, where those chips were invisible. You'd
have been typing 10-digit phone numbers on stage. Person A caught this; it was not on my radar.

Also added `frontend/.env.example` (committed, unlike `.env.local`) so the flag is
discoverable rather than tribal knowledge.

---

## Merged FROM SwasthBharat3 (Person C)

| Feature | How | Notes |
| --- | --- | --- |
| **`lib/alertSound.ts`** | copied | WebAudio two-tone dashboard alert. Synthesised not mp3 (nothing added to the offline precache), off by default, preference persisted. |
| **Dashboard sound integration** | whole file | C's `DoctorDashboardPage` already lacked the dead socket effect the target removed (BUG-4), and its `ReasonList` cap of 3 is better — clean superset. |
| **`setConnectivityObserver`** in `lib/api.ts` | whole file | Clean superset of the target's. |
| **Sentinel-based `factorLabel`** | hand-merged | Replaced the target's regex version. |
| **`BottomNav` anonymous guard** | hand-merged | `if (!user) return null` — `/model` renders logged-out, so nav aimed at no role was showing. |

### Why C's `alertSound` is worth calling out

It calls `primeAlertSound()` from the *enabling click*. Browsers keep an `AudioContext`
suspended until a real user gesture, so without priming there, the **first actual alert** —
the one nobody is expecting and therefore the one that matters most — would be silently
dropped. That is a subtle bug most implementations ship.

### Why C's `setConnectivityObserver` is better than anything in the target

It lets the HTTP layer report *observed* reachability up to the sync manager, instead of the
sync manager trusting `navigator.onLine`. On a rural connection `onLine === true` routinely
means "attached to a tower that is not passing traffic", and the browser fires no `offline`
event for that. A request that actually completed, or actually failed to connect, is direct
evidence. This is the correct fix for the exact problem the target's defensive sync code was
written around.

---

## Conflicts resolved (built more than once, independently)

### `PhcMap` — built twice → kept the target's
| | Target `components/PhcMap.tsx` | C, inside `charts.tsx` |
| --- | --- | --- |
| Viewport | 100×100 normalised | 320×190 fixed |
| Paired with | `DirectionsButton` (needs its `directionsUrl()`) | — |

C's `charts.tsx` turned out to be *exactly* the target's plus `PhcMap`, nothing else — so
`charts.tsx` was left untouched and there is no duplicate map component.

### Logout — built three times → kept the target's
Target (standalone component, icon + labelled variants, toast) beat A's (inline,
`window.confirm`) and C's (inline, `window.alert` + wrong translation key).
A's now-dead `common.logoutConfirm` / `common.logoutBlocked` were removed **after
programmatically proving nothing referenced them**.

### i18n — all three added different keys → union merge
Merged as a union with the target winning on conflict, then audited. Only 2 keys were unique
to another copy (A's logout pair, since removed as dead). C's `dashboard.alertSound` and the
`trends.map*` keys were already present.

A naive file overwrite here would have silently deleted keys and dropped those screens to
English — this was the highest-risk step in the merge.

---

## Deliberately NOT merged

### A-7 `registerSW({ immediate: true })` in `main.tsx` — **rejected**
A's comment claims that without this "nothing ever installs" the service worker. That is not
true for this config: the target's built `index.html` contains
`<script id="vite-plugin-pwa:register-sw" src="/registerSW.js">` — `vite-plugin-pwa`'s
default `injectRegister: 'auto'` already handles it, and **offline reload is confirmed
working on real hardware inside the installed PWA**.

A's copy has auto-injection *and* the explicit call, i.e. double registration. Adding it to a
verified-working setup is risk for zero gain. If anyone wants A's approach later, it requires
`injectRegister: false` **and** a fresh offline-reload test.

### A's / C's `ml/export/*` and `shared/risk/decision_tree_rules.js` — **rejected**
Regenerated, but substantively identical: accuracy 0.7143, recall 0.7778, ROC-AUC 0.8064,
14 leaves, same pedigree threshold, and `generatedBy` still the Node trainer. Only the
timestamp differed. No value, pure churn.

### `backend/.env`, `.gitignore`, root `package.json` from either copy — **rejected**
The target's are newer: `:4173` in `CORS_ORIGINS`, `dev-dist/` ignored, `preview:web` and
`demo` scripts.

### `sync.ts`, `db.ts`, `speech.ts` — **target is authoritative, never overwritten**
Both teammates branched before these fixes:
- BUG-5 offline queue counters (badge stuck at zero while records piled up)
- Bengali NFC normalisation in the voice parser (`কুড়ি` failed to parse)
- `getHomeStats` (home counters capped at 10)
- the `recentlySynced` confirmation banner

### `C-6 allowScripts` — skipped
npm lifecycle allowlisting for `esbuild` / `mongodb-memory-server`. Installs already work
here; adding it risks breaking them for no benefit this close to a deadline.

---

## Post-merge state

New commands available:
```bash
npm run check:api        # 79 assertions
npm run check:security   # 7 assertions  (saturates the login rate limiter — restart API after)
npm run check:web        # tsc --noEmit
npm run demo             # build + serve production on :4173
```

**Operational note:** `check:security` deliberately exhausts the login limiter (30/10min).
Restart the API before running `check:api` afterwards, or the logins in it will 429.

---

## Post-merge addition: scikit-learn cross-validation

Python 3.14.7 was installed after the merge (numpy 2.5.1 / pandas 3.0.5 /
scikit-learn 1.9.0 — exactly the versions `ml/requirements.txt` documents as verified).
`ml/train_model.py` was executed successfully.

**Result: the Node-trained artefact was kept, and the scikit-learn run is retained as
validation rather than as the shipped model.**

| Held-out metric | Node CART (shipped) | scikit-learn |
| --- | --- | --- |
| Accuracy | **0.7143** | **0.7143** ← identical |
| Leaves / nodes | **14 / 27** | **14 / 27** ← identical |
| Recall | 0.7778 | 0.8519 |
| Specificity | 0.68 | 0.64 |
| ROC-AUC | 0.8064 | 0.8013 |
| Patients in MODERATE band | 14 | **2** ← near-empty |

Matching accuracy *and* identical tree size is the point: it is independent evidence
that the ~200-line CART in `ml/lib/cart.mjs` implements the same algorithm scikit-learn
does, rather than something that merely resembles it.

### Why scikit-learn's tree was NOT shipped, despite better recall

1. **It collapses the three-band triage into two.** Only 1 of its 14 leaves can produce
   MODERATE; on held-out data 2 patients out of 154 (1.3%) landed there, versus 14 for
   the Node tree. A middle band that is statistically empty is not a middle band.
2. **Its decision path stops corroborating the explanation.** scikit-learn assigns
   `familyHistory` an importance of **0.0** and never splits on it, nor on `diastolicBp`.
   For the scripted demo case its path is glucose ×3 plus pregnancies, whereas the Node
   tree's is `glucose > 123.5 → bmi > 30.05 → glucose > 157.5 → familyHistory > 0.5` —
   which visibly matches the plain-language reasons the worker is shown. The reasons
   themselves come from clinical reference ranges either way, so they would still be
   correct; but "how the model decided" would no longer back them up.

Restored from `_ml-backup-node/`, then re-verified: demo case is **HIGH 95%** with BMI
and family history both present in the path, leaf band coverage back to LOW 6 /
MODERATE 3 / HIGH 5, and `ml/export/` byte-identical to `shared/risk/`.

### New demo asset: `ml/compare_trainers.py`

```bash
npm run ml:compare        # read-only, safe to run in front of judges
```

Trains scikit-learn on the same data and prints both models side by side, with the
band-spread comparison and scikit-learn's feature importances as an ASCII bar chart.
**It writes nothing** — unlike `train_model.py`, it cannot overwrite the live model, so
there is no risk of swapping the shipped tree mid-demo.

`npm run ml:train:py` remains available for a genuine retrain, and its script comment
warns that it overwrites `shared/risk/decision_tree_rules.js`.

**Re-verified after restore:** `check:api` 79/79, `check:security` 7/7, tsc clean,
build clean.

---

## Still open (unchanged by the merge)

- **B4 — voice input** on a real mic in all three languages. Still the only headline feature
  no human has exercised.
- **B8 — stretch** items, correctly gated behind B1–B7.
- Re-confirm the **live high-risk alert now with sound**, since C-1/C-2 changed that path.
