# `prompts/` — work division for three people

These are hand-off briefs. Each one is written to be **pasted into Kiro** (or read directly)
by the person who owns that area.

## Read in this order

| File | Who | When |
| --- | --- | --- |
| `00-SHARED-CONTEXT.md` | **All three** | First, before touching anything |
| `01-PERSON-A-ml-and-backend.md` | Person A | Then, in parallel |
| `02-PERSON-B-field-app-offline-voice.md` | Person B | Then, in parallel |
| `03-PERSON-C-dashboard-realtime-chatbot.md` | Person C | Then, in parallel |
| `04-INTEGRATION-AND-DEMO.md` | **All three, together** | Last, with all laptops on the venue network |

`00` is not optional. It records what is already verified working versus what has never been
run, and skipping it means someone rebuilds finished code.

## The honest state of the project

The build is roughly **90% written**. The backend is verified (73/73 assertions pass — four
bugs found by code review, including one that blocked the teleconsult demo step, are already
fixed and covered by their own regression checks). The frontend typechecks and produces a
working PWA build — but **it has never been opened in a browser**, so all of its runtime
behaviour is unverified.

So this is a **run it, find the bugs, fix, rehearse** phase, not a build phase. Plan your time
accordingly: expect the afternoon to go on runtime bugs you cannot see yet, and protect at
least 90 minutes at the end for `04`.

Four specific bugs are already identified by code review and listed in `00`. BUG-1 blocks demo
step 3 and needs Person A and Person B to coordinate — do it early.

## How to use one of these with Kiro

Open the file, then in Kiro:

```
Read #prompts/00-SHARED-CONTEXT.md and #prompts/02-PERSON-B-field-app-offline-voice.md.
Start at task B1 and work through in order. Stop after each task and tell me what
you found before moving on.
```

Two things that make this work much better:

- **Feed one task at a time**, not the whole file. These briefs have acceptance checks per
  task for exactly that reason.
- **Say what you observed.** Most of the remaining work is diagnosing runtime behaviour, and
  Kiro cannot see your browser. "The pending counter stays at 2 after going back online" is
  actionable; "sync is broken" is not.

## Staying out of each other's way

Three people, one repo. `00-SHARED-CONTEXT.md` has the full file-ownership table — the short
version:

- **A** → `ml/`, `shared/`, `backend/`, root `README.md`
- **B** → the worker-facing pages, form components, `lib/db.ts`, `lib/sync.ts`, `lib/speech.ts`, `i18n/`
- **C** → dashboard, district, chatbot, teleconsult, patients, model-card pages, `charts.tsx`, `risk.tsx`, `lib/socket.ts`

Shared files that need a heads-up in chat before editing: `App.tsx`, `types.ts`,
`index.css`, `AppShell.tsx`, `lib/api.ts`, `frontend/package.json`.

Use git branches, one per person, and **merge into `main` at least every 90 minutes**. Do not
sync this folder over Dropbox or a shared drive — two editors on one file will silently lose
work.
