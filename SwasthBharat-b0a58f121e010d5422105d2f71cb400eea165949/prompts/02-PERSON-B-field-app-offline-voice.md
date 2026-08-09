# Person B — Field app: form, offline sync, voice, i18n

> Read `prompts/00-SHARED-CONTEXT.md` first.
>
> You own: `frontend/src/pages/{AssessmentFormPage,RiskResultPage,AshaHomePage,LoginPage}.tsx`,
> `frontend/src/components/{forms,VoiceInputButton,ui}.tsx`,
> `frontend/src/lib/{db,sync,speech}.ts`, `frontend/src/i18n/**`.
>
> Announce before touching `App.tsx`, `types.ts`, `index.css`, `AppShell.tsx`, `lib/api.ts`.

**You own the demo's strongest moment: Wi-Fi off → record a patient → Wi-Fi on → it syncs
by itself.** Nothing else in the build lands as hard as that. Treat everything below as
serving it.

The code is written and it compiles. **It has never been run in a browser.** Your first job
is to find out what is actually broken.

---

## B1 — Get it running and write down everything that breaks (45 min)

```bash
npm install --prefix frontend
npm run dev:api      # terminal 1 (Person A's area, but you need it up)
npm run dev:web      # terminal 2
```

Open `http://localhost:5173` in **Chrome** (voice needs Chrome or Edge; Firefox has no
SpeechRecognition).

Walk the whole worker flow and keep the DevTools console open the entire time:

1. Login screen renders, language buttons show বাংলা / हिन्दी / English
2. Tap a demo login chip → fields fill → log in as `9800000001`
3. Home screen shows the hero button and the seeded recent list
4. Start a screening, fill it, submit
5. Result screen shows HIGH/MODERATE/LOW with reasons

Write every error and every visual break into a scratch list before fixing anything. You
will find things faster than you can fix them, and fixing in discovery order wastes time.

**Two things to specifically check:**

- **The i18n audit.** The provider logs missing translation keys to the console on load
  (`[i18n] bn.json is missing N key(s)`). If that fires, fix the locale files — it means a
  screen will silently fall back to English.
- **Bengali and Hindi rendering.** Switch languages and look at the form labels. Conjuncts
  (যুক্তাক্ষর) and matras must not be clipped. If they are, the fix is line-height in
  `index.css` under `:lang(bn), :lang(hi)` — coordinate with whoever owns that file.

**Accept when:** you can complete a screening and see a result, and the console has no
errors.

---

## B2 — Already fixed, just confirm it in the browser (10 min)

The `patientId`-through-sync wiring (backend response → `SyncResultEntry` → `markSynced` →
`serverPatientId`) is already done on both sides. This task is now: **verify it actually
works when you click through it**, since none of this has been opened in a browser yet.

1. Log in, submit a screening online, wait for it to sync
2. DevTools → Application → IndexedDB → `swasthbharat` → `assessments` → confirm
   `serverPatientId` is populated (not `null`) on that record
3. Open the result page — "Book consultation" should be enabled, and tapping it should
   reach the booking form rather than an error toast

If any of those three fail, that is a real bug — the wiring compiles but has never been
exercised at runtime. Report exactly which step failed rather than re-doing the wiring from
scratch.

**Accept when:** all three pass.

---

## B3 — Verify the offline path properly, then make it obvious (90 min) — **HIGHEST VALUE**

This is the task that wins or loses the demo. Be thorough.

### The test, exactly

1. DevTools → Network tab → throttling dropdown → **Offline**
2. Confirm the connection strip at the top turns to the offline state and says the work is
   saved on the phone
3. Complete a full screening. It must:
   - score and show a result with **no** network request (check the Network tab is empty)
   - appear on the home screen with a "waiting to sync" tag
   - increment the pending counter in the connection strip
4. **Reload the page while still offline.** The app must still load (service worker) and the
   record must still be there (IndexedDB). If the reload fails, the service worker is not
   precaching properly — that is a `vite.config.ts` issue, coordinate before editing.
5. Add a second patient while offline. Pending count → 2.
6. Set throttling back to **No throttling**
7. Within ~20 seconds the queue must drain by itself, the count go to zero, and a toast
   appear. Do not tap "Sync now" — the automatic path is the point.

### What to fix if step 7 is slow or does not fire

`lib/sync.ts` retries on: the `online` event, window `focus`, `visibilitychange`, and a
20-second interval while work is pending. The interval only starts when
`scheduleIfNeeded()` sees pending work. Verify that actually happens — if `setUser` runs
before any records exist, the timer may never start. That is the most likely bug in the file.

### Then make the recovery visible

For the demo, the moment the queue drains should be unmistakable from three metres away.
Currently it is a small toast and a counter. Consider:

- a brief success state on the connection strip ("Synced 2 records") that persists ~5 seconds
- the pending tag on each card flipping to a synced tick with a short transition

Keep it subtle enough to look professional. Do not add a confetti animation.

**Accept when:** you can run the full sequence twice in a row without touching the console,
and a bystander can tell what happened just by watching the screen.

---

## B4 — Verify voice input on a real device (45 min)

Voice is a headline feature and it is completely unverified.

1. Chrome, `http://localhost:5173`, allow the microphone prompt
2. Tap the mic beside "Blood sugar" and say a number in English → it should fill the field
3. Switch to Bengali, tap the mic, say a number in Bengali
4. Switch to Hindi, repeat

### What you will probably find, and what to do about it

`lib/speech.ts` **fails closed by design**: if any spoken token is not recognised, it fills
nothing and shows "I did not catch a number". Read the comment block at the top of that file
before you change anything — the reason is that partially understanding Bengali
"একশো পঁয়ষট্টি" (165) as just "একশো" would put **100** into a blood sugar field, which is a
silently wrong vital sign. That behaviour is deliberate and correct.

The word tables cover 0–20, the tens, and hundred. The irregular forms from 21–99 are
deliberately absent. In practice Chrome usually returns **digits** for spoken numbers, so
this rarely matters — confirm that on your device.

**If you want to extend the number words:** get a native speaker to verify **every row** you
add. One wrong entry becomes a wrong glucose reading. If you cannot verify a form, leave it
out — falling back to typing is safe, guessing is not.

**Accept when:** voice fills a field correctly in at least one language, and failure shows a
helpful message rather than doing nothing. If a browser lacks support, the mic button must be
absent, not broken — test in Firefox to confirm.

---

## B5 — Already fixed, just confirm it in the browser (10 min)

Two small bugs from code review are already fixed:

- `AshaHomePage`'s "screened today" / "high risk found" cards now come from
  `getHomeStats(userId)` in `db.ts`, which scans the full per-user record index rather than
  the capped 10-item "recent" list.
- The duplicate `react-router-dom` import in `App.tsx` is merged.

Confirm at runtime: seed or create **more than 10** assessments for one worker (the seed
data already gives Sunita Das more than 10 across her PHC, but double check by counting in
IndexedDB), and confirm the home screen's counters are not stuck at a number ≤ 10.

**Accept when:** counters are correct with more than 10 records, and `npx tsc --noEmit`
stays clean.

---

## B6 — PWA install and offline-first-load (30 min)

1. `npm run build:web && npm run preview --prefix frontend`
2. Chrome → DevTools → Application → Manifest. No errors, icons resolve.
3. Install the app (address-bar install icon). It should open in its own window with no
   browser chrome.
4. In the installed app, go offline and reload. It must still load.
5. Lighthouse → PWA category. Fix what it flags, within reason.

The icons already exist and are real PNGs (`frontend/public/icons/`), generated by
`npm run icons`. If you need to change the artwork, edit
`frontend/scripts/generate-icons.mjs` and re-run — do not hand-drop binaries in.

**Accept when:** installed app opens standalone and survives a reload with the network off.

---

## B7 — Low-literacy review pass (30 min)

Go through the worker screens and ask, for each element: *could someone who reads slowly and
is holding this phone one-handed in daylight use it?*

Specifically check:

- Every tappable thing is at least 48px tall. The CSS has `--tap-target: 48px`; confirm
  nothing overrides it.
- Risk levels are distinguishable **without colour**. Squint, or use DevTools →
  Rendering → Emulate vision deficiencies → Achromatopsia. HIGH/MODERATE/LOW each have a
  distinct icon (⚠ / ● / ✓) as well as a colour — verify that survives.
- No field asks for something a village health post cannot measure without saying it is
  optional. Skin-fold and insulin are already collapsed and marked optional; check nothing
  else creeps in.
- The BMI notice updates live as height and weight are typed. That feedback is what stops a
  worker computing it by hand.

**Accept when:** you have walked the form in Bengali on a phone-sized viewport (DevTools
device toolbar, e.g. Pixel 7) and found nothing you would be embarrassed to demo.

---

## B8 — Stretch, only if B1–B7 are done

1. **A "resume unfinished screening" draft.** If the app is closed mid-form, the entered
   values are lost. Persisting the in-progress form to IndexedDB on change would be a real
   field improvement and directly on-theme.
2. **Follow-up screening for an existing patient.** The patient history already exists on the
   backend; letting a worker pick a previous patient and record a second reading turns a
   snapshot into a trend.
3. **Speak the result aloud** with `SpeechSynthesis` in the selected language. For a
   genuinely low-literacy user, hearing "high risk — go to the health centre this week" is
   more useful than reading it. Cheap to add, demos well, and no API key.

---

## Things you should NOT do

- Do not make the risk result depend on a network call. It is computed locally by
  `@shared/risk` and that is the entire offline story.
- Do not add a UI framework (Tailwind, MUI). `index.css` is a working design system and
  swapping it now costs hours.
- Do not lower the voice parser's safety rule to make it "work more often". A wrong number in
  a medical form is worse than a retry.
- Do not edit `shared/**` — that is Person A's, and both the API and the app depend on it.
