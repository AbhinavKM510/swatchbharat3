# Person C — Dashboard, real-time alerts, chatbot, teleconsult

> Read `prompts/00-SHARED-CONTEXT.md` first.
>
> You own: `frontend/src/pages/{DoctorDashboardPage,DistrictTrendsPage,ChatbotPage,TeleconsultPage,PatientsPage,ModelCardPage}.tsx`,
> `frontend/src/components/{charts,risk}.tsx`, `frontend/src/lib/socket.ts`.
>
> Announce before touching `App.tsx`, `types.ts`, `index.css`, `AppShell.tsx`, `lib/api.ts`.

**You own demo step 4 — the case appearing on the doctor's screen live, with nobody
touching it.** That is the moment that makes the whole thing feel like a product rather than
a form. You also own the two features that must be honest about being fake.

Everything is written and compiles. **None of it has been opened in a browser.**

---

## C1 — Before anything else: get two clients talking (45 min) — **BLOCKER**

You cannot test your area on one browser window. Set this up first.

Per `00-SHARED-CONTEXT.md`, decide the shared-backend approach with the team **now**. For
local development you can fake it on one laptop:

- Window 1: normal Chrome, log in as **`9800000001`** (Sunita, ASHA, Haringhata)
- Window 2: Chrome **incognito**, log in as **`9800000010`** (Dr. Ghosh, doctor, Haringhata)

Incognito matters — both sessions use the same `localStorage` key for the token, so two normal
windows will fight over it.

They must be at the **same PHC**, or the alert is correctly not delivered and you will spend
an hour debugging working code. Socket.io rooms are scoped per PHC deliberately: a doctor at
Chakdaha must not receive Haringhata's patients.

**The test:** submit a high-risk screening in window 1 (glucose 165, height 155, weight 74.5,
family history yes, age 46 → this is the scripted demo case and returns HIGH 95%). Window 2
must, without any interaction:

- show the case at the top of the flagged queue with the arrive animation
- raise a toast naming the patient
- increment the "high risk to act on" counter
- show the live indicator as connected

**Accept when:** that works twice in a row.

### If the alert does not arrive

Check in this order:

1. Console in window 2 for a Socket.io `connect_error`. The handshake requires a JWT
   (`auth.token`), read lazily from `getToken()`.
2. `GET /api/health` → `realtime.connectedSockets` should be ≥ 1.
3. Both users' `phcId` — `GET /api/auth/me` in each window. If they differ, that is your bug,
   not the code's.
4. The Vite dev proxy forwards `/socket.io` with `ws: true`. If you changed
   `VITE_API_BASE_URL`, the socket connects directly instead and needs that origin in
   `CORS_ORIGINS` on the backend.

---

## C2 — Audit the socket lifecycle by hand (30 min)

`DoctorDashboardPage` used to have a no-op cleanup effect that has already been removed
(`AuthContext.logout()` is the only place that calls `disconnectSocket()` now — the socket
survives route changes within the app and only dies on logout). This task is verifying that
lifecycle actually behaves correctly in a real browser, since none of it has run yet:

- Navigate dashboard → district → back. The live indicator must stay connected and you must
  not accumulate duplicate listeners (submit a screening after navigating and confirm you get
  **one** toast, not three).
- Log out and back in. The socket must reconnect with the new token and join the new user's
  rooms.

The duplicate-listener risk is real: the effect adds four handlers and the cleanup removes
them by reference. Confirm the cleanup actually runs by adding a temporary
`console.log` and navigating away.

**Accept when:** one submit produces exactly one toast, after navigating between three
screens.

---

## C3 — De-duplication and correctness of the live queue (30 min)

The optimistic insert in `onHighRisk` builds a partial `Assessment` from the alert payload.
Two things to verify:

1. **No duplicates.** A case can arrive from the socket *and* be present in the initial
   fetch. The handler guards on `items.some(item => item.id === alert.assessmentId)` — force
   the race by submitting a screening and immediately hitting Refresh. You must not see the
   patient twice.
2. **The card renders fully from the alert payload.** The alert carries `topReasons` (three
   of them), `derived`, `patient`, `reportedBy`, `source`, `inputMethod`. It does **not**
   carry `decisionPath` or `recommendations`, so anything on the card that needs those will
   render empty for socket-delivered cases but populated for fetched ones — an inconsistency a
   judge might notice. Either keep the card to fields the alert provides, or fetch the full
   record lazily when the doctor expands it.

**Accept when:** a socket-delivered card and a refresh-delivered card look identical.

---

## C4 — Teleconsult: verify the flow and keep the honesty (45 min)

Coordinate with Person A (they are adding `patientClientId` support) and Person B (they are
wiring `serverPatientId` through sync). Until BUG-1 is fixed, booking returns 404 — that is
expected, not your bug.

Once it is fixed, walk the flow:

1. From a HIGH result, tap "Book consultation"
2. The **simulation banner appears above the button, before you book** — this is deliberate
   and must not be moved or made dismissible
3. Book → connecting animation (~2.6s) → call screen with a running timer
4. Mute toggle works, end call works, ended screen shows the duration
5. On the doctor's dashboard, the request appears (`teleconsult:requested` event)

### The part that matters more than the animation

This feature is fake and the build says so in four places: the banner before booking, the
banner during the call, the banner after it ends, and `isSimulated: true` on every API
response. **Do not remove any of them to make the demo look smoother.** A judge who
discovers a fake call that was presented as real will discount everything else you built;
a judge who is told upfront will credit you for scoping honestly.

If asked what a real version needs: a media server (LiveKit or Janus) or a provider SDK,
TURN servers because village connections sit behind carrier NAT, a doctor availability
calendar, and consent capture before any recording. `GET /api/teleconsult/capabilities`
returns exactly this as JSON.

**Accept when:** the flow completes and the disclosure is visible at every stage.

---

## C5 — Chatbot in the browser, including offline (40 min)

The chatbot answers from bundled rules (`@shared/chatbot`), so it should work with the
network off. Verify that specifically — it is a strong secondary proof point.

1. Ask the scripted Bengali question: **শর্করা বেশি হলে কী খাব?** → must return the diet
   answer in Bengali
2. Tap each suggestion chip
3. Ask in Hindi: **मधुमेह के लक्षण क्या हैं** → symptoms answer in Devanagari
4. Ask something out of scope ("who won the cricket match") → must fall back with example
   questions, **not** invent medical advice
5. Ask an emergency phrase: **রোগী অজ্ঞান হয়ে গেছে** → red escalation card with a
   `tel:108` button
6. **Go offline and repeat step 1.** It must answer instantly, and the bubble must show the
   "answered on this phone, without internet" note

Also check: offline questions are queued to IndexedDB (`chatQuestions` table) and replayed to
`POST /api/chatbot/sync` when back online. That feeds the unmatched-question backlog at
`GET /api/chatbot/unmatched`, which is how the rules improve. Confirm the queue drains.

**Accept when:** all six pass, and offline answers appear with no network request.

---

## C6 — District trends: make sure it is not empty and not misleading (40 min)

Log in as `9800000020` (Dr. Meera Nair, officer). The seed creates 46 assessments across 3
PHCs over 30 days, so this screen should have real shape.

Verify:

- The 7 / 30 / 90 day toggles change the data
- The stacked sparkline has one column per day including zero-volume days
- Per-PHC table shows all three PHCs with sensible high-risk rates
- "Most common risk factors" labels read as **categories**, not sentences. There is a
  `factorLabel()` helper that strips the `{value}` placeholders out of reason strings — check
  the output is not left with stray punctuation or double spaces in Bengali and Hindi.
- The adoption card shows voice share and **offline capture share**. That last number is
  quietly the most interesting thing on the page: it is the evidence that offline-first was
  necessary rather than decorative. Make sure it is legible.

Also confirm the officer view shows **no patient names anywhere**. That is a deliberate
privacy boundary enforced by the API, and being able to say "an officer sees rates, not
people" is worth a sentence in the pitch.

**Accept when:** all four windows render, no console errors, and no PII appears.

---

## C7 — Model card page (20 min)

Open `/model`. It should work **logged out** as well — the transparency page deliberately does
not require an account.

Verify it renders from bundled metadata when the API is unreachable (go offline and reload).
The limitations list must always be visible; it must never be the part that fails to load.

Check the feature-importance bars are sorted and that zero-importance features
(`skinThickness` is 0.0) are filtered out rather than shown as empty bars.

**Accept when:** `/model` renders logged out and offline.

---

## C8 — Stretch, only if C1–C7 are done

1. **An audible alert on the dashboard**, off by default with a toggle. A PHC doctor is not
   staring at the screen. Use a short WebAudio beep rather than shipping an audio file.
2. **Unmatched-question count on the officer dashboard.** Person A can expose it; showing
   "12 questions the bot could not answer" demonstrates a feedback loop rather than a static
   FAQ.
3. **A map of PHCs.** The `Phc` model already stores lat/lng for all three. Even plotted
   points on a simple SVG would make the district view feel geographic. Do not pull in
   Leaflet for this — the bundle cost is not worth it before a deadline.

---

## Things you should NOT do

- Do not remove or soften any simulation disclosure on the teleconsult screens.
- Do not switch the live update to polling because the socket was briefly hard to debug. The
  live arrival is the demo moment; polling looks the same in a screenshot and worse in person.
- Do not add a charting library. `components/charts.tsx` is hand-rolled CSS specifically to
  keep the bundle small enough to cache for offline use; Recharts alone would roughly double
  the JS payload.
- Do not edit `shared/**` or `backend/**` — that is Person A's.
