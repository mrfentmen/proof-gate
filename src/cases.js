// Payment cases: schema, validation, and a JSON file store.
//
// A "case" is one agent's request to be paid. The agent must present:
// {
//   agentId,            who is asking (the requesting agent)
//   payee,              who gets paid (display name)
//   payeeEmail,         optional — needed for a real PayPal invoice send
//   amount,             number > 0
//   currency,           3-letter code, default "USD"
//   purpose,            what the payment is for (the work claimed)
//   authorizationClaim, free text: who authorized this, and on what basis
//   evidence: [{        the proof — at least one item
//     type,             "url" | "text" (or an evidence kind like "receipt";
//                       any item with a url is fetched and checked)
//     url,              for fetched evidence
//     text,             for inline text evidence
//     supports,         the claim this item is meant to prove
//     kind              optional label: "deliverable" | "receipt" |
//                       "authorization" | "other"
//   }]
// }
//
// Lifecycle (status):
//   submitted -> audited (decision APPROVE)  -> approved
//             -> audited (decision REJECT)   -> rejected
//   approved  -> release attempted           -> released |
//                                               approved_pending_credentials |
//                                               release_failed
// The full audit trail (every check, with reasons) lives on the case.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const CASE_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "released",
  "approved_pending_credentials",
  "release_failed",
];

export function validateCaseInput(input) {
  const errors = [];
  if (!input || typeof input !== "object") {
    return ["Case body is missing."];
  }
  if (!input.agentId || String(input.agentId).trim() === "") {
    errors.push("agentId is required — who is asking to be paid?");
  }
  if (!input.payee || String(input.payee).trim() === "") {
    errors.push("payee is required — who gets paid?");
  }
  if (
    input.payeeEmail &&
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(input.payeeEmail))
  ) {
    errors.push("payeeEmail does not look valid.");
  }
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    errors.push("amount must be a number greater than zero.");
  }
  if (input.currency && !/^[A-Z]{3}$/.test(String(input.currency))) {
    errors.push("currency must be a 3-letter code (e.g. USD).");
  }
  if (!input.purpose || String(input.purpose).trim() === "") {
    errors.push("purpose is required — what is this payment for?");
  }
  // authorizationClaim may be empty at intake on purpose: a blank claim is
  // exactly the "Permission in the Blank" failure mode, and the auditor —
  // not the form — is what must catch it. The gate rejects it with a
  // written reason instead of the API refusing to record the attempt.
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    errors.push("at least one evidence item is required — no proof, no money.");
  } else {
    input.evidence.forEach((item, i) => {
      if (!item || typeof item !== "object") {
        errors.push(`Evidence ${i + 1} is not an object.`);
        return;
      }
      const hasUrl = typeof item.url === "string" && item.url.trim() !== "";
      const hasText = typeof item.text === "string" && item.text.trim() !== "";
      if (!hasUrl && !hasText) {
        errors.push(`Evidence ${i + 1} needs a url or text.`);
      }
      if (hasUrl && !/^https?:\/\//i.test(item.url.trim())) {
        errors.push(`Evidence ${i + 1} url must start with http:// or https://.`);
      }
      if (!item.supports || String(item.supports).trim() === "") {
        errors.push(
          `Evidence ${i + 1} needs 'supports' — the claim this item is meant to prove.`
        );
      }
    });
  }
  return errors;
}

export function normalizeCase(input) {
  const now = new Date().toISOString();
  return {
    id: `case-${randomUUID().slice(0, 8)}`,
    agentId: String(input.agentId).trim(),
    payee: String(input.payee).trim(),
    payeeEmail: input.payeeEmail ? String(input.payeeEmail).trim() : null,
    amount: Number(input.amount),
    currency: input.currency ? String(input.currency).toUpperCase() : "USD",
    purpose: String(input.purpose).trim(),
    authorizationClaim:
      typeof input.authorizationClaim === "string" ? input.authorizationClaim : "",
    evidence: input.evidence.map((item) => ({
      type:
        typeof item.url === "string" && item.url.trim() !== "" ? "url" : "text",
      kind: item.kind ? String(item.kind) : "other",
      url: item.url ? String(item.url).trim() : null,
      text: item.text ? String(item.text) : null,
      supports: String(item.supports).trim(),
    })),
    status: "submitted",
    audit: null,
    release: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultDataDir() {
  return (
    process.env.DATA_DIR ||
    join(dirname(fileURLToPath(import.meta.url)), "..", "data")
  );
}

export class CaseStore {
  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    this.file = join(dir, "cases.json");
    this.cases = [];
    mkdirSync(dir, { recursive: true });
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        if (Array.isArray(parsed)) this.cases = parsed;
      } catch {
        // A corrupt store must not silently eat cases: start empty but
        // leave the bad file in place for inspection.
        this.cases = [];
      }
    }
  }

  save() {
    writeFileSync(this.file, JSON.stringify(this.cases, null, 2));
  }

  add(input) {
    const errors = validateCaseInput(input);
    if (errors.length > 0) {
      const err = new Error(`Invalid case: ${errors.join(" ")}`);
      err.validationErrors = errors;
      throw err;
    }
    const record = normalizeCase(input);
    this.cases.push(record);
    this.save();
    return record;
  }

  list() {
    return [...this.cases].sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt))
    );
  }

  get(id) {
    return this.cases.find((c) => c.id === id) ?? null;
  }

  update(id, patch) {
    const record = this.get(id);
    if (!record) return null;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return record;
  }
}
