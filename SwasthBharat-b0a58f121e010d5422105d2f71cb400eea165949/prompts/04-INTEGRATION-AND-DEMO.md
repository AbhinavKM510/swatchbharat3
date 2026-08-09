# 04 — Integration, rehearsal and pitch (all three, together)

Do this **together, out loud, with all three laptops on the venue Wi-Fi**. Budget 90 minutes
minimum. Every hackathon team that skips this discovers a network problem during their slot.

---

## Integration checklist — do this before rehearsing

Work top to bottom. Do not start the rehearsal until every box passes.

- [ ] All three branches merged into `main`, and `main` is what everyone is running
- [ ] `npm run check:api` → **72+ passed, 0 failed** (more than 72 if Person A added the
      `patientId` assertions)
- [ ] `npm run check:web` → clean
- [ ] `npm run build:web` → succeeds
- [ ] **BUG-1 fixed end to end**: an online screening → "Book consultation" reaches the
      booking form, not an error
- [ ] Decided and tested: **one shared backend** (Option 1) or **shared Atlas** (Option 2)
- [ ] On the venue network, the doctor's laptop receives a live alert from the worker's laptop
- [ ] The offline sequence works on the actual demo device
- [ ] Bengali renders correctly on all three laptops (font fallback differs per OS — check,
      do not assume)

### Assign the roles now, not on stage

| Role | Person | Device | Logged in as |
| --- | --- | --- | --- |
| ASHA worker (drives the story) | | phone or laptop, portrait | `9800000001` Sunita Das |
| PHC doctor (second screen) | | laptop, projected or held up | `9800000010` Dr. Arun Ghosh |
| Narrator + model questions | | | (Person A answers model questions) |

The worker and doctor **must** be at the same PHC or the alert will correctly not arrive.

---

## The demo script

Rehearse this end to end at least **three times**. Time it. Most hackathons give 5 minutes,
and this script fits in about 4 if you do not narrate every tap.

### Setup, 30 seconds before you start

- Doctor's dashboard open and showing "Live", on the second screen
- Worker's app open at the home screen, **language already switched to Bengali**
- Wi-Fi **on**
- Every other tab closed — a stray notification during a demo reads as a bug

### 1. Open with the problem, not the product (20s)

> "A woman in a village in Nadia district has had rising blood sugar for two years. Nobody
> has measured it, because the nearest PHC is overloaded and the ASHA worker who visits her
> every month has no way to tell whether she is at risk. She will be diagnosed when she
> arrives with a complication."

Do not open with the tech stack. Open with her.

### 2. The screening (60s)

Worker's device. Talk while you tap.

- Point out the language is Bengali, and that this is the worker's choice, not a setting
  buried behind a menu
- Enter the patient: age 46, female
- **Use voice for the blood sugar** — say 165. If voice fails, type it and say
  *"voice is browser-native so it varies by device; typing is always there"*. Do not
  apologise, and do not retry more than once.
- Height 155, weight 74.5 → **point at the BMI appearing automatically: 31**. Say that a
  health worker should not be doing kg/m² on paper.
- Family history: yes
- Tap **See the result**

### 3. The explanation — this is the actual product (45s)

The result reads **HIGH RISK, 95%**.

> "And this is the part that matters. It does not just say 95%. It says *why*: blood sugar
> 165 is in the diabetes range, BMI 31 is in the obese range for Indian adults, and a parent
> has diabetes. That is a sentence the worker can say to the patient and act on. A model that
> only outputs a probability is not usable by a non-clinician."

Then expand **How the model decided** and show the four comparisons.

> "It is a decision tree capped at four levels deep, on purpose. We could have got a few
> points more accuracy from gradient boosting and lost the ability to explain a single
> result."

If it fits, add the honesty line here rather than waiting to be asked:

> "It is trained on a public dataset from a different population — Pima Native American
> women. We say so in the app. The direction of the relationships transfers; the calibration
> does not, which is why the explanations use Indian BMI cut-offs and not the model's own
> thresholds."

### 4. Teleconsult, with the disclosure (25s)

Tap **Book a doctor consultation**.

> "The booking, the queue and the notification to the PHC are real. The video call is not —
> we simulated it, and the app says so on this screen. In 36 hours we chose to make the
> referral pathway real rather than fake a call badly."

Let the connecting screen play, show the call UI, end the call. Do not linger.

### 5. The live alert — turn to the second screen (20s)

> "While that happened, look at the PHC doctor's dashboard. Nobody refreshed it."

The case is at the top of the flagged queue with the reasons and the worker's name.

> "It is ordered highest-risk first, and within a risk level, **longest-waiting first** — a
> patient flagged three days ago who was never contacted is a worse problem than one flagged
> an hour ago."

Have the doctor mark it **Contacted** so the triage workflow is visible.

### 6. The chatbot in Bengali (20s)

Back to the worker's device. Ask: **শর্করা বেশি হলে কী খাব?**

> "Rule-based, not a language model — three reasons: it works with no internet, it can never
> improvise medical advice, and every answer is a fixed string a clinician reviewed."

### 7. The closer: turn the Wi-Fi off (45s) — **the strongest moment, save it for last**

> "Now the part that actually decides whether any of this works in a village."

**Physically turn off the Wi-Fi.** Not DevTools throttling — the actual toggle, visibly, so
nobody thinks it is staged.

- Point at the banner: the app knows, and says the work is saved on the phone
- Complete a whole second screening. It scores and shows a result with no connection.
  Say: *"the trained model is exported to plain JavaScript and shipped inside the app, so the
  prediction runs on the device. There is no server in this path."*
- **Reload the page while still offline** to prove it is a real installed app, not a cached tab
- Turn the Wi-Fi back on
- Say nothing. Let the queue drain by itself and the counter go to zero.
- Then: *"That is it. No retry button, no lost record."*

### 8. Land it (15s)

> "Early screening at the doorstep, an explanation a health worker can act on, and a referral
> that reaches a doctor — on a phone that spends half its day with no signal. Diabetes first
> because the risk factors are collectable by a village worker; hypertension, anaemia and
> cardiovascular risk use the same pipeline."

---

## Questions you will be asked — agree the answers now

Decide who answers each. Do not let three people answer at once.

**"How accurate is it?"** (Person A)
> 71% accuracy and 78% recall on held-out data, ROC-AUC 0.81. Recall is deliberately higher
> than precision: for screening, a missed diabetic costs more than a false alarm. And the
> risk bands separate monotonically on held-out data — 15% of LOW, 21% of MODERATE and 61% of
> HIGH patients were actually diabetic, which is what makes the bands usable for triage
> rather than decorative.

**"You trained on an American dataset. Isn't that a problem?"** (Person A)
> Yes, and we say so in the app rather than in a footnote. Use the paragraph in
> `00-SHARED-CONTEXT.md`. Do not get defensive — this answer, delivered calmly, reads as
> rigour.

**"Is the video call real?"** (whoever is holding the device)
> No. The booking, the queue and the notification are real; the call is simulated and the app
> says so on the screen before you book. Answer immediately and without hedging.

**"What about data privacy?"** (Person A)
> Passwords are bcrypt-hashed, auth is JWT, and access is scoped by role — a worker sees only
> her own records, a doctor only their PHC, and a district officer only aggregates with no
> patient names at all. We can demonstrate the cross-PHC block live. Real deployment needs
> encryption at rest and ABDM consent flows, which are out of scope for 36 hours.

**"Why not an LLM chatbot?"** (Person C)
> It must work offline, and a health bot for low-literacy users must never improvise medical
> advice. Every answer here is a fixed reviewed string. We do log the questions it fails to
> match, so the rules improve from real usage.

**"What would you build next?"** (any)
> Retrain on ICMR-INDIAB or NFHS-5 data; real teleconsultation with a media server and TURN;
> SMS fallback through a DLT-registered sender for workers with feature phones; ABDM health-ID
> linkage; and hypertension and anaemia on the same pipeline.

---

## Failure drills — rehearse these too

Things go wrong on stage. Decide the response now so nobody freezes.

| If this happens | Do this |
| --- | --- |
| Venue Wi-Fi dies entirely | **Keep going.** The worker flow is fully offline. Skip step 5, do 7 first, and say the app was built for exactly this. |
| Voice does not pick up the number | Type it. One retry maximum, then move on. Say it is browser-native so it varies by device. |
| The live alert does not arrive | Have the doctor tap Refresh and say the socket dropped and the app fell back. Do not debug live. |
| Backend crashed | Have the API laptop already running a **second** terminal ready with `npm run dev:api`. Restarting takes ~10 seconds and it re-seeds itself. |
| A page throws a blank screen | Reload. The service worker serves the shell from cache. Move to the next step. |

### Pre-demo, 5 minutes before

- [ ] Restart the backend fresh so the seed data is clean
- [ ] `npm run check:api` one last time
- [ ] Both browsers logged in already — do not spend demo time typing passwords
- [ ] Wi-Fi on, and you know **exactly** which toggle turns it off
- [ ] Notifications silenced on both laptops
- [ ] Screen brightness up (judges look from an angle)
- [ ] `GET /api/model` open in a spare tab, for the model question

---

## Do not do these in the last two hours

- Do not start a refactor
- Do not add a dependency
- Do not retrain the model
- Do not change the design system
- Do not merge an unreviewed branch

The last two hours are for rehearsal and for writing the README, not for code. A working
demo you have practised beats a better demo you have not.
