# awesome-agent-dashboard

A one-owner web portal over your own Claude Code: display, summarize, Q&A and explore your sessions.

- Claude Code runs only on your own machine, signed in through Anthropic's own flow. The portal never stores a Claude
  token.
- Only your one Google account gets in. The Firestore rules are the lock.
- Every install is one owner: another person runs their own install, with their own `.env`, Firebase project and
  machine.

Status: P0 (sign-in and the lock).

## Set up your own install

1. Create a Firebase project. In Authentication, turn on the Google provider only. Add your site's domain to the
   authorized domains.
2. Copy `.env.example` to `.env` and fill it in. `.env` is never committed.
3. Deploy the lock: `npm run rules:deploy`. It writes `firestore.rules` from the template with your email, on your
   machine only, and sends it to your Firebase project.
4. Cloudflare Pages: build command `npm run build`, output folder `dist`, and the `VITE_FIREBASE_*` values from your
   `.env` as the project's environment variables. Your email is not one of them.

## Checks

- `npm test` runs the rules against the Firestore emulator (needs Java 11 or newer): the owner reads and writes;
  another Google account, an unverified email, a password or anonymous sign-in with the owner's email, and no sign-in
  are all refused. It also tests the secret check.
- `npm run check:secrets` fails on any email (other than `example.com` and GitHub no-reply), key, token or env file
  that git would commit. The pre-commit hook runs it: `git config core.hooksPath .githooks`. CI runs it and gitleaks.

## Claude Code terms

This project follows Anthropic's terms for Claude Code: one person's own use of their own plan, the unmodified
`claude` program, and no Claude credentials collected, stored or passed on. See
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
