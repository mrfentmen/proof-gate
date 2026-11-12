# Proof Gate — Devpost submission draft (prepared 2026-11-09, not submitted)

Source of truth: `~/workspace/proof-gate/README.md` and `~/workspace/proof-gate/src/`.
Tests re-run this morning: **33/33 pass** (`npm test`, 2026-11-09 ~12:22 UTC).
Deadline: **Thu Nov 12, 2026, 3:00 PM EST**. First prize $12,000; pool $67,500.

## Title
Proof Gate — No Proof, No Money

## Tagline
An AI agent only gets paid when a skeptical second checker verifies its proof against the raw sources. No proof, no money.

## Inspiration
The author's paper "Permission in the Blank" (Elsayad, 2026 — Zenodo record 23994480) names the failure mode: a language model writing its own authorization into an empty target slot. Proof Gate is the gate that catches exactly that, before money moves.

## What it does
An agent that wants to be paid submits a claim: what was done, how much, who the payee is, who authorized it, and the evidence. A second, skeptical checker — the Evidence Auditor — independently verifies that proof: it fetches every cited source itself and tests whether the source actually says what the claim says it says, whether the amounts and payee match, and whether the authorization names a real external authorizer. Pass releases a PayPal sandbox invoice to the payee. Fail, blank, or self-authored proof kills the payment, with a written reason naming exactly which check failed, stored in a permanent audit trail. A rejected case has no payment path at all.

## How we built it
Node.js, zero dependencies, node:http server with a JSON file store. The checker is a deterministic, rule-based verifier: it fetches cited URLs (5s timeout, redirects followed), matches key terms of each claim against the fetched text, and checks amount and payee consistency. The payment side reuses the PayPal Invoicing client proven in the author's earlier InvoicePilot project. The UI is one page: submit a claim, watch the checks run, see pass/fail with reasons and the PayPal result.

## Challenges we ran into
The hard part is honesty: a demo that claims a payment without a real PayPal round trip is a fake. So the product refuses to fake one. Without sandbox credentials an approved case stops at an explicit "approved, not paid" state and the release endpoint answers 503. The checker also had to be a real verifier, not a label: it fetches sources live, so a dead link or a source that does not back the claim fails the case.

## Accomplishments that we're proud of
33 of 33 tests pass. A legitimate case citing the author's real Zenodo record was audited against the live page and approved. The attack case — an agent that wrote its own blank authorization — was rejected with the blank authorization named as the reason. A rejected case cannot be released, period.

## What we learned
Authorization is the weakest link in agent payments, not the payment rail. Verifying the claim against the raw source catches what a signature or a token cannot: proof that was never real in the first place.

## What's next for Proof Gate
Live PayPal sandbox round trip once the sandbox app exists; hosted demo; the under-3-minute video.

## Built With
Node.js, PayPal Invoicing API (sandbox), Zenodo

## AI tools statement (for the Devpost AI-tools field)
Muse (Anthropic) assisted with drafting, code, and test design; the author reviewed all output and takes responsibility for it. The Evidence Auditor itself is a deterministic rule-based verifier, not an AI model, and the product labels it exactly that way in the UI and in every audit trail. No AI key is configured in this product and nothing pretends otherwise.

---

## Submission checklist — status as of 2026-11-09 morning
- [x] Working product built and tested: 33/33 tests pass (re-run 2026-11-09)
- [ ] Public repo with license — code lives in `~/workspace/proof-gate`, LICENSE present, **not a git repo yet and not published**
- [ ] Hosted demo — runs on localhost:3000 only
- [ ] Demo video under 3 minutes — not recorded
- [ ] Devpost description + AI tools statement — drafted above, ready to paste
- [ ] Live PayPal round trip — BLOCKED on Del only: free sandbox app at developer.paypal.com (Apps & Credentials, Sandbox, Create App, Invoicing enabled), then PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET into `.env`. Until then an approved case honestly shows "approved, not paid".
