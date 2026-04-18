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
import { and, asc, eq, ilike, or, sql, isNotNull } from "drizzle-orm";
import {
  db,
  chartOfAccountsTable,
  accountingSettingsTable,
  journalEntryLinesTable,
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

router.get("/accounting/settings", async (_req, res): Promise<void> => {
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
  res.json({ settings: updated });
});

// Suppress unused-import warnings for utilities reserved for future filters.
void isNotNull;

export default router;
