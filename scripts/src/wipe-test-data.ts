/**
 * Targeted wipe of test-account data.
 *
 * Unlike POST /api/admin/wipe-data (which nukes EVERY non-user row),
 * this script removes only rows owned by an explicit allowlist of test
 * accounts. Safe to run periodically against production after a QA
 * pass to clear out test fixtures without touching real data.
 *
 * Test-account selection is intentionally narrow:
 *   - Always: emails matching the @dev-only.example domain (the
 *     existing synthetic seed convention — see seedUsers.ts).
 *   - Additionally in non-production: emails listed in
 *     WIPE_TEST_USER_EMAILS (comma-separated).
 *
 * In production, WIPE_TEST_USER_EMAILS is intentionally IGNORED — only
 * the @dev-only.example domain match is honoured. A typo in the env
 * var must not be able to delete a real user's data.
 *
 * Modes:
 *   --dry-run        (default) — print counts, do not delete.
 *   --commit         — actually delete. Requires --yes and --reason.
 *   --yes            — explicit acknowledgement.
 *   --reason="..."   — free-text reason recorded in activity_log.
 *
 * What gets deleted (per matched test user):
 *   - expenses where submitted_by_email ∈ matched_emails
 *   - bills    where submitted_by_email ∈ matched_emails
 *   - receipts where uploaded_by ∈ matched_user_ids
 *   - manual_journal_entry_drafts where created_by_user_id OR
 *     submitted_by_user_id ∈ matched_user_ids
 *   - accounting_source_links where created_by_user_id ∈ matched_user_ids
 *   - journal_entry_export_schedules where created_by_user_id
 *     ∈ matched_user_ids
 *   - copilot_threads, copilot_messages (cascade), copilot_tool_calls
 *     (cascade) where user_id ∈ matched_user_ids
 *   - notifications where user_id ∈ matched_user_ids
 *
 * What is intentionally NOT deleted:
 *   - journal_entries / journal_entry_lines: posted JEs are immutable
 *     (the lock trigger in ensureSchema.ts will reject any DELETE). A
 *     test account should never have posted real ledger entries; if
 *     it has, that is itself a finding and the script will refuse to
 *     run (see "refusal" below).
 *   - activity_log: audit trail is preserved across wipes by design.
 *     One fresh activity_log row IS added describing the wipe.
 *
 * Refusals (exit 1):
 *   - No test users matched.
 *   - In production: any matched user does not end with the
 *     @dev-only.example domain (i.e. someone tried to use
 *     WIPE_TEST_USER_EMAILS in prod).
 *   - In production: any matched user has role admin/approver.
 *   - Any matched user has posted journal entries (would be a real
 *     data loss, and the lock trigger would block the delete anyway).
 *   - --commit without --yes or without --reason.
 *
 * Exit codes:
 *   0 — succeeded (dry-run or commit).
 *   1 — refusal as above.
 *   2 — runtime error.
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
  accountingSourceLinksTable,
  journalEntryExportSchedulesTable,
  copilotThreadsTable,
  copilotMessagesTable,
  copilotToolCallsTable,
  journalEntriesTable,
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

function isProduction(): boolean {
  return (process.env["NODE_ENV"] ?? "").toLowerCase() === "production";
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
  const conditions = [like(usersTable.email, `%${TEST_EMAIL_DOMAIN}`)];
  // Allowlist is dev-only on purpose: we never want WIPE_TEST_USER_EMAILS
  // to be the authority on "is this a test account" in production.
  if (!isProduction()) {
    const allowlist = getAllowlistEmails();
    if (allowlist.length > 0) {
      conditions.push(inArray(usersTable.email, allowlist));
    }
  }
  const where =
    conditions.length === 1 ? conditions[0]! : or(...conditions)!;
  return db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      role: usersTable.role,
    })
    .from(usersTable)
    .where(where);
}

type Counts = Record<string, number>;

async function countOwned(
  userIds: number[],
  emails: string[],
): Promise<Counts> {
  const c = async (q: Promise<{ n: number }[]>) =>
    (await q)[0]?.n ?? 0;
  return {
    expenses: await c(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(expensesTable)
        .where(inArray(expensesTable.submittedByEmail, emails)),
    ),
    bills: await c(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(billsTable)
        .where(inArray(billsTable.submittedByEmail, emails)),
    ),
    receipts: await c(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(receiptsTable)
        .where(inArray(receiptsTable.uploadedBy, userIds)),
    ),
    manual_journal_entry_drafts: await c(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(manualJournalEntryDraftsTable)
        .where(
          or(
            inArray(manualJournalEntryDraftsTable.createdByUserId, userIds),
            inArray(
              manualJournalEntryDraftsTable.submittedByUserId,
              userIds,
            ),
          )!,
        ),
    ),
    accounting_source_links: await c(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(accountingSourceLinksTable)
        .where(inArray(accountingSourceLinksTable.createdByUserId, userIds)),
    ),
    journal_entry_export_schedules: await c(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(journalEntryExportSchedulesTable)
        .where(
          inArray(journalEntryExportSchedulesTable.createdByUserId, userIds),
        ),
    ),
    copilot_threads: await c(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(copilotThreadsTable)
        .where(inArray(copilotThreadsTable.userId, userIds)),
    ),
    notifications: await c(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(notificationsTable)
        .where(inArray(notificationsTable.userId, userIds)),
    ),
  };
}

async function countPostedJournalEntries(userIds: number[]): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntriesTable)
    .where(
      or(
        inArray(journalEntriesTable.postedByUserId, userIds),
        inArray(journalEntriesTable.approverUserId, userIds),
      )!,
    );
  return r[0]?.n ?? 0;
}

async function deleteOwnedAndAudit(
  users: { id: number; email: string }[],
  userIds: number[],
  emails: string[],
  reason: string,
): Promise<Counts> {
  // The deletion of every user-linked table AND the activity_log
  // insert run in a single transaction. Either every row goes and the
  // audit row is recorded, or nothing changes — never a partial wipe
  // with no audit trail (or vice versa).
  //
  // Order: child / FK-pointing tables first; tables that other tables
  // FK-reference go last. copilot_messages and copilot_tool_calls have
  // ON DELETE CASCADE from copilot_threads but we delete them
  // explicitly anyway so the deleted-row counts surface in the report.
  return db.transaction(async (tx) => {
    const out: Counts = {};
    const toolCalls = await tx
      .delete(copilotToolCallsTable)
      .where(
        sql`thread_id in (select id from copilot_threads where user_id = any(${userIds}::int[]))`,
      );
    out["copilot_tool_calls"] = toolCalls.rowCount ?? 0;
    const messages = await tx
      .delete(copilotMessagesTable)
      .where(
        sql`thread_id in (select id from copilot_threads where user_id = any(${userIds}::int[]))`,
      );
    out["copilot_messages"] = messages.rowCount ?? 0;
    const threads = await tx
      .delete(copilotThreadsTable)
      .where(inArray(copilotThreadsTable.userId, userIds));
    out["copilot_threads"] = threads.rowCount ?? 0;
    const sourceLinks = await tx
      .delete(accountingSourceLinksTable)
      .where(inArray(accountingSourceLinksTable.createdByUserId, userIds));
    out["accounting_source_links"] = sourceLinks.rowCount ?? 0;
    const schedules = await tx
      .delete(journalEntryExportSchedulesTable)
      .where(
        inArray(journalEntryExportSchedulesTable.createdByUserId, userIds),
      );
    out["journal_entry_export_schedules"] = schedules.rowCount ?? 0;
    const drafts = await tx
      .delete(manualJournalEntryDraftsTable)
      .where(
        or(
          inArray(manualJournalEntryDraftsTable.createdByUserId, userIds),
          inArray(manualJournalEntryDraftsTable.submittedByUserId, userIds),
        )!,
      );
    out["manual_journal_entry_drafts"] = drafts.rowCount ?? 0;
    const receipts = await tx
      .delete(receiptsTable)
      .where(inArray(receiptsTable.uploadedBy, userIds));
    out["receipts"] = receipts.rowCount ?? 0;
    const expenses = await tx
      .delete(expensesTable)
      .where(inArray(expensesTable.submittedByEmail, emails));
    out["expenses"] = expenses.rowCount ?? 0;
    const bills = await tx
      .delete(billsTable)
      .where(inArray(billsTable.submittedByEmail, emails));
    out["bills"] = bills.rowCount ?? 0;
    const notifications = await tx
      .delete(notificationsTable)
      .where(inArray(notificationsTable.userId, userIds));
    out["notifications"] = notifications.rowCount ?? 0;

    await tx.insert(activityLogTable).values({
      type: "wipe_test_data",
      description: `wipe-test-data: deleted rows for ${users.length} test user(s). Reason: ${reason}`,
      actor: "wipe-test-data-script",
      actorUserId: null,
      metadata: {
        reason,
        matchedUsers: users.map((u) => ({ id: u.id, email: u.email })),
        deletedCounts: out,
      },
    });
    return out;
  });
}

function printCounts(label: string, counts: Counts): void {
  console.log(label);
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(34)} ${v}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const prod = isProduction();

  const users = await findTestUsers();
  if (users.length === 0) {
    console.log("No test users matched. Nothing to do.");
    return 1;
  }

  // In production: every matched user MUST be a @dev-only.example
  // address. WIPE_TEST_USER_EMAILS is dev-only by construction
  // (findTestUsers ignores it in prod), but a real production user
  // could in theory have a dev-only address — we still hard-block
  // anyone with role admin/approver as a second seatbelt.
  if (prod) {
    const offDomain = users.filter(
      (u) => !u.email.toLowerCase().endsWith(TEST_EMAIL_DOMAIN),
    );
    if (offDomain.length > 0) {
      console.error(
        `Refusing to wipe in production: matched non-test-domain users: ${offDomain
          .map((u) => u.email)
          .join(", ")}`,
      );
      return 1;
    }
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

  // Refuse if any matched user has touched the posted ledger. The
  // lock trigger would block the DELETE anyway, but failing here gives
  // a clear, actionable message instead of an obscure trigger error.
  const postedJEs = await countPostedJournalEntries(userIds);
  if (postedJEs > 0) {
    console.error(
      `Refusing to wipe: matched test users have ${postedJEs} posted journal_entries (or are recorded as approver). ` +
        `This indicates the test allowlist contains a real ledger participant. ` +
        `Investigate before proceeding.`,
    );
    return 1;
  }

  const counts = await countOwned(userIds, emails);

  console.log("Matched test users:");
  for (const u of users) {
    console.log(`  - ${u.email} (id=${u.id}, role=${u.role})`);
  }
  printCounts("Owned-row counts:", counts);

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

  const deleted = await deleteOwnedAndAudit(
    users,
    userIds,
    emails,
    args.reason,
  );

  printCounts("\nDeleted-row counts:", deleted);
  console.log("\nactivity_log entry recorded (same transaction).");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
