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
