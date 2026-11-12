// Proof Gate server — node:http only, no framework.
//
// Routes:
//   GET  /                         the single-page UI (public/)
//   GET  /api/config               { paypalConfigured, paypalEnv, checker } for the UI banner
//   POST /api/cases                submit a payment case -> 201 case record
//   GET  /api/cases                list cases (newest first)
//   GET  /api/cases/:id            one case, full audit trail included
//   POST /api/cases/:id/audit      run the Evidence Auditor -> decision persisted
//   POST /api/cases/:id/release    release payment (APPROVED cases only)
//   POST /api/cases/:id/run        audit, then attempt release if approved
//   POST /api/seed                 load the two scripted demo cases

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "./env.js";
import { CaseStore, validateCaseInput } from "./cases.js";
import { CHECKER_NAME } from "./auditor.js";
import { runAudit } from "./gate.js";
import { releaseCase, ReleaseError } from "./payout.js";
import { PayPalClient, paypalConfigured } from "./paypal.js";
import { SEED_CASES } from "./seed-data.js";

loadDotEnv();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);

const store = new CaseStore();
const paypal = new PayPalClient();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

async function handleCreateCase(req, res) {
  const body = await readBody(req);
  const errors = validateCaseInput(body);
  if (errors.length > 0) {
    return sendJson(res, 400, { error: "Case is not ready.", validationErrors: errors });
  }
  const record = store.add(body);
  return sendJson(res, 201, record);
}

async function handleAudit(res, id) {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: `No case with id ${id}.` });
  try {
    const updated = await runAudit(store, id);
    return sendJson(res, 200, updated);
  } catch (err) {
    if (err.code === "CASE_FINAL") return sendJson(res, 409, { error: err.message });
    throw err;
  }
}

async function handleRelease(res, id) {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: `No case with id ${id}.` });
  try {
    const { record: updated } = await releaseCase(store, id, paypal);
    return sendJson(res, 200, updated);
  } catch (err) {
    if (err instanceof ReleaseError) {
      const current = store.get(id);
      return sendJson(res, err.status, {
        error: err.message,
        code: err.code,
        case: current,
      });
    }
    throw err;
  }
}

async function handleRun(res, id) {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: `No case with id ${id}.` });
  let updated;
  try {
    updated = await runAudit(store, id);
  } catch (err) {
    if (err.code === "CASE_FINAL") return sendJson(res, 409, { error: err.message });
    throw err;
  }
  if (updated.status !== "approved") {
    // Rejected at the gate: there is no payment path, by design.
    return sendJson(res, 200, updated);
  }
  try {
    const { record: released } = await releaseCase(store, id, paypal);
    return sendJson(res, 200, released);
  } catch (err) {
    if (err instanceof ReleaseError) {
      return sendJson(res, err.status, {
        error: err.message,
        code: err.code,
        case: store.get(id),
      });
    }
    throw err;
  }
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (rel.includes("..")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const data = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, { "Content-Type": MIME[extname(rel)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, 200, {
        paypalConfigured: paypalConfigured(),
        paypalEnv: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox",
        checker: CHECKER_NAME,
        releaseMethod:
          "PayPal invoice created and sent to the payee on APPROVE (sandbox)",
      });
    }
    if (req.method === "POST" && url.pathname === "/api/cases") {
      return await handleCreateCase(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/cases") {
      return sendJson(res, 200, { cases: store.list() });
    }
    if (req.method === "POST" && url.pathname === "/api/seed") {
      const seeded = SEED_CASES.map((input) => store.add(input));
      return sendJson(res, 201, { cases: seeded });
    }
    const caseMatch = url.pathname.match(/^\/api\/cases\/([\w-]+)$/);
    if (req.method === "GET" && caseMatch) {
      const record = store.get(caseMatch[1]);
      if (!record) return sendJson(res, 404, { error: `No case with id ${caseMatch[1]}.` });
      return sendJson(res, 200, record);
    }
    const actionMatch = url.pathname.match(/^\/api\/cases\/([\w-]+)\/(audit|release|run)$/);
    if (req.method === "POST" && actionMatch) {
      if (actionMatch[2] === "audit") return await handleAudit(res, actionMatch[1]);
      if (actionMatch[2] === "release") return await handleRelease(res, actionMatch[1]);
      return await handleRun(res, actionMatch[1]);
    }
    if (req.method === "GET") {
      return await serveStatic(req, res, url.pathname);
    }
    return sendJson(res, 405, { error: "Method not allowed." });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`Proof Gate listening on http://localhost:${PORT}`);
  console.log(
    `PayPal: ${paypalConfigured() ? `configured (${process.env.PAYPAL_ENV === "live" ? "live" : "sandbox"})` : "NOT configured — approved cases will stop at 'approved_pending_credentials'"}`
  );
  console.log(`Checker: ${CHECKER_NAME}`);
  console.log(`Case store: ${store.file}`);
});
