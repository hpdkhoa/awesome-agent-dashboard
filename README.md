# awesome-agent-dashboard

A one-owner web portal over your own Claude Code: display, summarize, Q&A and explore your sessions.

- Claude Code runs only on your own machine, signed in through Anthropic's own flow. The portal never stores a Claude
  token.
- Only your one Google account gets in. The Firestore rules are the lock.
- Every install is one owner: another person runs their own install, with their own `.env`, Firebase project and
  machine.

Status: P3 (start and stop sessions from the page; tool approvals in the inbox).

## Set up your own install

1. Create a Firebase project. In Authentication, turn on the Google provider only. Add your site's domain to the
   authorized domains.
2. Copy `.env.example` to `.env` and fill it in. `.env` is never committed.
3. Deploy the lock: `npm run rules:deploy`. It writes `firestore.rules` from the template with your email, on your
   machine only, and sends it to your Firebase project.
4. Cloudflare (Workers with static assets, set in `wrangler.jsonc`): build command `npm run build`, deploy command
   `npx wrangler deploy`, and the `VITE_FIREBASE_*` values from your
   `.env` as build variables. Your email is not one of them.

## The bridge (P1)

The bridge runs on each machine that runs Claude Code. It reads Claude Code's own session logs and sends each
session's title, last prompt and reply (secrets removed, cut short), and its token counts to your Firestore. It never
runs `claude` in P1.

```bash
cd bridge
pip install -e .
python -m agent_bridge signin        # once: sign in with your Google account in the browser
python -m agent_bridge sync --dry-run   # count only, write nothing
python -m agent_bridge watch         # sync every minute
```

To keep it running in the background and start it at log on:

```bash
powershell -ExecutionPolicy Bypass -File bridge/install-task.ps1
```

On Linux: `sh bridge/install-service.sh` (a systemd user service). Both take an uninstall flag
(`-Uninstall`, `--uninstall`).

The sign-in keeps a Firebase refresh token in the OS key store (or a user-only file on a machine without one). Over
ssh, run `signin --port 8790 --no-browser` with `ssh -L 8790:localhost:8790` and open the printed link locally.

## The inbox (P2)

Each Claude Code session gets four tools from a small MCP server:

| Tool | Does |
|---|---|
| `inbox_ask` | posts a question with options (one marked recommended) and waits up to 25 minutes for your answer, which comes back as the tool result |
| `inbox_wait` | keeps waiting on an earlier question |
| `inbox_suggest` | posts a suggestion to accept or decline |
| `inbox_result` | posts a result to review |

Register it once for all sessions (user scope):

```bash
claude mcp add --scope user agent-inbox -- python -m agent_bridge inbox
```

An answer to a session that has closed is delivered by `watch`, which resumes that session with
`claude -p --resume <session>`. It needs the Claude Code CLI on this machine, signed in through Anthropic's own sign-in
(or `CLAUDE_BIN` in `.env` pointing to it). The bridge never resumes a session that is still open: each open session's
inbox server sends a heartbeat every minute.

### Claude Code's own question box

A session that asks with Claude Code's built-in question box (not `inbox_ask`) reaches the inbox through a hook. Each
question waits in the inbox for up to 10 minutes; answered there, the answers go back to the session. Not answered in
time, the session's own question box opens. Add it once to `~/.claude/settings.json`:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "AskUserQuestion",
  "hooks": [ { "type": "command", "command": "python -m agent_bridge ask-hook", "timeout": 660 } ] } ] } }
```

### Plans

For planning with rounds of questions, a session opens a plan with `plan_start` (or the page starts one: "Start a
plan" on the Plans tab runs one session with a folder and a topic), posts each new version with
`plan_version` (the whole text and one line on what changed). Every question the session asks, with `inbox_ask` or
its own question box, joins the round of its newest plan's current version. Only you close or reopen a plan, on the
page; closed is a label and nothing on the plan stops (phase moves, Resume, reopened answers all work). The Plans tab
has a board by phase (five columns, a card per plan with Open or Closed, Close or Reopen on the card), and each plan
has a status bar: Status Open or Closed, and Phase as five steps with the current one lit. The Plans tab shows each version, then its questions and your answers, in order (List), or as a tree
(Graph): each version keeps its parent and the answers that made it, as they were then. Reopen an answer on the page and
the session branches the plan from the version that question was asked on; old branches stay, dashed, and one click
chooses a branch. A card per step shows only your answers, with the session's work (its note and the lines it changed)
on hover.

### Plan from a session

"Plan from this session" on a session page reads that session's whole record on your PC: your prompts, the replies,
every tool call and output, and each subagent's final report (the app's own records and hidden thinking are left out).
The bridge writes it as pages of about 150k tokens, one run with no tools writes notes on each page, and then a new
session reads the notes and opens a plan with six parts: goal, summary, rules, lessons and where each was applied,
leftover, and steps. Entries are cited as #n and open the page that holds them. The bridge checks each quote in the notes
against its page and marks any that differ; the run shows how many it checked and marked.

- **Plan versions** change only with the plan's data. A step moving (next, now, done, failed) is a step version: each
  step shows its last reply like a message, older ones folded.
- **Run step** on a step sends "Work on step sN" to the plan's session as a normal message.
- **The archiver** frees a session open in the Claude app for a waiting message. Start one app session in Auto
  with the prompt in `cc/dashboard/ARCHIVER_PROMPT.md`; it waits in `archiver_wait` (no tokens). After a message
  waits 1 minute for an idle app session, the bridge asks it to archive the session, sends the message once the
  process is gone, then asks it to unarchive. Pinned, busy and on-screen sessions are refused and keep waiting.
- **"..." on every record** (session, run, inbox item, plan, plan version, step, money entry, Storage row) has
  Delete record. It lists the record and the records linked below it (a session's runs, plans and inbox items; a
  run's questions and the plan it made; a plan's versions, steps, questions and messages) and deletes them after
  you confirm. The bridge and the inbox server only update records that exist, so a deleted record stays deleted.
  Files on your PC and Claude Code's logs stay.
  A run still running is stopped first (the list says how many). A session open in the Claude app can't be
  stopped from the dashboard; the list warns about it.
- **Messages on a plan** have a kind: Q&A, Shift goal, Add step, Change rule, Audit lesson. Q&A changes nothing; when
  its answer needs a change, the session asks you to switch first.
- **Examples:** every option of a plan question carries one: before and after pictures, a code diff with benchmarks
  marked measured or estimated, or a draft. A plan question without one is refused.

## Notifications on your phone

The bridge sends a Web Push when a run needs your approval, when a run ends (done or failed), for each question
waiting for you (plan questions and the question box too), each suggestion and result, and each new plan version. Once, on the machine
that runs the bridge: `python -m agent_bridge push-setup`. It makes the push key, keeps the private half in the OS key
store, and puts the public half on `meta/push`. `OWNER_EMAIL` from `.env` is the push contact. On the iPhone (iOS 16.4
or newer): open the site in Safari, Share, Add to Home Screen, open it from the Home Screen, sign in, and tap "Turn on
notifications". `python -m agent_bridge push-test` sends a test. A tap on a push opens that approval or run.

## Files from your PC

A file path in a session reply, a run result, an inbox item or a plan (a link, an image or a `path`) opens in a viewer
on the page: images, html pages (with their own images and css), PDF, video, markdown and text. The bytes come straight
from the bridge on your PC through your own Cloudflare Tunnel; nothing is stored in Firestore except the viewer's
address. The bridge checks your Firebase sign-in on each ask (your verified Google account, as the rules do), serves
only files inside `WORK_ROOTS`, never env files or keys, and each link works for 10 minutes. Html runs sandboxed, with
no access to the page or your sign-in.

Set `FILES_URL`, `FILES_PORT` and `SITE_ORIGINS` in `.env` (see `.env.example`), then add a public hostname to your
tunnel: `FILES_URL`'s host to `http://127.0.0.1:FILES_PORT`. `watch` starts the viewer and puts its address on
`meta/files`.

## Money and Rates

The Money tab keeps VND, USD, EUR, gold bar and gold ring entries, typed in Vietnamese number format (`1.000.000`,
`1,5`). An "in" entry can keep the price paid, for profit or loss. Its Balance dashboard shows each asset, the rate it is
valued at, its value in đ, its share and its profit or loss: gold at SJC's own buy price on giavang.net (bar or ring),
dollars and euros at Vietcombank's cash buy. Saving an entry syncs the rates first. The Rates tab has one manual Sync
button for five public sources: Vietcombank's rate feed, HSBC Vietnam's rate table, and the SJC gold bar and plain ring
price from giavang.net, PNJ and Bảo Tín Mạnh Hải. The Worker fetches each source at most once every 5 minutes, and each source reports its own error on its own
line. The page saves only what changed, and the report reads only what the page saved. HSBC's terms allow private use only.

## Storage

The Storage tab counts every collection, lists its documents 50 at a time with their size by Firestore's size rules,
and deletes the ones you pick. A deleted session, day, work type or machine goes on `meta/deleted`, and the bridge
never writes it again.

## Runs from the page (P3)

The Runs tab starts your own Claude Code in a folder registered in `WORK_ROOTS` on that machine, and stops runs it
started. `watch` carries it out within 5 seconds:

```
claude -p <prompt> --output-format json --session-id <new id> --permission-prompt-tool mcp__agent-inbox__inbox_approve
```

Permissions stay on: each tool call that needs approval becomes an Approval in the inbox (Allow or Deny), and a call
with no answer in 25 minutes is denied. The prompt is passed to `claude` as one argument, never through a shell. It
needs the Claude Code CLI on that machine, signed in through Anthropic's own sign-in. Open terminal or desktop-app
sessions cannot be started or stopped from the page.

One switch on the Runs tab, Approvals Manual or Auto, covers every run the page sends: starts, plans, messages and
late answers. It lives on `meta/runs` and the bridge reads it when each run goes. Manual is the rule above. Auto adds
`--permission-mode auto`: Claude Code's safety check approves most steps, and the inbox still gets what it pauses on and
any ask rule. The bridge passes no other mode, so bypass is never used. Desktop windows keep their own mode picker.

The message box on a session page sends a message the same way (`claude -p --resume`). A session counts as closed
unless a turn is running in it, read from the end of its log. A message waits while a turn runs and goes when it
ends. A session open in the app or a terminal waits too, because a second process would split its conversation; the
page points to Remote Control, and you can cancel the message or send it anyway. Open is read from the running
processes: the desktop app runs one `claude` per open session with `--resume=<id>`; a terminal started with plain
`claude` counts for the sessions last used in its folder; a log with no turn end and no process holding the session
counts as closed. "Check now" on a session page shows what the rule sees: open where and since when, and whether a turn
runs. An inbox answer the session did not take live goes the same way, as a message run to the same session, so a
plan stays one session. The session list shows the last
5 days; older sessions load only when asked.

## Checks

- `npm test` runs the rules against the Firestore emulator (needs Java 11 or newer): the owner reads and writes;
  another Google account, an unverified email, a password or anonymous sign-in with the owner's email, and no sign-in
  are all refused. It also tests the secret check.
- `cd bridge && python -m pytest` tests the log reading: one count per message, resumed sessions not counted twice,
  subagents counted, prices, redaction.
- `npm run check:secrets` fails on any email (other than `example.com` and GitHub no-reply), key, token or env file
  that git would commit. The pre-commit hook runs it: `git config core.hooksPath .githooks`. CI runs it and gitleaks.

## Claude Code terms

This project follows Anthropic's terms for Claude Code: one person's own use of their own plan, the unmodified
`claude` program, and no Claude credentials collected, stored or passed on. See
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).

## The local database

The bridge can keep all dashboard data in one SQLite file on its own machine (`%USERPROFILE%\.awesome-agent-dashboard\data.sqlite`)
instead of Firestore. The page then reads and writes through the bridge (POST `/data` on the file viewer's address),
and Firestore becomes the backup: the bridge writes every change to it once a minute and never reads it.

- Switch: stop the bridge, run `python -m agent_bridge import-firestore` once (copies every collection but the money
  ones), start the bridge. Its log says `database: the local file`. Restart open Claude sessions so their inbox servers
  use the file too.
- Back to Firestore: set `DB=firestore` in `.env` and restart.
- Another machine's bridge: set `DB_HOST_URL` to the host bridge's `FILES_URL`; it then calls the host's data API.
- The PC is off: the page shows the Firestore backup, read-only, and tries the bridge again every 30 s.
- Money (entries, rates, gold) stays on Firestore.

### Several boxes

Each box runs its own bridge with its own local database; Firestore keeps only a registry, one document per box
(`bridges/<name>`: its address, when it was last seen, plugged or not). The page asks every plugged box and merges the
answers; a record's changes go back to the box that holds it.

- Plug a box in: install the bridge there, `python -m agent_bridge signin`, set `FILES_URL` (that box's own tunnel
  address) and `SITE_ORIGINS` in its `.env`, run `python -m agent_bridge init-local`, start the bridge. It registers
  itself and shows under Boxes on the dashboard.
- Unplug: Boxes, Unplug. The page stops asking that box; its data and bridge stay as they are. Plug in brings it back.
- A box that is off: its records are missing until its bridge answers; the header names it.
