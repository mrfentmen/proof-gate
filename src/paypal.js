// PayPal Invoicing REST API client — sandbox first.
//
// Credentials come ONLY from environment variables:
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV ("sandbox" | "live")
// Nothing is hardcoded. If the credentials are missing, every call fails
// with a clear PayPalNotConfiguredError instead of pretending to work.
//
// API reference: https://developer.paypal.com/docs/api/invoicing/v2/

export class PayPalNotConfiguredError extends Error {
  constructor() {
    super(
      "PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET " +
        "from a sandbox app at developer.paypal.com (see README)."
    );
    this.code = "PAYPAL_NOT_CONFIGURED";
  }
}

export class PayPalApiError extends Error {
  constructor(status, body) {
    let detail = "";
    try {
      const parsed = typeof body === "string" ? JSON.parse(body) : body;
      detail = parsed?.message || parsed?.error_description || "";
      if (Array.isArray(parsed?.details) && parsed.details.length) {
        detail += ` (${parsed.details.map((d) => d.issue ?? d.description ?? "").filter(Boolean).join("; ")})`;
      }
    } catch {
      /* keep raw status only */
    }
    super(`PayPal API error HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.code = "PAYPAL_API_ERROR";
    this.status = status;
  }
}

export function paypalConfigured(env = process.env) {
  return Boolean(env.PAYPAL_CLIENT_ID?.trim() && env.PAYPAL_CLIENT_SECRET?.trim());
}

function baseUrl(env) {
  return env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export class PayPalClient {
  constructor(env = process.env, fetchImpl = fetch) {
    this.env = env;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  assertConfigured() {
    if (!paypalConfigured(this.env)) throw new PayPalNotConfiguredError();
  }

  async getAccessToken() {
    this.assertConfigured();
    if (this.token && Date.now() < this.tokenExpiresAt - 30_000) return this.token;

    const auth = Buffer.from(
      `${this.env.PAYPAL_CLIENT_ID}:${this.env.PAYPAL_CLIENT_SECRET}`
    ).toString("base64");

    const res = await this.fetch(`${baseUrl(this.env)}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const text = await res.text();
    if (!res.ok) throw new PayPalApiError(res.status, text);

    const data = JSON.parse(text);
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.token;
  }

  async request(path, { method = "GET", body } = {}) {
    const token = await this.getAccessToken();
    const res = await this.fetch(`${baseUrl(this.env)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new PayPalApiError(res.status, text);
    return text ? JSON.parse(text) : null;
  }

  // POST /v2/invoicing/invoices — creates a draft invoice.
  // The real API answers 201 with a HATEOAS link object
  // ({ rel, href, method }), NOT a body with an id field: the new
  // invoice's id is the last path segment of href. Normalize here so
  // callers always get { id, ... } (verified live 2026-11-12: reading
  // .id off the raw response sent the follow-up calls to
  // /invoices/undefined/... and PayPal answered 404).
  async createInvoice(payload) {
    const res = await this.request("/v2/invoicing/invoices", { method: "POST", body: payload });
    if (res && !res.id && typeof res.href === "string") {
      const id = res.href.split("/").filter(Boolean).pop();
      if (id) return { ...res, id };
    }
    return res;
  }

  // POST /v2/invoicing/invoices/{id}/send — sends it to the recipient.
  async sendInvoice(invoiceId) {
    return this.request(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, {
      method: "POST",
      body: { send_to_recipient: true },
    });
  }

  // GET /v2/invoicing/invoices/{id} — full invoice, including status.
  async getInvoice(invoiceId) {
    return this.request(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
  }
}
