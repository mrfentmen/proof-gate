import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CaseStore, validateCaseInput, normalizeCase } from "../src/cases.js";

const GOOD = {
  agentId: "research-writer-agent",
  payee: "Abdelrahman El Sayad",
  payeeEmail: "contactae2000@gmail.com",
  amount: 250,
  currency: "USD",
  purpose: "Published the preprint",
  authorizationClaim: "Authorized by Dana Whitfield, Operations Manager",
  evidence: [{ url: "https://example.org/record", supports: "The record exists" }],
};

function tempStore() {
  return new CaseStore(mkdtempSync(join(tmpdir(), "proofgate-cases-")));
}

test("a complete case validates clean", () => {
  assert.deepEqual(validateCaseInput(GOOD), []);
});

test("missing agent, payee, purpose, and evidence are errors", () => {
  const errors = validateCaseInput({ amount: 10 });
  assert.ok(errors.some((e) => e.includes("agentId")));
  assert.ok(errors.some((e) => e.includes("payee is required")));
  assert.ok(errors.some((e) => e.includes("purpose")));
  assert.ok(errors.some((e) => e.includes("evidence")));
});

test("zero or negative amount is an error", () => {
  assert.ok(validateCaseInput({ ...GOOD, amount: 0 }).length > 0);
  assert.ok(validateCaseInput({ ...GOOD, amount: -5 }).length > 0);
});

test("evidence with neither url nor text is an error", () => {
  const errors = validateCaseInput({
    ...GOOD,
    evidence: [{ supports: "nothing behind this" }],
  });
  assert.ok(errors.some((e) => e.includes("url or text")));
});

test("evidence without a supports claim is an error", () => {
  const errors = validateCaseInput({
    ...GOOD,
    evidence: [{ url: "https://example.org/x" }],
  });
  assert.ok(errors.some((e) => e.includes("supports")));
});

test("a blank authorization claim is ACCEPTED at intake (the auditor must be what catches it)", () => {
  assert.deepEqual(validateCaseInput({ ...GOOD, authorizationClaim: "" }), []);
});

test("normalizeCase defaults currency, types url evidence, starts as submitted", () => {
  const record = normalizeCase({ ...GOOD, currency: undefined });
  assert.equal(record.currency, "USD");
  assert.equal(record.status, "submitted");
  assert.equal(record.evidence[0].type, "url");
  assert.equal(record.audit, null);
  assert.ok(record.id.startsWith("case-"));
});

test("store persists cases to disk and reloads them", () => {
  const dir = mkdtempSync(join(tmpdir(), "proofgate-cases-"));
  const store = new CaseStore(dir);
  const added = store.add(GOOD);
  const reloaded = new CaseStore(dir);
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.get(added.id).agentId, GOOD.agentId);
});

test("store.add refuses an invalid case", () => {
  const store = tempStore();
  assert.throws(() => store.add({ amount: 5 }), /Invalid case/);
});
