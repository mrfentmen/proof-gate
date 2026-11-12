// The money step: release a payment for an APPROVED case — and only an
// approved case.
//
// Design decision (from PROOF_GATE_SPEC.md): the release is a PayPal
// invoice created and sent to the payee on pass — the "invoice-on-pass"
// route, using the same PayPal Invoicing client InvoicePilot verified.
// The UI and API say exactly that ("invoice sent"), never "cash paid
// out": a PayPal Payouts integration would need the Payouts feature
// enabled on the sandbox app, which cannot be verified without the
// user's credentials.
//
// Honesty rules enforced here:
//   - A case that is not APPROVED cannot be released. Ever. (409)
//   - Without PayPal credentials, release records the honest state
//     "approved_pending_credentials" and answers 503 — the case is
//     approved but NOT paid, and nothing anywhere claims otherwise.
//   - A PayPal API failure records "release_failed" with the error.

import { buildInvoicePayload } from "./invoice.js";
import { PayPalNotConfiguredError, PayPalApiError } from "./paypal.js";

export class ReleaseError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function caseToDraft(record) {
  return {
    clientName: record.payee,
    recipientEmail: record.payeeEmail,
    items: [
      {
        name: String(record.purpose).slice(0, 120),
        quantity: 1,
        unitAmount: Number(record.amount),
        note: `Proof Gate case ${record.id} — approved by the Evidence Auditor`,
      },
    ],
    currency: record.currency,
    dueDate: null,
    note: `Released through Proof Gate after evidence audit APPROVE (case ${record.id}).`,
  };
}

// paypalClient is injected so tests can drive every branch without
// network or credentials.
export async function releaseCase(store, id, paypalClient) {
  const record = store.get(id);
  if (!record) return null;

  if (record.status === "released") {
    throw new ReleaseError(
      409,
      `Case ${id} was already released (PayPal invoice ${record.release?.paypalInvoiceId ?? "unknown"}).`,
      "ALREADY_RELEASED"
    );
  }
  if (record.status !== "approved" && record.status !== "approved_pending_credentials") {
    throw new ReleaseError(
      409,
      `Case ${id} is "${record.status}", not approved. The gate only releases approved cases — no proof, no money.`,
      "CASE_NOT_APPROVED"
    );
  }
  if (!record.payeeEmail) {
    throw new ReleaseError(
      422,
      `Case ${id} has no payeeEmail, so there is nobody to send the PayPal invoice to.`,
      "PAYEE_EMAIL_MISSING"
    );
  }

  const payload = buildInvoicePayload(caseToDraft(record));
  try {
    const created = await paypalClient.createInvoice(payload);
    const invoiceId = created.id;
    await paypalClient.sendInvoice(invoiceId);
    const full = await paypalClient.getInvoice(invoiceId).catch(() => null);
    const release = {
      releasedAt: new Date().toISOString(),
      method: "paypal-invoice",
      paypalInvoiceId: invoiceId,
      paypalStatus: full?.status ?? "SENT",
      recipientLink:
        (full?.links ?? []).find((l) => l.rel === "payer-view")?.href ?? null,
    };
    const updated = store.update(id, { status: "released", release });
    return { record: updated, release };
  } catch (err) {
    if (err instanceof PayPalNotConfiguredError) {
      const release = {
        attemptedAt: new Date().toISOString(),
        method: "paypal-invoice",
        state: "pending_credentials",
        error: err.message,
      };
      store.update(id, {
        status: "approved_pending_credentials",
        release,
      });
      throw new ReleaseError(503, err.message, err.code);
    }
    if (err instanceof PayPalApiError) {
      store.update(id, {
        status: "release_failed",
        release: {
          attemptedAt: new Date().toISOString(),
          method: "paypal-invoice",
          state: "failed",
          error: err.message,
        },
      });
      throw new ReleaseError(502, err.message, err.code);
    }
    throw err;
  }
}
