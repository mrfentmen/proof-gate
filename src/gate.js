// The gate: turns an audit trail into a decision, and owns the case
// lifecycle transitions.
//
// Rule (from the spec, no exceptions): a case is payable only when EVERY
// non-skip check passes. One failure rejects the whole case, and the
// rejection carries the written reason of each failed check. There is no
// override endpoint and no partial pass.

import { auditCase } from "./auditor.js";

export function decide(checks) {
  const failures = checks.filter((c) => c.status === "fail");
  const decision = failures.length === 0 ? "APPROVE" : "REJECT";
  return {
    decision,
    reasons:
      decision === "APPROVE"
        ? [`All ${checks.filter((c) => c.status === "pass").length} checks passed.`]
        : failures.map((c) => `${c.name}: ${c.detail}`),
    failures: failures.map((c) => c.id),
  };
}

// Run the auditor over a stored case and persist the trail + decision.
// Returns the updated case record.
export async function runAudit(store, id, auditorOpts = {}) {
  const record = store.get(id);
  if (!record) return null;
  if (record.status === "released") {
    const err = new Error("Case already released; its audit trail is final.");
    err.code = "CASE_FINAL";
    throw err;
  }
  const audit = await auditCase(record, auditorOpts);
  const { decision, reasons, failures } = decide(audit.checks);
  return store.update(id, {
    status: decision === "APPROVE" ? "approved" : "rejected",
    audit: { ...audit, decision, reasons, failures },
    release: null,
  });
}
