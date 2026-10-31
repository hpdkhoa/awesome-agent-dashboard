# awesome-agent-dashboard

A one-owner web portal over your own Claude Code: display, summarize, Q&A and explore your sessions.

- Claude Code runs only on your own machine, signed in through Anthropic's own flow. The portal never stores a Claude
  token.
- Only your one Google account gets in. The Firestore rules are the lock.
- Every install is one owner: another person runs their own install, with their own `.env`, Firebase project and
  machine.

Status: P2 (inbox: questions, suggestions and results; answers go back to the session).

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
