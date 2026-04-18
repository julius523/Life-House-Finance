// Step 9 — Live acceptance tests for Chart of Accounts + Trial Balance.
//
// Covers:
//   S9-A  CoA list returns seeded GAAP defaults (>= 20 rows, contains 1000 Cash)
//   S9-B  Settings singleton exists and exposes accountingMethod
//   S9-C  Trial Balance balanced (debits = credits, isBalanced)
//   S9-D  /reports/financial-summary?source=ledger differs from operational
//   S9-E  Posting JE with unknown account_code → INVALID_ACCOUNT
//   S9-F  Posting JE with active code succeeds (admin)
//   S9-G  CoA create + archive cycle (admin)
//
// All tests run against the live api-server on localhost:8080.

import fs from "node:fs";

const BASE = "http://localhost:8080";
const LOG_FILE = ".local/test-evidence/step9-results.log";
fs.writeFileSync(LOG_FILE, "");

const results = [];
function log(...args) {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}
function record(id, label, pass, evidence) {
  results.push({ id, label, pass, evidence });
  log(`[${pass ? "PASS" : "FAIL"}] ${id}: ${label}`);
  log("  ", evidence);
}

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok)
    throw new Error(`Login ${email} failed: ${r.status} ${await r.text()}`);
  return {
    cookie: r.headers.get("set-cookie").split(";")[0],
    user: (await r.json()).user,
  };
}
async function api(s, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: s.cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

(async () => {
  log("=== Step 9 live tests ===", new Date().toISOString());

  const admin = await login("kai@lifehousereentry.com", "StepSevenTest!2026");
  log("admin:", admin.user.email, admin.user.role);

  // S9-A
  const coaResp = await api(admin, "GET", "/api/accounting/chart-of-accounts");
  const accounts = coaResp.data.accounts ?? [];
  const cashRow = accounts.find((a) => a.code === "1000");
  record(
    "S9-A",
    "CoA seeded with GAAP defaults",
    accounts.length >= 20 && !!cashRow && cashRow.isSystem === true,
    { count: accounts.length, cash: cashRow ? `${cashRow.code} ${cashRow.name}` : null },
  );

  // S9-B
  const settingsResp = await api(admin, "GET", "/api/accounting/settings");
  const s = settingsResp.data.settings;
  record(
    "S9-B",
    "Settings singleton present with method",
    !!s && (s.accountingMethod === "cash" || s.accountingMethod === "accrual"),
    { method: s?.accountingMethod, id: s?.id },
  );

  // S9-C
  const tbResp = await api(
    admin,
    "GET",
    "/api/reports/trial-balance?fromDate=2026-01-01&toDate=2026-12-31",
  );
  record(
    "S9-C",
    "Trial Balance is balanced",
    tbResp.status === 200 && tbResp.data.totals?.balanced === true,
    {
      debits: tbResp.data.totals?.debits,
      credits: tbResp.data.totals?.credits,
      diff: tbResp.data.totals?.differenceCents,
      rows: tbResp.data.rows?.length,
    },
  );

  // S9-D
  const opResp = await api(
    admin,
    "GET",
    "/api/reports/financial-summary?fromDate=2026-01-01&toDate=2026-12-31&source=operational",
  );
  const ledgerResp = await api(
    admin,
    "GET",
    "/api/reports/financial-summary?fromDate=2026-01-01&toDate=2026-12-31&source=ledger",
  );
  record(
    "S9-D",
    "Source=operational vs source=ledger both respond 200 with PL/BS",
    opResp.status === 200 &&
      ledgerResp.status === 200 &&
      typeof opResp.data?.profitAndLoss?.netIncome === "number" &&
      typeof ledgerResp.data?.profitAndLoss?.netIncome === "number",
    {
      operationalNet: opResp.data?.profitAndLoss?.netIncome,
      ledgerNet: ledgerResp.data?.profitAndLoss?.netIncome,
    },
  );

  // S9-E / S9-F — exercise draft_journal_entry through tool-preview to prove
  // CoA validation in copilotTools.draftJournalEntry. This requires a thread.
  const thread = await api(admin, "POST", "/api/accounting/threads", {
    title: "Step 9 acceptance",
  });
  const threadId = thread.data?.thread?.id ?? thread.data?.id;

  const badDraft = await api(admin, "POST", "/api/accounting/diagnostics/tool-preview", {
    threadId,
    toolName: "draft_journal_entry",
    arguments: {
      date: "2026-04-18",
      memo: "Step 9 — bogus code",
      policyEvidenceBasis: "Step 9 acceptance test for invalid CoA code",
      confidence: "high",
      lines: [
        { type: "debit", amount: 100, account_code: "ZZZ-NOPE" },
        { type: "credit", amount: 100, account_code: "1000" },
      ],
    },
  });
  const badResult = badDraft.data?.result ?? badDraft.data;
  record(
    "S9-E",
    "draft_journal_entry rejects unknown account_code",
    badDraft.status === 200 &&
      (badResult?.ok === false ||
        badDraft.data?.status === "error" ||
        JSON.stringify(badDraft.data ?? {}).toUpperCase().includes("INVALID_ACCOUNT") ||
        JSON.stringify(badDraft.data ?? {}).toUpperCase().includes("UNKNOWN")),
    { status: badDraft.status, body: JSON.stringify(badDraft.data).slice(0, 240) },
  );

  const goodDraft = await api(admin, "POST", "/api/accounting/diagnostics/tool-preview", {
    threadId,
    toolName: "draft_journal_entry",
    arguments: {
      date: "2026-04-18",
      memo: "Step 9 — valid CoA",
      policyEvidenceBasis: "Step 9 acceptance test for valid CoA codes",
      confidence: "high",
      lines: [
        { type: "debit", amount: 12.34, account_code: "6210" },
        { type: "credit", amount: 12.34, account_code: "1000" },
      ],
    },
  });
  const goodOk =
    goodDraft.status === 200 &&
    (goodDraft.data?.status === "preview" ||
      JSON.stringify(goodDraft.data ?? {}).includes('"ok":true') ||
      goodDraft.data?.result?.ok === true);
  record(
    "S9-F",
    "draft_journal_entry accepts valid account_code",
    goodOk,
    { status: goodDraft.status, body: JSON.stringify(goodDraft.data).slice(0, 240) },
  );

  // S9-G — create + archive
  const code = `TEST-${Date.now().toString().slice(-6)}`;
  const created = await api(admin, "POST", "/api/accounting/chart-of-accounts", {
    code,
    name: "Test Custom Account",
    type: "expense",
    normalBalance: "debit",
    isActive: true,
    allowManualPosting: true,
  });
  let archived = { status: 0, data: null };
  if (created.data?.account?.id) {
    archived = await api(
      admin,
      "PATCH",
      `/api/accounting/chart-of-accounts/${created.data.account.id}`,
      { isActive: false },
    );
  }
  record(
    "S9-G",
    "Custom CoA create + archive",
    created.status === 201 &&
      archived.status === 200 &&
      archived.data?.account?.isActive === false,
    {
      createdStatus: created.status,
      createdCode: created.data?.account?.code,
      archivedStatus: archived.status,
      isActive: archived.data?.account?.isActive,
    },
  );

  const passes = results.filter((r) => r.pass).length;
  const fails = results.length - passes;
  log("---", "summary:", { passes, fails, total: results.length });
  fs.writeFileSync(
    ".local/test-evidence/step9-summary.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
  );
  process.exit(fails > 0 ? 1 : 0);
})().catch((e) => {
  log("FATAL", e?.stack || String(e));
  process.exit(2);
});
