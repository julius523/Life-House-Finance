/**
 * Targeted wipe of test-account data.
 *
 * Unlike POST /api/admin/wipe-data (which nukes EVERY non-user row), this
 * script removes only rows owned by an explicit allowlist of test
 * accounts. Safe to run periodically against production after a QA pass
 * to clear out test fixtures without touching real data.
 *
 * Test accounts are identified by:
 *   1. Email match against the dev-only.example domain (the existing
 *      synthetic seed convention — see seedUsers.ts).
 *   2. Plus any emails listed in the WIPE_TEST_USER_EMAILS env var
 *      (comma-separated). Useful for QA staff accounts.
 *
 * Modes:
 *   --dry-run        (default) — print counts, do not delete.
 *   --commit         — actually delete. Requires --yes and --reason.
 *   --yes            — explicit acknowledgement.
 *   --reason="..."   — free-text reason recorded in activity_log.
 *
 * Exit codes:
 *   0 — succeeded (dry-run or commit).
 *   1 — refusal (no test users matched, or admin/approver caught in
 *       allowlist, or missing required flags in commit mode).
 *   2 — runtime error.
 *
 * NOTE: activity_log rows owned by the test users are NOT deleted —
 * the audit trail is intentionally preserved across wipes. The script
 * also adds one fresh activity_log row describing what it did.
 *
 * Usage from repo root:
 *   pnpm --filter @workspace/scripts run wipe-test-data
 *   pnpm --filter @workspace/scripts run wipe-test-data -- --commit --yes --reason="post-QA cleanup"
 */
import {
  db,
  usersTable,
  expensesTable,
  billsTable,
  receiptsTable,
  activityLogTable,
  notificationsTable,
  manualJournalEntryDraftsTable,
  copilotThreadsTable,
} from "@workspace/db";
import { inArray, like, or, sql } from "drizzle-orm";

const TEST_EMAIL_DOMAIN = "@dev-only.example";

type Args = {
  commit: boolean;
  yes: boolean;
  reason: string | null;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { commit: false, yes: false, reason: null };
  for (const a of argv) {
    if (a === "--commit") out.commit = true;
    else if (a === "--yes") out.yes = true;
    else if (a === "--dry-run") out.commit = false;
    else if (a.startsWith("--reason="))
      out.reason = a.slice("--reason=".length);
  }
  return out;
}

function getAllowlistEmails(): string[] {
  const raw = process.env["WIPE_TEST_USER_EMAILS"] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

async function findTestUsers(): Promise<
  { id: number; email: string; role: string }[]
> {
  const allowlist = getAllowlistEmails();
  const conditions = [like(usersTable.email, `%${TEST_EMAIL_DOMAIN}`)];
  if (allowlist.length > 0) {
    conditions.push(inArray(usersTable.email, allowlist));
  }
  const where =
    conditions.length === 1 ? conditions[0]! : or(...conditions)!;
  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      role: usersTable.role,
    })
    .from(usersTable)
    .where(where);
  return rows;
}

async function countOwned(
  userIds: number[],
  emails: string[],
): Promise<Record<string, number>> {
  if (userIds.length === 0) return {};
  const expenses = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(expensesTable)
    .where(inArray(expensesTable.submittedByEmail, emails));
  const bills = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(billsTable)
    .where(inArray(billsTable.submittedByEmail, emails));
  const receipts = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(receiptsTable)
    .where(inArray(receiptsTable.uploadedBy, userIds));
  const drafts = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(manualJournalEntryDraftsTable)
    .where(inArray(manualJournalEntryDraftsTable.createdByUserId, userIds));
  const threads = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(copilotThreadsTable)
    .where(inArray(copilotThreadsTable.userId, userIds));
  const notifications = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationsTable)
    .where(inArray(notificationsTable.userId, userIds));
  return {
    expenses: expenses[0]?.n ?? 0,
    bills: bills[0]?.n ?? 0,
    receipts: receipts[0]?.n ?? 0,
    manual_journal_entry_drafts: drafts[0]?.n ?? 0,
    copilot_threads: threads[0]?.n ?? 0,
    notifications: notifications[0]?.n ?? 0,
  };
}

async function deleteOwned(
  userIds: number[],
  emails: string[],
): Promise<Record<string, number>> {
  if (userIds.length === 0) return {};
  const out: Record<string, number> = {};
  // Order: rows that other tables FK-reference go last. Posted journal
  // entries are intentionally NOT deleted — the lock trigger in
  // ensureSchema.ts will reject the DELETE, and a test account should
  // never have posted real ledger entries anyway.
  const drafts = await db
    .delete(manualJournalEntryDraftsTable)
    .where(inArray(manualJournalEntryDraftsTable.createdByUserId, userIds));
  out["manual_journal_entry_drafts"] = drafts.rowCount ?? 0;
  const receipts = await db
    .delete(receiptsTable)
    .where(inArray(receiptsTable.uploadedBy, userIds));
  out["receipts"] = receipts.rowCount ?? 0;
  const expenses = await db
    .delete(expensesTable)
    .where(inArray(expensesTable.submittedByEmail, emails));
  out["expenses"] = expenses.rowCount ?? 0;
  const bills = await db
    .delete(billsTable)
    .where(inArray(billsTable.submittedByEmail, emails));
  out["bills"] = bills.rowCount ?? 0;
  const notifications = await db
    .delete(notificationsTable)
    .where(inArray(notificationsTable.userId, userIds));
  out["notifications"] = notifications.rowCount ?? 0;
  const threads = await db
    .delete(copilotThreadsTable)
    .where(inArray(copilotThreadsTable.userId, userIds));
  out["copilot_threads"] = threads.rowCount ?? 0;
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const isProd =
    (process.env["NODE_ENV"] ?? "").toLowerCase() === "production";

  const users = await findTestUsers();
  if (users.length === 0) {
    console.log("No test users matched. Nothing to do.");
    return 1;
  }

  // Refuse to touch admin/approver accounts in production, even if the
  // operator explicitly listed them in WIPE_TEST_USER_EMAILS.
  if (isProd) {
    const privileged = users.filter(
      (u) => u.role === "admin" || u.role === "approver",
    );
    if (privileged.length > 0) {
      console.error(
        `Refusing to wipe in production: matched privileged users: ${privileged
          .map((u) => `${u.email}(${u.role})`)
          .join(", ")}`,
      );
      return 1;
    }
  }

  const userIds = users.map((u) => u.id);
  const emails = users.map((u) => u.email);
  const counts = await countOwned(userIds, emails);

  console.log("Matched test users:");
  for (const u of users) {
    console.log(`  - ${u.email} (id=${u.id}, role=${u.role})`);
  }
  console.log("Owned-row counts:");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(32)} ${v}`);
  }

  if (!args.commit) {
    console.log(
      '\n[dry-run] no rows deleted. Re-run with --commit --yes --reason="..." to apply.',
    );
    return 0;
  }
  if (!args.yes) {
    console.error("--commit requires --yes");
    return 1;
  }
  if (!args.reason || args.reason.trim().length === 0) {
    console.error('--commit requires --reason="..."');
    return 1;
  }

  const deleted = await deleteOwned(userIds, emails);

  await db.insert(activityLogTable).values({
    type: "wipe_test_data",
    description: `wipe-test-data: deleted rows for ${users.length} test user(s). Reason: ${args.reason}`,
    actor: "wipe-test-data-script",
    actorUserId: null,
    metadata: {
      reason: args.reason,
      matchedUsers: users.map((u) => ({ id: u.id, email: u.email })),
      deletedCounts: deleted,
    },
  });

  console.log("\nDeleted-row counts:");
  for (const [k, v] of Object.entries(deleted)) {
    console.log(`  ${k.padEnd(32)} ${v}`);
  }
  console.log("\nactivity_log entry recorded.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
