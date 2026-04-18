/**
 * Step 9 — Chart of Accounts and Accounting Settings routes.
 *
 * Mounted under /api/accounting/*.  All endpoints require auth; mutating
 * endpoints additionally require admin.
 *
 * Hard rules:
 *   - System CoA rows (is_system=true) cannot be deleted, and their `code`
 *     and `type` cannot be edited. Renames, descriptions, archive flag,
 *     and allow_manual_posting can be edited.
 *   - DELETE refuses if any journal_entry_line references the row. The
 *     archive flow is the supported way to retire an account.
 *   - The Accounting Settings table is a singleton (id=1, created at
 *     server boot). PATCH updates that single row.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { and, asc, eq, ilike, inArray, or, sql, isNotNull } from "drizzle-orm";
import {
  db,
  chartOfAccountsTable,
  accountingSettingsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  accountingPeriodsTable,
  activityLogTable,
  agentActionsTable,
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  ACCOUNTING_METHODS,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();
router.use("/accounting", requireAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireAdmin(req: Request, res: Response): boolean {
  if (req.authUser?.role !== "admin") {
    res.status(403).json({ error: "Admins only" });
    return false;
  }
  return true;
}

function requireAdminOrApprover(req: Request, res: Response): boolean {
  const role = req.authUser?.role;
  if (role !== "admin" && role !== "approver") {
    res.status(403).json({ error: "Admins or approvers only" });
    return false;
  }
  return true;
}

function actorLabel(req: Request): string {
  const u = req.authUser;
  if (!u) return "system";
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return name || u.email || `user#${u.id}`;
}

async function writeCoaAudit(
  req: Request,
  action: "coa.create" | "coa.update" | "coa.archive" | "coa.restore" | "coa.delete",
  resourceId: number | null,
  description: string,
): Promise<void> {
  try {
    await db.insert(activityLogTable).values({
      type: action,
      description,
      actor: actorLabel(req),
      referenceId: resourceId,
      referenceType: "chart_of_accounts",
    });
  } catch (err) {
    req.log?.warn({ err }, "failed to write CoA activity log");
  }
}

async function writeSettingsAudit(
  req: Request,
  description: string,
): Promise<void> {
  try {
    await db.insert(activityLogTable).values({
      type: "accounting_settings.update",
      description,
      actor: actorLabel(req),
      referenceId: 1,
      referenceType: "accounting_settings",
    });
  } catch (err) {
    req.log?.warn({ err }, "failed to write settings activity log");
  }
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  return id;
}

const CodePattern = /^[A-Za-z0-9][A-Za-z0-9._\- ]{0,63}$/;
const CoaCreateSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(CodePattern, "code must be alphanumeric with . _ - or space"),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullish(),
    type: z.enum(ACCOUNT_TYPES),
    subtype: z.string().max(80).nullish(),
    normalBalance: z.enum(NORMAL_BALANCES),
    parentAccountId: z.number().int().positive().nullish(),
    isActive: z.boolean().optional(),
    allowManualPosting: z.boolean().optional(),
  })
  .strict();

const CoaUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullish(),
    code: z.string().min(1).max(64).regex(CodePattern).optional(),
    type: z.enum(ACCOUNT_TYPES).optional(),
    subtype: z.string().max(80).nullish().optional(),
    normalBalance: z.enum(NORMAL_BALANCES).optional(),
    parentAccountId: z.number().int().positive().nullish().optional(),
    isActive: z.boolean().optional(),
    allowManualPosting: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Chart of Accounts
// ---------------------------------------------------------------------------

router.get("/accounting/chart-of-accounts", async (req, res): Promise<void> => {
  if (!requireAdminOrApprover(req, res)) return;
  const QuerySchema = z.object({
    q: z.string().max(120).optional(),
    type: z.enum(ACCOUNT_TYPES).optional(),
    includeArchived: z.string().optional(),
  });
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const includeArchived = parsed.data.includeArchived === "true";
  const conds = [];
  if (parsed.data.type) conds.push(eq(chartOfAccountsTable.type, parsed.data.type));
  if (!includeArchived) conds.push(eq(chartOfAccountsTable.isActive, true));
  if (parsed.data.q) {
    const like = `%${parsed.data.q}%`;
    const orClause = or(
      ilike(chartOfAccountsTable.code, like),
      ilike(chartOfAccountsTable.name, like),
    );
    if (orClause) conds.push(orClause);
  }
  const rows = await db
    .select()
    .from(chartOfAccountsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(chartOfAccountsTable.code));
  res.json({ accounts: rows });
});

router.get(
  "/accounting/chart-of-accounts/:id",
  async (req, res): Promise<void> => {
    if (!requireAdminOrApprover(req, res)) return;
    const id = parseId(req, res);
    if (id === null) return;
    const [row] = await db
      .select()
      .from(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    // How many JE lines reference this account?
    const [{ usageCount }] = await db
      .select({
        usageCount: sql<number>`count(*)::int`,
      })
      .from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.accountId, id));
    res.json({ account: row, usageCount });
  },
);

router.post("/accounting/chart-of-accounts", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const parsed = CoaCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  if (parsed.data.parentAccountId) {
    const [parent] = await db
      .select({ id: chartOfAccountsTable.id })
      .from(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.id, parsed.data.parentAccountId));
    if (!parent) {
      res.status(400).json({ error: "parentAccountId not found" });
      return;
    }
  }
  try {
    const [row] = await db
      .insert(chartOfAccountsTable)
      .values({
        code: parsed.data.code.trim(),
        name: parsed.data.name.trim(),
        description: parsed.data.description ?? null,
        type: parsed.data.type,
        subtype: parsed.data.subtype ?? null,
        normalBalance: parsed.data.normalBalance,
        parentAccountId: parsed.data.parentAccountId ?? null,
        isActive: parsed.data.isActive ?? true,
        isSystem: false,
        allowManualPosting: parsed.data.allowManualPosting ?? true,
      })
      .returning();
    await writeCoaAudit(
      req,
      "coa.create",
      row.id,
      `Created account ${row.code} — ${row.name} (${row.type}/${row.normalBalance})`,
    );
    res.status(201).json({ account: row });
  } catch (err) {
    req.log?.error({ err }, "create CoA failed");
    res.status(409).json({ error: "Account code must be unique." });
  }
});

router.patch(
  "/accounting/chart-of-accounts/:id",
  async (req, res): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = CoaUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }
    const [existing] = await db
      .select()
      .from(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    if (existing.isSystem) {
      // Prevent edits that would invalidate the seeded GAAP defaults.
      if (parsed.data.code && parsed.data.code !== existing.code) {
        res.status(409).json({
          error: "System accounts: code is immutable.",
          code: "SYSTEM_LOCKED_FIELD",
        });
        return;
      }
      if (parsed.data.type && parsed.data.type !== existing.type) {
        res.status(409).json({
          error: "System accounts: type is immutable.",
          code: "SYSTEM_LOCKED_FIELD",
        });
        return;
      }
      if (
        parsed.data.normalBalance &&
        parsed.data.normalBalance !== existing.normalBalance
      ) {
        res.status(409).json({
          error: "System accounts: normal balance is immutable.",
          code: "SYSTEM_LOCKED_FIELD",
        });
        return;
      }
    }
    if (parsed.data.parentAccountId === id) {
      res.status(400).json({ error: "parentAccountId cannot equal id" });
      return;
    }
    // Step 9 — guard archive against accounts referenced by unposted /
    // pending agent_action drafts. Posted JE lines are fine (archive only
    // hides from future selection); but a pending draft about to be posted
    // referencing a now-archived account would silently fail validation.
    if (parsed.data.isActive === false && existing.isActive) {
      const draftRows = await db
        .select({ id: agentActionsTable.id })
        .from(agentActionsTable)
        .where(
          and(
            eq(agentActionsTable.actionType, "draft_journal_entry"),
            inArray(agentActionsTable.status, [
              "pending_review",
              "approved",
            ]),
            sql`${agentActionsTable.payload}::text ILIKE ${
              "%\"account_code\":\"" + existing.code + "\"%"
            }`,
          ),
        )
        .limit(5);
      if (draftRows.length > 0) {
        res.status(409).json({
          error: `Cannot archive: account ${existing.code} is referenced by ${draftRows.length} pending journal-entry draft(s). Resolve or reject those drafts first.`,
          code: "REFERENCED_BY_PENDING_DRAFT",
          pendingDraftIds: draftRows.map((d) => d.id),
        });
        return;
      }
    }
    if (parsed.data.parentAccountId) {
      const [parent] = await db
        .select({ id: chartOfAccountsTable.id })
        .from(chartOfAccountsTable)
        .where(eq(chartOfAccountsTable.id, parsed.data.parentAccountId));
      if (!parent) {
        res.status(400).json({ error: "parentAccountId not found" });
        return;
      }
    }
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of [
      "name",
      "description",
      "code",
      "type",
      "subtype",
      "normalBalance",
      "parentAccountId",
      "isActive",
      "allowManualPosting",
    ] as const) {
      if (k in parsed.data) update[k] = parsed.data[k];
    }
    try {
      const [updated] = await db
        .update(chartOfAccountsTable)
        .set(update)
        .where(eq(chartOfAccountsTable.id, id))
        .returning();
      const archiveChange =
        "isActive" in parsed.data && parsed.data.isActive !== existing.isActive;
      const auditAction: Parameters<typeof writeCoaAudit>[1] = archiveChange
        ? parsed.data.isActive
          ? "coa.restore"
          : "coa.archive"
        : "coa.update";
      const changedKeys = Object.keys(update).filter((k) => k !== "updatedAt");
      await writeCoaAudit(
        req,
        auditAction,
        updated.id,
        archiveChange
          ? `${parsed.data.isActive ? "Restored" : "Archived"} account ${updated.code} — ${updated.name}`
          : `Updated account ${updated.code} — ${updated.name} (fields: ${changedKeys.join(", ") || "none"})`,
      );
      res.json({ account: updated });
    } catch (err) {
      req.log?.error({ err }, "update CoA failed");
      res.status(409).json({ error: "Could not update account (code may collide)." });
    }
  },
);

router.delete(
  "/accounting/chart-of-accounts/:id",
  async (req, res): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const id = parseId(req, res);
    if (id === null) return;
    const [existing] = await db
      .select()
      .from(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    if (existing.isSystem) {
      res.status(409).json({
        error: "System accounts cannot be deleted. Archive instead.",
        code: "SYSTEM_LOCKED",
      });
      return;
    }
    const [{ usageCount }] = await db
      .select({ usageCount: sql<number>`count(*)::int` })
      .from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.accountId, id));
    if (usageCount > 0) {
      res.status(409).json({
        error: `Cannot delete: ${usageCount} posted journal-entry line(s) reference this account. Archive it instead.`,
        code: "IN_USE",
        usageCount,
      });
      return;
    }
    await db
      .delete(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.id, id));
    await writeCoaAudit(
      req,
      "coa.delete",
      id,
      `Deleted unused account ${existing.code} — ${existing.name}`,
    );
    res.json({ ok: true, id });
  },
);

// ---------------------------------------------------------------------------
// Accounting Settings (singleton)
// ---------------------------------------------------------------------------

const SettingsUpdateSchema = z
  .object({
    accountingMethod: z.enum(ACCOUNTING_METHODS).optional(),
    separationOfDuties: z.boolean().optional(),
    defaultCashAccountId: z.number().int().positive().nullish().optional(),
    defaultApAccountId: z.number().int().positive().nullish().optional(),
    defaultArAccountId: z.number().int().positive().nullish().optional(),
    defaultExpenseClearingAccountId: z
      .number()
      .int()
      .positive()
      .nullish()
      .optional(),
    defaultRoundingAccountId: z.number().int().positive().nullish().optional(),
    receiptRequiredOverCents: z.number().int().min(0).max(1_000_000).optional(),
    periodCloseRequiresAdmin: z.boolean().optional(),
  })
  .strict();

router.get("/accounting/settings", async (req, res): Promise<void> => {
  if (!requireAdminOrApprover(req, res)) return;
  const [row] = await db
    .select()
    .from(accountingSettingsTable)
    .orderBy(asc(accountingSettingsTable.id))
    .limit(1);
  if (!row) {
    res.status(503).json({
      error: "Accounting settings have not been seeded yet. Try again shortly.",
    });
    return;
  }
  res.json({ settings: row });
});

router.patch("/accounting/settings", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const parsed = SettingsUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const [existing] = await db
    .select()
    .from(accountingSettingsTable)
    .orderBy(asc(accountingSettingsTable.id))
    .limit(1);
  if (!existing) {
    res.status(503).json({ error: "Settings row not yet seeded." });
    return;
  }
  // Validate FK targets exist & are active when explicitly set.
  const fkFields = [
    "defaultCashAccountId",
    "defaultApAccountId",
    "defaultArAccountId",
    "defaultExpenseClearingAccountId",
    "defaultRoundingAccountId",
  ] as const;
  for (const f of fkFields) {
    if (f in parsed.data && parsed.data[f]) {
      const [acc] = await db
        .select({
          id: chartOfAccountsTable.id,
          isActive: chartOfAccountsTable.isActive,
        })
        .from(chartOfAccountsTable)
        .where(eq(chartOfAccountsTable.id, parsed.data[f] as number));
      if (!acc) {
        res.status(400).json({ error: `${f}: account not found` });
        return;
      }
      if (!acc.isActive) {
        res
          .status(400)
          .json({ error: `${f}: cannot reference an archived account` });
        return;
      }
    }
  }
  const update: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedByUserId: req.authUser!.id,
  };
  for (const k of [
    "accountingMethod",
    "separationOfDuties",
    "defaultCashAccountId",
    "defaultApAccountId",
    "defaultArAccountId",
    "defaultExpenseClearingAccountId",
    "defaultRoundingAccountId",
    "receiptRequiredOverCents",
    "periodCloseRequiresAdmin",
  ] as const) {
    if (k in parsed.data) update[k] = parsed.data[k];
  }
  const [updated] = await db
    .update(accountingSettingsTable)
    .set(update)
    .where(eq(accountingSettingsTable.id, existing.id))
    .returning();
  const changed = Object.keys(parsed.data).filter((k) => k in parsed.data);
  await writeSettingsAudit(
    req,
    `Updated accounting settings (fields: ${changed.join(", ") || "none"})`,
  );
  res.json({ settings: updated });
});

// ---------------------------------------------------------------------------
// Step 9 — CoA detail (account metadata + recent posted ledger activity)
// ---------------------------------------------------------------------------
router.get(
  "/accounting/chart-of-accounts/:id/activity",
  async (req, res): Promise<void> => {
    if (!requireAdminOrApprover(req, res)) return;
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid account id" });
      return;
    }
    const [account] = await db
      .select()
      .from(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.id, id));
    if (!account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
    const rows = await db
      .select({
        lineId: journalEntryLinesTable.id,
        journalEntryId: journalEntryLinesTable.journalEntryId,
        type: journalEntryLinesTable.type,
        amountCents: journalEntryLinesTable.amountCents,
        memo: journalEntryLinesTable.memo,
        program: journalEntryLinesTable.program,
        fund: journalEntryLinesTable.fund,
        entryDate: journalEntriesTable.entryDate,
        entryMemo: journalEntriesTable.memo,
        entryStatus: journalEntriesTable.status,
        postedAt: journalEntriesTable.postedAt,
      })
      .from(journalEntryLinesTable)
      .innerJoin(
        journalEntriesTable,
        eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id),
      )
      .where(eq(journalEntryLinesTable.accountId, id))
      .orderBy(sql`${journalEntriesTable.entryDate} desc, ${journalEntryLinesTable.id} desc`)
      .limit(limit);
    res.json({ account, activity: rows });
  },
);

// ---------------------------------------------------------------------------
// Step 9 — Dashboard accounting status block
// Returns: openPeriod, unpostedDrafts, trialBalanceStatus, lastClosedPeriod
// ---------------------------------------------------------------------------
router.get(
  "/accounting/dashboard-status",
  async (_req, res): Promise<void> => {
    const today = new Date().toISOString().slice(0, 10);
    const [openPeriod] = await db
      .select()
      .from(accountingPeriodsTable)
      .where(
        and(
          eq(accountingPeriodsTable.status, "open"),
          sql`${accountingPeriodsTable.periodStart} <= ${today}`,
          sql`${accountingPeriodsTable.periodEnd} >= ${today}`,
        ),
      )
      .limit(1);
    const [lastClosed] = await db
      .select()
      .from(accountingPeriodsTable)
      .where(eq(accountingPeriodsTable.status, "closed"))
      .orderBy(sql`${accountingPeriodsTable.periodEnd} desc`)
      .limit(1);
    const [draftRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentActionsTable)
      .where(
        and(
          eq(agentActionsTable.actionType, "draft_journal_entry"),
          eq(agentActionsTable.status, "pending_review"),
        ),
      );
    const [tbAgg] = await db
      .select({
        debits: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'debit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::bigint`,
        credits: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'credit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::bigint`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(
        journalEntriesTable,
        eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id),
      )
      .where(eq(journalEntriesTable.status, "posted"));
    const debits = Number(tbAgg?.debits ?? 0);
    const credits = Number(tbAgg?.credits ?? 0);
    res.json({
      openPeriod: openPeriod
        ? {
            id: openPeriod.id,
            label: openPeriod.label,
            startDate: openPeriod.periodStart,
            endDate: openPeriod.periodEnd,
          }
        : null,
      unpostedDrafts: { count: Number(draftRow?.n ?? 0) },
      trialBalanceStatus: {
        debitsCents: debits,
        creditsCents: credits,
        inBalance: debits === credits,
      },
      lastClosedPeriod: lastClosed
        ? {
            id: lastClosed.id,
            label: lastClosed.label,
            endDate: lastClosed.periodEnd,
            closedAt: lastClosed.closedAt,
          }
        : null,
    });
  },
);

// ---------------------------------------------------------------------------
// Step 9 — Spec-aligned aliases at /api/accounting/accounts so external
// clients matching the original task contract continue to work alongside
// the longer-form /chart-of-accounts paths the UI uses.
// ---------------------------------------------------------------------------

// Forward by re-dispatching through this router. Mutating req.url and
// calling router.handle() lets the existing /chart-of-accounts handlers
// run unchanged, including auth/role checks and audit logging.
function forward(targetPath: string, mutateBody?: (body: unknown) => unknown) {
  return (req: Request, res: Response, next: () => void): void => {
    req.url = targetPath + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
    if (mutateBody) req.body = mutateBody(req.body);
    router.handle(req, res, next);
  };
}

router.get("/accounting/accounts", (req, res, next) =>
  forward("/accounting/chart-of-accounts")(req, res, next),
);
router.get("/accounting/accounts/:id", (req, res, next) =>
  forward(`/accounting/chart-of-accounts/${req.params["id"]}`)(req, res, next),
);
router.post("/accounting/accounts", (req, res, next) =>
  forward("/accounting/chart-of-accounts")(req, res, next),
);
router.patch("/accounting/accounts/:id", (req, res, next) =>
  forward(`/accounting/chart-of-accounts/${req.params["id"]}`)(req, res, next),
);
// Spec-aligned dedicated archive endpoint — re-dispatches as PATCH with
// `{ isActive: false }` so the audit + draft-reference guard runs.
router.post("/accounting/accounts/:id/archive", (req, res, next) => {
  req.method = "PATCH";
  forward(`/accounting/chart-of-accounts/${req.params["id"]}`, (b) => ({
    ...((b as Record<string, unknown> | null) ?? {}),
    isActive: false,
  }))(req, res, next);
});

// Suppress unused-import warnings for utilities reserved for future filters.
void isNotNull;

export default router;
