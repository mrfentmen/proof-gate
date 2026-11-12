// Proof Gate UI — vanilla JS against the /api routes. No framework.

const $ = (id) => document.getElementById(id);

let selectedCaseId = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STATUS_LABEL = {
  submitted: "Submitted — awaiting audit",
  approved: "APPROVED by the gate",
  rejected: "REJECTED by the gate",
  released: "Released — PayPal invoice sent (sandbox)",
  approved_pending_credentials:
    "APPROVED — release pending PayPal credentials (NOT paid)",
  release_failed: "Release failed (see audit trail)",
};

async function loadConfig() {
  const cfg = await api("/api/config");
  const banner = $("configBanner");
  const paypalPart = cfg.paypalConfigured
    ? `PayPal ${esc(cfg.paypalEnv)}: configured. Release method: ${esc(cfg.releaseMethod)}.`
    : "PayPal: NOT configured — the gate still audits and decides, but an approved case stops at “release pending credentials”. No payment is ever faked.";
  banner.textContent = `Checker: ${cfg.checker}. ${paypalPart}`;
  banner.classList.toggle("warn", !cfg.paypalConfigured);
}

// --- Evidence rows ---------------------------------------------------------

function addEvidenceRow(item = {}) {
  const row = document.createElement("div");
  row.className = "evidence-row";
  row.innerHTML = `
    <div class="grid">
      <label>Kind
        <select class="ev-kind">
          <option value="deliverable">deliverable</option>
          <option value="receipt">receipt</option>
          <option value="authorization">authorization</option>
          <option value="other">other</option>
        </select>
      </label>
      <label>URL (fetched &amp; read by the auditor)
        <input class="ev-url" type="url" placeholder="https://…">
      </label>
    </div>
    <label class="block">…or inline text evidence
      <textarea class="ev-text" rows="2"></textarea>
    </label>
    <label class="block">Supports — the claim this item is meant to prove
      <input class="ev-supports" type="text" placeholder="The record for the paper … published …">
    </label>
    <button type="button" class="secondary ev-remove">Remove</button>`;
  row.querySelector(".ev-kind").value = item.kind || "deliverable";
  row.querySelector(".ev-url").value = item.url || "";
  row.querySelector(".ev-text").value = item.text || "";
  row.querySelector(".ev-supports").value = item.supports || "";
  row.querySelector(".ev-remove").addEventListener("click", () => row.remove());
  $("evidenceRows").appendChild(row);
}

function collectEvidence() {
  return [...document.querySelectorAll(".evidence-row")].map((row) => {
    const item = {
      kind: row.querySelector(".ev-kind").value,
      supports: row.querySelector(".ev-supports").value.trim(),
    };
    const url = row.querySelector(".ev-url").value.trim();
    const text = row.querySelector(".ev-text").value.trim();
    if (url) item.url = url;
    if (text) item.text = text;
    return item;
  });
}

// --- Cases -----------------------------------------------------------------

async function submitCase() {
  $("submitError").hidden = true;
  const body = {
    agentId: $("agentId").value.trim(),
    payee: $("payee").value.trim(),
    payeeEmail: $("payeeEmail").value.trim() || undefined,
    amount: Number($("amount").value),
    currency: $("currency").value,
    purpose: $("purpose").value.trim(),
    authorizationClaim: $("authorizationClaim").value,
    evidence: collectEvidence(),
  };
  try {
    const record = await api("/api/cases", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await refreshCases();
    selectCase(record.id);
  } catch (err) {
    const el = $("submitError");
    el.hidden = false;
    el.textContent =
      err.message +
      (err.data?.validationErrors ? " " + err.data.validationErrors.join(" ") : "");
  }
}

async function seed() {
  await api("/api/seed", { method: "POST", body: "{}" });
  await refreshCases();
}

async function refreshCases() {
  const { cases } = await api("/api/cases");
  const list = $("caseList");
  if (cases.length === 0) {
    list.innerHTML = '<p class="muted">No cases yet.</p>';
    return;
  }
  list.innerHTML = "";
  for (const c of cases) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "case-item" + (c.id === selectedCaseId ? " selected" : "");
    el.innerHTML =
      `<strong>${esc(c.agentId)}</strong> → ${esc(c.payee)} · ` +
      `${esc(c.currency)} ${Number(c.amount).toFixed(2)} · ${esc(c.purpose)}<br>` +
      `<span class="status status-${esc(c.status)}">${esc(STATUS_LABEL[c.status] || c.status)}</span>` +
      ` <span class="muted">${esc(c.id)}</span>`;
    el.addEventListener("click", () => selectCase(c.id));
    list.appendChild(el);
  }
}

async function selectCase(id) {
  selectedCaseId = id;
  const record = await api(`/api/cases/${id}`);
  renderDetail(record);
  await refreshCases();
}

function renderDetail(c) {
  $("detailCard").hidden = false;
  $("actionError").hidden = true;
  $("caseDetail").innerHTML = `
    <p><strong>${esc(c.agentId)}</strong> asks to pay <strong>${esc(c.payee)}</strong>
    (${esc(c.payeeEmail || "no email")}) <strong>${esc(c.currency)} ${Number(c.amount).toFixed(2)}</strong></p>
    <p><em>Purpose:</em> ${esc(c.purpose)}</p>
    <p><em>Authorization claim:</em> ${c.authorizationClaim?.trim() ? esc(c.authorizationClaim) : "<strong>(blank)</strong>"}</p>
    <p><em>Status:</em> <span class="status status-${esc(c.status)}">${esc(STATUS_LABEL[c.status] || c.status)}</span></p>
    <p><em>Evidence:</em></p>
    <ul>${c.evidence
      .map(
        (e) =>
          `<li>[${esc(e.kind)}] ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a>` : "inline text"} — ${esc(e.supports)}</li>`
      )
      .join("")}</ul>`;

  const trail = $("auditTrail");
  if (!c.audit) {
    trail.innerHTML = '<p class="muted">Not audited yet. Run the Evidence Auditor.</p>';
  } else {
    const rows = c.audit.checks
      .map(
        (ch) =>
          `<tr><td>${esc(ch.name)}</td><td class="check-${esc(ch.status)}">${esc(ch.status.toUpperCase())}</td><td>${esc(ch.detail)}</td></tr>`
      )
      .join("");
    trail.innerHTML = `
      <h3>Audit trail</h3>
      <p>Checker: ${esc(c.audit.checker)} · ran ${esc(c.audit.ranAt)}</p>
      <p><strong>Decision: ${esc(c.audit.decision)}</strong></p>
      <ul>${c.audit.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      <table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody></table>
      ${c.release ? `<h3>Release</h3><pre>${esc(JSON.stringify(c.release, null, 2))}</pre>` : ""}`;
  }
}

async function act(action) {
  if (!selectedCaseId) return;
  $("actionError").hidden = true;
  try {
    const record = await api(`/api/cases/${selectedCaseId}/${action}`, {
      method: "POST",
      body: "{}",
    });
    renderDetail(record);
    await refreshCases();
  } catch (err) {
    const el = $("actionError");
    el.hidden = false;
    el.textContent = err.message;
    if (err.data?.case) {
      renderDetail(err.data.case);
      await refreshCases();
    }
  }
}

// --- Wire up ---------------------------------------------------------------

$("addEvidenceBtn").addEventListener("click", () => addEvidenceRow());
$("submitCaseBtn").addEventListener("click", submitCase);
$("seedBtn").addEventListener("click", seed);
$("auditBtn").addEventListener("click", () => act("audit"));
$("runBtn").addEventListener("click", () => act("run"));
$("releaseBtn").addEventListener("click", () => act("release"));

addEvidenceRow();
loadConfig().catch((e) => {
  $("configBanner").textContent = `Could not load configuration: ${e.message}`;
  $("configBanner").classList.add("warn");
});
refreshCases().catch(() => {});
