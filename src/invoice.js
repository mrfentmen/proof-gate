// Structured invoice drafts: validation + PayPal Invoicing payload builder.
// (Reused as-is from InvoicePilot; in Proof Gate the draft is built from an
// approved payment case by src/payout.js.)
//
// A "draft" is the shape consumed by buildInvoicePayload():
// {
//   clientName, recipientEmail,
//   items: [{ name, quantity, unitAmount, note? }],
//   currency, dueDate (YYYY-MM-DD | null), note
// }

export function validateDraft(draft) {
  const errors = [];
  if (!draft || typeof draft !== "object") {
    return ["Draft invoice is missing."];
  }
  if (!draft.clientName && !draft.recipientEmail) {
    errors.push("A client name or a recipient email is required.");
  }
  if (draft.recipientEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.recipientEmail)) {
    errors.push("Recipient email does not look valid.");
  }
  if (!Array.isArray(draft.items) || draft.items.length === 0) {
    errors.push("At least one line item is required.");
  } else {
    draft.items.forEach((item, i) => {
      if (!item.name || String(item.name).trim() === "") {
        errors.push(`Item ${i + 1} needs a name.`);
      }
      const qty = Number(item.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        errors.push(`Item ${i + 1} quantity must be greater than zero.`);
      }
      const amt = Number(item.unitAmount);
      if (!Number.isFinite(amt) || amt <= 0) {
        errors.push(`Item ${i + 1} amount must be greater than zero — check the price in the job description.`);
      }
    });
  }
  if (draft.currency && !/^[A-Z]{3}$/.test(draft.currency)) {
    errors.push("Currency must be a 3-letter code (e.g. USD).");
  }
  if (draft.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate)) {
    errors.push("Due date must be YYYY-MM-DD.");
  }
  return errors;
}

export function draftTotal(draft) {
  return (draft.items ?? []).reduce(
    (sum, item) => sum + Number(item.quantity || 0) * Number(item.unitAmount || 0),
    0
  );
}

function money(value, currency) {
  return { currency_code: currency, value: Number(value).toFixed(2) };
}

export function buildInvoicePayload(draft, { invoiceNumber, invoiceDate } = {}) {
  const errors = validateDraft(draft);
  if (errors.length > 0) {
    const err = new Error(`Invalid draft: ${errors.join(" ")}`);
    err.validationErrors = errors;
    throw err;
  }

  const currency = draft.currency || "USD";
  const today = new Date();
  const dateStr =
    invoiceDate ??
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`;

  const detail = {
    invoice_number:
      invoiceNumber ??
      `IP-${dateStr.replace(/-/g, "")}-${Math.floor(1000 + Math.random() * 9000)}`,
    invoice_date: dateStr,
    currency_code: currency,
    payment_term: { term_type: "NET_30" },
  };
  if (draft.dueDate) {
    detail.payment_term = { term_type: "DUE_ON_DATE_SPECIFIED", due_date: draft.dueDate };
  }
  if (draft.note) detail.note = String(draft.note);

  const recipient = { billing_info: {} };
  if (draft.recipientEmail) recipient.billing_info.email_address = draft.recipientEmail;
  if (draft.clientName) {
    recipient.billing_info.name = {
      given_name: String(draft.clientName),
      surname: "",
    };
  }

  const items = draft.items.map((item) => {
    const built = {
      name: String(item.name),
      quantity: String(item.quantity),
      unit_amount: money(item.unitAmount, currency),
    };
    if (item.note) built.description = String(item.note);
    return built;
  });

  // No top-level "amount" is sent: PayPal computes the invoice total from
  // the line items. Use draftTotal() for display-side totals.
  return {
    detail,
    primary_recipients: [recipient],
    items,
  };
}
