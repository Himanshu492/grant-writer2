# Grants Portal

One place for company knowledge, grant questions and applications.

The problem it solves: company facts live in people's heads and inboxes, so every grant application means asking
the same people the same questions and retyping the same answers. Here, a fact or an answer is entered **once**,
stored, and reused everywhere. The team's only job is to supply information the portal does not have yet.

- **Home** – what needs you now: grants due soon, urgent ones, grants a few answers from done, and the next
  questions to answer (each distinct question once, however many grants ask it).
- **Grants** – every grant with what the funder is looking for, its real application questions in form order,
  completion status, and an **Apply** button.
- **Questions** – all questions across all grants, grouped so identical ones are answered once.
- **Company knowledge** – the single source of truth: company facts plus every approved answer.
- **Documents** – upload a file once (pitch deck, financials…); every grant that asks for that kind of file uses it.
- **Applications** – what the browser agent has done and is doing.

## How answers get reused

1. **Same question, another grant** – approving an answer fills the identical question on every other grant
   (short facts are approved outright; narrative answers are pre-filled for a one-click confirm).
2. **Different wording, same fact** – open questions are checked against the whole knowledge base by the model
   (DeepSeek). "Founder LinkedIn" is answered from a stored LinkedIn URL, "What year were you founded?" from the
   founding date. These arrive as *suggested* answers with a note saying where they came from.
3. **Nothing known** – the question is marked *Needs your input*, with a line saying exactly what is missing.
   **Draft with AI** writes narrative answers from the knowledge base, tailored to what that funder looks for,
   and marks any fact it did not have instead of inventing one.

Every approved answer becomes knowledge, and open questions are re-checked every five minutes.

## Where the grant questions come from

`data/grants/*.json` holds one file per program, researched against the funder's own site. Each records how its
questions were obtained (`questions_verification`):

| Level | Meaning |
|---|---|
| `live_form` | read from the funder's live application form |
| `official_document` | from the funder's own guidance / preview / solicitation |
| `third_party_copy` | unofficial copy, used only when the funder publishes nothing (clearly labelled in the UI) |
| `not_accessible` | the form is behind a login: **no questions are listed** rather than guessed |
| `agent_scan` | read off the live form by the browser agent (after a human logged in) |

Nothing is invented. For login-walled forms use **Scan the live form** on the grant page.

## The browser agent

Pressing **Apply** queues a run. A runner on a VM picks it up, opens the application in a visible Chrome, fills in
the approved answers, attaches documents, and reports progress and screenshots back.

- **Test mode is the default**: the form is filled but never submitted. Real submission is switched on per grant.
- The agent **hands over to a human** for logins, account creation, CAPTCHAs, verification codes and payments. The
  run shows *Needs you* with a link to the agent's browser (live view); do the step, press **I'm done — continue**.
  The browser profile is persistent, so a login done once is still there next time.
- Fields found on the form that the portal did not know about are added to the grant as new questions.
- The agent's browser is always one click away in the floating window in the corner. It opens by itself when a run
  starts or the agent needs a person, and expanded it is fully usable for logins and CAPTCHAs.
- Questions that a form only shows for certain answers ("State" for US companies) stay hidden until they apply.
- Two engines: the built-in one (default; in test mode it cannot press a final Submit) and the Hermes agent already
  on the VM (chosen in Settings; falls back to the built-in engine if it cannot run a job).
- A practice grant (**Sandbox Innovation Grant**) is built in for trying all of this safely.

Install or update the runner on the VM with the one-line command shown in **Settings → Browser agent**. It needs
Debian/Ubuntu and root, and sets up systemd services (`grants-agent`, a virtual screen, and the live view).
Logs: `journalctl -u grants-agent -f`.

## Architecture

Everything runs on Cloudflare as a single Worker.

```
src/worker/        API (Hono): auth, grants, questions, knowledge, documents, runs, agent API, sandbox form
  ai.ts            DeepSeek: knowledge inference + "Draft with AI"
  data.ts          answer reuse, progress, syncing verified questions without losing answers
  agent.ts         run queue + API the VM runner talks to (also proxies the model so the key stays in Cloudflare)
  legacy.ts        one-time import from the old system (grants + answered questions only)
web/               React UI (Vite), packed into the Worker at build time
agent/             VM runner, installer, grantctl helper, Hermes skill
data/grants/       verified grant data, bundled into the Worker and applied automatically on deploy
migrations/        D1 schema
```

- **D1** `freehealth-grants-portal` – grants, questions (+answers), knowledge, documents, runs
- **R2** `freehealth-grants-portal` – uploaded documents and run screenshots (separate from the old bucket)
- **Sign-in** – people use `grants.freehealth.ai`, which sits behind Cloudflare Access (Google). The portal verifies the
  Access token and then checks the email against its own short list (Settings, People), so only listed people get
  in and removing someone takes effect immediately. There is no password in production.
- **Agent address** – the VM runner uses the `workers.dev` address (`AGENT_PORTAL_URL`), because Access would turn its
  API calls away. That address only serves the agent API, the runner files and the practice form; pages redirect to
  the public address.
- **Cron** every 5 minutes – applies new grant data, re-checks open questions, fails abandoned runs

## Development and deployment

```bash
npm install
```

```bash
npm run build
```

```bash
npx wrangler d1 migrations apply DB --local
```

```bash
npx wrangler dev
```

Local secrets go in `.dev.vars` (git-ignored); add `DEV_PASSWORD_LOGIN=1` and `PORTAL_PASSWORD=...` there to sign in
locally without Cloudflare Access. In production they are Worker secrets, never committed:

| Secret | Purpose |
|---|---|
| `ALLOWED_EMAILS` | comma-separated emails allowed in until the list is edited in Settings |
| `SESSION_SECRET` | signs login cookies |
| `AGENT_TOKEN` | bearer token for the VM runner |
| `DEEPSEEK_API_KEY` | AI drafting and knowledge inference |

Deploy:

```bash
npm run deploy
```

`wrangler.legacy.jsonc` is the same deployment with read access to the old system's database and bucket added. It
was used once to import the old grants list and answered questions (Settings → *Import from the old system*).
