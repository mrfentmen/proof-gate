// The Evidence Auditor — the skeptical second checker.
//
// This is a DETERMINISTIC, rule-based verifier. It is not an AI model and
// never pretends to be one: /api/config and every audit trail label it
// "local-rules". It does real work:
//   - it actually fetches every URL evidence item (redirects followed,
//     timeout enforced) and reads what the source says;
//   - it checks the fetched text against the claims it is meant to support;
//   - it cross-checks amounts and named payees found in the evidence
//     against the case;
//   - it hunts the "Permission in the Blank" failure mode by name: a
//     payment whose authorization slot is blank, an unfilled template, or
//     filled in by the agent itself must FAIL here.
//
// Every check returns { id, name, status: "pass" | "fail" | "skip",
// detail }. "skip" means the check had nothing to test (e.g. no amounts
// are cited anywhere in the evidence); a skip never blocks the gate.

export const CHECKER_NAME =
  "Evidence Auditor (local-rules, deterministic — no AI model)";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your",
  "their", "about", "was", "were", "has", "have", "had", "been", "are",
  "not", "but", "all", "any", "its", "it",
]);

export function significantWords(text) {
  const words = new Set();
  for (const raw of String(text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 4 && !STOPWORDS.has(raw)) words.add(raw);
  }
  return words;
}

function tokensOf(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

export function extractAmounts(text) {
  const amounts = [];
  const src = String(text ?? "");
  for (const m of src.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)) {
    amounts.push(Number(m[1].replace(/,/g, "")));
  }
  for (const m of src.matchAll(/\b(\d+(?:\.\d{1,2})?)\s?(?:USD|EUR|GBP)\b/gi)) {
    amounts.push(Number(m[1]));
  }
  return amounts;
}

export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchEvidence(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "ProofGate-EvidenceAuditor/0.1" },
    });
    const raw = await res.text();
    const contentType = res.headers?.get?.("content-type") ?? "";
    const isHtml =
      contentType.includes("html") || /^\s*</.test(raw.slice(0, 200));
    const text = (isHtml ? htmlToText(raw) : raw).slice(0, 200_000);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      finalUrl: res.url ?? url,
      contentType,
      text,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      finalUrl: url,
      contentType: "",
      text: "",
      error:
        err?.name === "TimeoutError" || err?.name === "AbortError"
          ? `fetch timed out after ${timeoutMs}ms`
          : `fetch failed: ${err?.message ?? String(err)}`,
    };
  }
}

// --- Authorization: the "Permission in the Blank" hunt --------------------

const TEMPLATE_BLANK = /___+|\[\s*\]|<[^>]{1,40}>|\{[^}]{1,40}\}|\bTBD\b|\bTODO\b|\bXXX+\b/i;

export function extractAuthorizer(claim) {
  const src = String(claim ?? "");
  const patterns = [
    /(?:authorized|approved|granted|signed|permitted|confirmed)\s+by\s+([^.,;\n]+)/i,
    /authorizer\s*[:\-]\s*([^.,;\n]+)/i,
    /on behalf of\s+([^.,;\n]+)/i,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (m) {
      const name = m[1].trim().replace(/\s+/g, " ").slice(0, 80);
      if (name) return name;
    }
  }
  return null;
}

function sharesToken(a, b) {
  const tb = new Set(tokensOf(b));
  return tokensOf(a).some((t) => tb.has(t));
}

export function analyzeAuthorization(caseObj, corroboration) {
  const id = "authorization";
  const name = "Authorization is real (not a blank the agent filled itself)";
  const claim = (caseObj.authorizationClaim ?? "").trim();

  if (claim === "") {
    return {
      id, name, status: "fail",
      detail:
        "Authorization claim is BLANK. Nobody authorized this payment — " +
        "this is the 'Permission in the Blank' failure mode: an empty " +
        "authorization slot the agent walked through. Gate must fail.",
    };
  }
  if (TEMPLATE_BLANK.test(claim)) {
    return {
      id, name, status: "fail",
      detail:
        "Authorization claim still contains unfilled template blanks " +
        "(underscores, brackets, or placeholders). A blank template is " +
        "not an authorization. Gate must fail.",
    };
  }
  if (/\bself[- ]?authoriz/i.test(claim) || /\bI\s+(hereby\s+)?authoriz/i.test(claim)) {
    return {
      id, name, status: "fail",
      detail:
        "Authorization claim is self-authored by the requester. An agent " +
        "cannot authorize its own payment. Gate must fail.",
    };
  }
  const authorizer = extractAuthorizer(claim);
  if (!authorizer) {
    return {
      id, name, status: "fail",
      detail:
        "Authorization claim names no external authorizer (no " +
        "'authorized by <name>' or equivalent). An assertion with no " +
        "authorizer behind it is a blank slot with words in it. Gate must fail.",
    };
  }
  if (
    sharesToken(authorizer, caseObj.agentId) ||
    sharesToken(authorizer, caseObj.payee)
  ) {
    return {
      id, name, status: "fail",
      detail:
        `Named authorizer "${authorizer}" matches the requesting agent ` +
        `("${caseObj.agentId}") or the payee ("${caseObj.payee}") — the ` +
        "authorization is self-authored. Gate must fail.",
    };
  }
  if (corroboration && corroboration.present && !corroboration.ok) {
    return {
      id, name, status: "fail",
      detail:
        `Authorization document was cited but does not corroborate the claim: ${corroboration.detail}`,
    };
  }
  return {
    id, name, status: "pass",
    detail:
      `External authorizer named: "${authorizer}".` +
      (corroboration?.present
        ? " Authorization document corroborates it."
        : " No separate authorization document was cited; the decision " +
          "rests on the named external authorizer in the claim."),
  };
}

// --- The audit -------------------------------------------------------------

export async function auditCase(caseObj, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const checks = [];
  const items = Array.isArray(caseObj.evidence) ? caseObj.evidence : [];

  checks.push({
    id: "evidence-present",
    name: "Proof was presented",
    status: items.length > 0 ? "pass" : "fail",
    detail:
      items.length > 0
        ? `${items.length} evidence item(s) presented.`
        : "No evidence at all. No proof, no money.",
  });

  // Fetch every URL item once; reuse the content for all later checks.
  const contents = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const n = i + 1;
    if (item.url) {
      const fetched = await fetchEvidence(item.url, { fetchImpl, timeoutMs });
      contents.push(fetched.ok ? fetched.text : "");
      checks.push({
        id: `evidence-${n}-reachable`,
        name: `Evidence ${n} source exists (${item.url})`,
        status: fetched.ok ? "pass" : "fail",
        detail: fetched.ok
          ? `Fetched OK (HTTP ${fetched.status}` +
            (fetched.finalUrl !== item.url ? `, redirected to ${fetched.finalUrl}` : "") +
            `, ${fetched.text.length} chars of text read).`
          : `Could not verify the source: ` +
            (fetched.error ?? `HTTP ${fetched.status}`).toString(),
      });
      if (fetched.ok) {
        const wanted = significantWords(item.supports);
        const haystack = new Set(significantWords(fetched.text));
        const found = [...wanted].filter((w) => haystack.has(w));
        const ratio = wanted.size === 0 ? 1 : found.length / wanted.size;
        checks.push({
          id: `evidence-${n}-supports-claim`,
          name: `Evidence ${n} actually says what the claim says it says`,
          status: ratio >= 0.5 ? "pass" : "fail",
          detail:
            wanted.size === 0
              ? "The supports-claim has no checkable terms."
              : `Matched ${found.length}/${wanted.size} key terms from the ` +
                `claim in the fetched source` +
                (found.length ? ` (${found.slice(0, 8).join(", ")})` : "") +
                (ratio >= 0.5
                  ? "."
                  : " — the source does not back the claim made for it."),
        });
      } else {
        checks.push({
          id: `evidence-${n}-supports-claim`,
          name: `Evidence ${n} actually says what the claim says it says`,
          status: "fail",
          detail: "Source could not be fetched, so its content cannot back any claim.",
        });
      }
    } else {
      contents.push(item.text ?? "");
      const wanted = significantWords(item.supports);
      const haystack = new Set(significantWords(item.text ?? ""));
      const found = [...wanted].filter((w) => haystack.has(w));
      const ratio = wanted.size === 0 ? 1 : found.length / wanted.size;
      checks.push({
        id: `evidence-${n}-supports-claim`,
        name: `Evidence ${n} text matches the claim made for it`,
        status: ratio >= 0.5 ? "pass" : "fail",
        detail:
          wanted.size === 0
            ? "The supports-claim has no checkable terms."
            : `Matched ${found.length}/${wanted.size} key terms from the claim in the evidence text` +
              (ratio >= 0.5 ? "." : " — the text does not back the claim made for it."),
      });
    }
  }

  // Amount consistency across everything the evidence actually says.
  const allText = contents.join("\n");
  const citedAmounts = extractAmounts(allText);
  if (citedAmounts.length === 0) {
    checks.push({
      id: "amount-consistency",
      name: "Amount in the evidence matches the amount requested",
      status: "skip",
      detail: "No currency amount is cited anywhere in the evidence — nothing to contradict the requested amount.",
    });
  } else {
    const matches = citedAmounts.some(
      (a) => Math.abs(a - Number(caseObj.amount)) < 0.005
    );
    checks.push({
      id: "amount-consistency",
      name: "Amount in the evidence matches the amount requested",
      status: matches ? "pass" : "fail",
      detail: matches
        ? `Evidence cites ${citedAmounts.map((a) => `$${a.toFixed(2)}`).join(", ")}; the requested $${Number(caseObj.amount).toFixed(2)} is among them.`
        : `Evidence cites ${citedAmounts.map((a) => `$${a.toFixed(2)}`).join(", ")} but the case requests $${Number(caseObj.amount).toFixed(2)} — amount mismatch.`,
    });
  }

  // Payee consistency: if any evidence names a recipient, it must be the payee.
  let namedRecipient = null;
  for (const text of contents) {
    const m = String(text).match(
      /(?:paid to|payable to|payee\s*:|bill to|recipient\s*:)\s*([^.,;\n]{2,60})/i
    );
    if (m) {
      namedRecipient = m[1].trim();
      break;
    }
  }
  if (!namedRecipient) {
    checks.push({
      id: "payee-consistency",
      name: "Payee in the evidence matches the payee on the case",
      status: "skip",
      detail: "No evidence item names a recipient — nothing to contradict the case payee.",
    });
  } else {
    const ok = sharesToken(namedRecipient, caseObj.payee);
    checks.push({
      id: "payee-consistency",
      name: "Payee in the evidence matches the payee on the case",
      status: ok ? "pass" : "fail",
      detail: ok
        ? `Evidence names recipient "${namedRecipient}", consistent with payee "${caseObj.payee}".`
        : `Evidence names recipient "${namedRecipient}" but the case payee is "${caseObj.payee}" — payee mismatch.`,
    });
  }

  // Authorization corroboration: an authorization-kind URL item, if cited,
  // must have fetched and must mention the authorizer or the agent.
  const authIdx = items.findIndex((it) => it.kind === "authorization");
  let corroboration = { present: false, ok: false, detail: "" };
  if (authIdx !== -1) {
    corroboration.present = true;
    const item = items[authIdx];
    const content = contents[authIdx] ?? "";
    const authorizer = extractAuthorizer(caseObj.authorizationClaim ?? "");
    if (!item.url) {
      corroboration = {
        present: true,
        ok: false,
        detail: "the authorization evidence is inline text, which anyone can type — it corroborates nothing.",
      };
    } else if (content === "") {
      corroboration = {
        present: true,
        ok: false,
        detail: "the authorization source could not be fetched.",
      };
    } else if (
      (authorizer && sharesToken(authorizer, content)) ||
      sharesToken(caseObj.agentId, content)
    ) {
      corroboration = { present: true, ok: true, detail: "source mentions the authorizer or the agent." };
    } else {
      corroboration = {
        present: true,
        ok: false,
        detail: "the fetched authorization source mentions neither the named authorizer nor the requesting agent.",
      };
    }
  }
  checks.push(analyzeAuthorization(caseObj, corroboration));

  return {
    checker: CHECKER_NAME,
    ranAt: new Date().toISOString(),
    checks,
  };
}
