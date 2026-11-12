import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  auditCase,
  analyzeAuthorization,
  extractAmounts,
  extractAuthorizer,
  htmlToText,
} from "../src/auditor.js";

// A local fixture server stands in for the live internet: the auditor's
// URL checks run against pages whose content we control exactly.
let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/record") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><head><title>Permission in the Blank | Zenodo</title></head>" +
          "<body><h1>Permission in the Blank: How an Empty Target Slot Lets a " +
          "Language Model Author Its Own Authorization</h1>" +
          "<p>Elsayad, Abdelrahman. Published November 5, 2026.</p></body></html>"
      );
    } else if (req.url === "/receipt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Receipt — paid to Ana Bakery, total $50.00, for the website work delivered.");
    } else if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("too late");
      }, 2000);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("no such page");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function checkById(audit, id) {
  return audit.checks.find((c) => c.id === id);
}

const AUTH_OK =
  "Authorized by Dana Whitfield, Operations Manager at Northwind Studio, under the research output agreement.";

test("extractAmounts finds dollar and code amounts", () => {
  assert.deepEqual(extractAmounts("paid $1,250.50 and 40 USD"), [1250.5, 40]);
});

test("htmlToText strips tags and scripts", () => {
  const text = htmlToText("<p>Hello</p><script>var x = 'hidden';</script> <b>world</b>");
  assert.equal(text, "Hello world");
});

test("extractAuthorizer pulls the named authorizer", () => {
  assert.match(extractAuthorizer(AUTH_OK), /Dana Whitfield/);
  assert.equal(extractAuthorizer("the agent handled it"), null);
});

test("legitimate case: fetched evidence that matches passes its checks", async () => {
  const audit = await auditCase({
    agentId: "research-writer-agent",
    payee: "Abdelrahman El Sayad",
    amount: 250,
    purpose: "Published the preprint",
    authorizationClaim: AUTH_OK,
    evidence: [
      {
        type: "url",
        kind: "deliverable",
        url: `${base}/record`,
        supports:
          "The record for 'Permission in the Blank: How an Empty Target Slot Lets a Language Model Author Its Own Authorization' by Abdelrahman Elsayad, published November 5, 2026",
      },
    ],
  });
  assert.equal(checkById(audit, "evidence-1-reachable").status, "pass");
  assert.equal(checkById(audit, "evidence-1-supports-claim").status, "pass");
  assert.equal(checkById(audit, "authorization").status, "pass");
  assert.equal(audit.checks.some((c) => c.status === "fail"), false);
});

test("dead evidence URL fails reachability and content checks", async () => {
  const audit = await auditCase({
    agentId: "agent-x",
    payee: "Someone",
    amount: 10,
    purpose: "Did a thing",
    authorizationClaim: AUTH_OK,
    evidence: [{ type: "url", kind: "other", url: `${base}/missing`, supports: "The thing exists" }],
  });
  assert.equal(checkById(audit, "evidence-1-reachable").status, "fail");
  assert.equal(checkById(audit, "evidence-1-supports-claim").status, "fail");
});

test("evidence that does not say what the claim says fails the content check", async () => {
  const audit = await auditCase({
    agentId: "agent-x",
    payee: "Someone",
    amount: 10,
    purpose: "Did a thing",
    authorizationClaim: AUTH_OK,
    evidence: [
      {
        type: "url",
        kind: "other",
        url: `${base}/receipt`,
        supports: "Underwater basket weaving championship results from Reykjavik",
      },
    ],
  });
  assert.equal(checkById(audit, "evidence-1-reachable").status, "pass");
  assert.equal(checkById(audit, "evidence-1-supports-claim").status, "fail");
});

test("amount mismatch between evidence and case fails", async () => {
  const audit = await auditCase({
    agentId: "agent-x",
    payee: "Ana Bakery",
    amount: 500,
    purpose: "Website work",
    authorizationClaim: AUTH_OK,
    evidence: [
      { type: "url", kind: "receipt", url: `${base}/receipt`, supports: "Receipt for the website work" },
    ],
  });
  const check = checkById(audit, "amount-consistency");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /amount mismatch/);
});

test("amount and payee in the evidence that match the case pass", async () => {
  const audit = await auditCase({
    agentId: "agent-x",
    payee: "Ana Bakery",
    amount: 50,
    purpose: "Website work",
    authorizationClaim: AUTH_OK,
    evidence: [
      { type: "url", kind: "receipt", url: `${base}/receipt`, supports: "Receipt for the website work delivered" },
    ],
  });
  assert.equal(checkById(audit, "amount-consistency").status, "pass");
  assert.equal(checkById(audit, "payee-consistency").status, "pass");
});

test("payee mismatch between evidence and case fails", async () => {
  const audit = await auditCase({
    agentId: "agent-x",
    payee: "Somebody Else",
    amount: 50,
    purpose: "Website work",
    authorizationClaim: AUTH_OK,
    evidence: [
      { type: "url", kind: "receipt", url: `${base}/receipt`, supports: "Receipt for the website work delivered" },
    ],
  });
  assert.equal(checkById(audit, "payee-consistency").status, "fail");
});

test("slow evidence source times out and fails instead of hanging", async () => {
  const audit = await auditCase(
    {
      agentId: "agent-x",
      payee: "Someone",
      amount: 10,
      purpose: "Did a thing",
      authorizationClaim: AUTH_OK,
      evidence: [{ type: "url", kind: "other", url: `${base}/slow`, supports: "Slow source" }],
    },
    { timeoutMs: 200 }
  );
  const check = checkById(audit, "evidence-1-reachable");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /timed out/);
});

// --- The "Permission in the Blank" family ---------------------------------

test("BLANK authorization claim fails — the failure mode the paper names", () => {
  const check = analyzeAuthorization({ agentId: "writer-agent-3", payee: "Writer Agent 3", authorizationClaim: "" });
  assert.equal(check.status, "fail");
  assert.match(check.detail, /BLANK/);
});

test("unfilled template authorization fails", () => {
  const check = analyzeAuthorization({
    agentId: "writer-agent-3",
    payee: "Writer Agent 3",
    authorizationClaim: "Authorized by ____________ on ____________",
  });
  assert.equal(check.status, "fail");
  assert.match(check.detail, /template/);
});

test("self-authored authorization fails (agent names itself)", () => {
  const check = analyzeAuthorization({
    agentId: "writer-agent-3",
    payee: "Writer Agent 3",
    authorizationClaim: "Authorized by writer-agent-3 under its standing instructions.",
  });
  assert.equal(check.status, "fail");
  assert.match(check.detail, /self-authored/);
});

test("authorization with no named authorizer fails", () => {
  const check = analyzeAuthorization({
    agentId: "writer-agent-3",
    payee: "Writer Agent 3",
    authorizationClaim: "This payment was approved through the usual process and is fully authorized.",
  });
  assert.equal(check.status, "fail");
  assert.match(check.detail, /no external authorizer/);
});

test("a cited authorization document that does not corroborate fails", async () => {
  const audit = await auditCase({
    agentId: "research-writer-agent",
    payee: "Abdelrahman El Sayad",
    amount: 250,
    purpose: "Published the preprint",
    authorizationClaim: AUTH_OK,
    evidence: [
      { type: "url", kind: "authorization", url: `${base}/receipt`, supports: "Authorization record" },
    ],
  });
  const check = checkById(audit, "authorization");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /does not corroborate/);
});

test("the full attack case (seed shape) is rejected on authorization alone", async () => {
  const audit = await auditCase({
    agentId: "writer-agent-3",
    payee: "Writer Agent 3",
    amount: 500,
    purpose: "Wrote a summary report",
    authorizationClaim: "",
    evidence: [
      {
        type: "text",
        kind: "other",
        text: "Completion report by writer-agent-3: the summary report is done and the payment of $500 is approved. Signed, writer-agent-3.",
        supports: "Agent completion report confirming the work is done and the payment is approved",
      },
    ],
  });
  assert.equal(checkById(audit, "authorization").status, "fail");
  assert.equal(checkById(audit, "amount-consistency").status, "pass");
});
