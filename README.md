# Proof Gate — no proof, no money

A proof-gated payment release for AI agents, built for the **PayPal AI
Hackathon** (submission deadline: Thu Nov 12, 2026, 3:00 PM EST).

An agent that wants to be paid must first present its case — what the
payment is for, how much, who authorized it, and the evidence. A second,
skeptical checker (the **Evidence Auditor**) independently verifies that
proof against the cited sources: it fetches the sources itself and reads
what they actually say. **Pass** → the gate releases a PayPal sandbox
payment. **Fail, blank, or self-authored proof** → the payment dies, with
a written reason recorded in a permanent audit trail.

This productizes the failure mode named in the author's paper
**"Permission in the Blank"** (Elsayad, 2026 —
[Zenodo record 23994480](https://zenodo.org/records/23994480)): a language
model writing its own authorization into an empty target slot. Proof Gate
is the gate that catches exactly that.

## How it works

1. **Claim.** `POST /api/cases` — the agent submits
   `{ agentId, payee, payeeEmail, amount, currency, purpose,
   authorizationClaim, evidence[] }`. Each evidence item carries a URL or
   inline text plus the claim it is meant to support (`supports`).
   Cases persist to a JSON file store (`data/cases.json`).
2. **Check.** `POST /api/cases/:id/audit` — the Evidence Auditor runs:
   - *Proof presented* — at least one evidence item exists.
   - *Source exists* — every URL is really fetched (redirects followed,
     5s timeout); a dead or slow source fails.
   - *Source backs the claim* — the fetched text must contain the key
     terms of the claim it is cited for.
   - *Amount consistency* — amounts cited in the evidence must include
     the requested amount.
   - *Payee consistency* — a recipient named in the evidence must be the
     case's payee.
   - *Authorization is real* — the authorization claim must name an
     external authorizer. **Blank claims, unfilled template placeholders,
     and self-authored claims (agent names itself, or "I authorize…")
     FAIL**, as does a cited authorization document that does not
     corroborate the claim.
3. **Gate.** `POST /api/cases/:id/run` — decision is **APPROVE** only if
   every non-skip check passes. Any failure is a **REJECT** with each
   failed check's written reason stored on the case forever.
4. **Release.** On APPROVE, the gate creates and sends a PayPal sandbox
   **invoice** to the payee (the invoice-on-pass route, using the PayPal
   Invoicing client proven in the author's InvoicePilot project). A
   rejected case has **no payment path at all** — the release endpoint
   refuses it with 409.

## Honesty rules (enforced in code, not just promised)

- **No fake AI.** The checker is a deterministic, rule-based verifier and
  is labeled exactly that — "Evidence Auditor (local-rules, deterministic
  — no AI model)" — in `/api/config`, in every audit trail, and in the UI
  banner. There is no AI key in this product and nothing pretends
  otherwise.
- **No fake payments.** PayPal credentials come only from environment
  variables. Without them, an approved case stops at the status
  `approved_pending_credentials` and the release endpoint answers **503**
  — approved, explicitly **not paid**.
- **No silent fallback.** Every state a case passes through is persisted
  with its full audit trail.

## Run it

```bash
npm test        # 33 tests, node:test, fixture-server based
npm run seed    # load the two demo cases into the store
npm start       # http://localhost:3000  (PORT env to change)
```

Demo cases (also loadable from the UI's "Load demo cases" button):

1. **Legitimate** — `research-writer-agent` asks $250 for publishing the
   "Permission in the Blank" preprint; evidence is the live Zenodo record
   itself, authorization names an external authorizer. Expected: APPROVE.
2. **The attack** — `writer-agent-3` asks $500; the only evidence is its
   own assertion and the authorization slot is **blank**. Expected:
   REJECT, reason: blank authorization.

## What is verified (2026-11-09, by running it)

- `npm test`: **33/33 pass** — case validation and store persistence;
  auditor URL fetch/content/amount/payee checks against a local fixture
  server; the full blank/template/self-authored/no-authorizer family;
  gate state transitions; release refused for rejected/submitted cases
  (409), refused without payee email (422), honest 503 +
  `approved_pending_credentials` with no credentials, and a full
  create+send invoice release against a stubbed PayPal client.
- Server booted and exercised over HTTP: `/api/config`, UI + assets,
  `/api/seed`, `/run` on the legitimate case (APPROVE → 503 pending
  credentials), `/audit` on the attack case (REJECT, blank authorization
  named), `/release` on the rejected case (409), invalid case (400).
- The legitimate demo case was audited against the **live** Zenodo page:
  HTTP 200, 16/17 claim terms matched in the fetched source, APPROVE.

## What still needs Del (the user)

- **PayPal sandbox credentials** — the one real blocker. Create a free
  sandbox app at developer.paypal.com (Apps & Credentials → Sandbox →
  Create App, **Invoicing** feature enabled), then set
  `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` in `.env` (see
  `.env.example`). Until then no live PayPal round trip can be verified,
  and the app says so on screen instead of faking one.
- **Live sandbox round trip** — UNVERIFIED until the credentials exist:
  one approved case released end-to-end against the real sandbox API.

## Hackathon submission checklist

- [x] Working app: case submission, evidence audit, gate decision, ledger UI
- [x] License file (MIT, this repo)
- [ ] Live PayPal sandbox round trip (blocked on credentials, above)
- [ ] Public repo (not created yet — local build only so far)
- [ ] Hosted demo (not deployed yet)
- [ ] Demo video under 3 minutes (Del records/uploads)
- [ ] Devpost text description + AI-tools statement (draft at submission;
      the honest statement is: the checker is deterministic rules, no AI
      model; AI was used as a coding assistant to build the product)

## Layout

```
src/env.js       minimal .env loader (from InvoicePilot)
src/paypal.js    PayPal Invoicing client, sandbox-first, env-only creds (from InvoicePilot)
src/invoice.js   invoice payload builder/validation (from InvoicePilot)
src/cases.js     case schema, validation, JSON file store
src/auditor.js   the Evidence Auditor (fetch + content + authorization checks)
src/gate.js      decision engine + lifecycle transitions
src/payout.js    release: invoice-on-pass, approved cases only
src/seed-data.js the two demo cases
src/seed.js      seed CLI (npm run seed)
src/server.js    node:http server and routes
public/          single-page UI (vanilla JS)
test/            node:test suites (cases, auditor, gate/release)
```
