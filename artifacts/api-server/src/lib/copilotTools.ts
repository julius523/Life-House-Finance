import { z } from "zod";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import {
  db,
  billsTable,
  expensesTable,
  vendorsTable,
  programsTable,
  receiptsTable,
  monthEndChecklistsTable,
  notificationsTable,
  transactionsTable,
  creditsTable,
  usersTable,
} from "@workspace/db";
import type { AuthUser } from "./auth";

export type CopilotToolContext = {
  user: AuthUser;
  pageContext: PageContextLike | null;
  threadId: number;
};

export type PageContextLike = {
  route: string;
  recordType: string;
  recordId: string | number | null;
  entityLabel: string | null;
  visibleSummary: Record<string, string | number | boolean | null>;
};

type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

type ToolDefinition<TArgs> = {
  name: string;
  description: string;
  argsSchema: z.ZodType<TArgs>;
  parametersJsonSchema: Record<string, unknown>;
  execute: (args: TArgs, ctx: CopilotToolContext) => Promise<ToolResult>;
};

const MAX_RESULT_BYTES = 16_000;

function clampResult(data: unknown): unknown {
  const json = JSON.stringify(data);
  if (json.length <= MAX_RESULT_BYTES) return data;
  if (Array.isArray(data)) {
    return {
      truncated: true,
      message:
        "Result truncated to fit response budget; ask for narrower filters or pagination.",
      preview: data.slice(0, 20),
      total_returned: data.length,
    };
  }
  if (data && typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>);
    return {
      truncated: true,
      message:
        "Result exceeded response budget; only top-level key list is included. Re-query with narrower filters or pagination.",
      top_level_keys: keys,
      original_byte_size: json.length,
    };
  }
  return {
    truncated: true,
    message:
      "Result exceeded response budget and could not be summarized; re-query with narrower filters.",
    original_byte_size: json.length,
  };
}

// ---------------------------------------------------------------------------
// 1. get_current_page_context
// ---------------------------------------------------------------------------
const getCurrentPageContext: ToolDefinition<Record<string, never>> = {
  name: "get_current_page_context",
  description:
    "Returns the structured page context that was attached to the user's most recent message — what route/record/entity the user is currently looking at. Use this when you need to confirm what the user is viewing.",
  argsSchema: z.object({}).strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async execute(_args, ctx) {
    if (!ctx.pageContext) {
      return { ok: true, data: { available: false, note: "No page context was attached to this turn." } };
    }
    return { ok: true, data: { available: true, ...ctx.pageContext } };
  },
};

// ---------------------------------------------------------------------------
// 2. get_current_record
// ---------------------------------------------------------------------------
const getCurrentRecord: ToolDefinition<{
  recordType?: string;
  recordId?: string | number;
}> = {
  name: "get_current_record",
  description:
    "Fetches the full record the user is currently viewing (or a specified record). Read-only. Supports bill, expense, vendor, program, credit, transaction.",
  argsSchema: z
    .object({
      recordType: z
        .enum(["bill", "expense", "vendor", "program", "credit", "transaction"])
        .optional(),
      recordId: z.union([z.string(), z.number()]).optional(),
    })
    .strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      recordType: {
        type: "string",
        enum: ["bill", "expense", "vendor", "program", "credit", "transaction"],
      },
      recordId: { type: ["string", "number"] },
    },
  },
  async execute(args, ctx) {
    const recordType =
      args.recordType ??
      (ctx.pageContext?.recordType as string | undefined);
    const rawId = args.recordId ?? ctx.pageContext?.recordId;
    const recordId = Number(rawId);
    if (!recordType || recordType === "none" || !Number.isInteger(recordId) || recordId <= 0) {
      return { ok: false, error: "No identifiable record. Provide recordType and recordId." };
    }
    let row: unknown = null;
    if (recordType === "bill") {
      [row] = await db.select().from(billsTable).where(eq(billsTable.id, recordId));
    } else if (recordType === "expense") {
      [row] = await db.select().from(expensesTable).where(eq(expensesTable.id, recordId));
    } else if (recordType === "vendor") {
      [row] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, recordId));
    } else if (recordType === "program") {
      [row] = await db.select().from(programsTable).where(eq(programsTable.id, recordId));
    } else if (recordType === "credit") {
      [row] = await db.select().from(creditsTable).where(eq(creditsTable.id, recordId));
    } else if (recordType === "transaction") {
      [row] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, recordId));
    }
    if (!row) {
      return { ok: false, error: `${recordType} #${recordId} not found.` };
    }
    return { ok: true, data: { recordType, recordId, record: row } };
  },
};

// ---------------------------------------------------------------------------
// 3. get_accounting_dimensions
// ---------------------------------------------------------------------------
const getAccountingDimensions: ToolDefinition<Record<string, never>> = {
  name: "get_accounting_dimensions",
  description:
    "Returns Life House's available accounting dimensions: programs (used as fund/cost-center) and active vendors. Note: a formal chart of accounts is not yet integrated.",
  argsSchema: z.object({}).strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async execute() {
    const programs = await db
      .select({
        id: programsTable.id,
        name: programsTable.name,
        type: programsTable.type,
        code: programsTable.code,
        budgetAmount: programsTable.budgetAmount,
        fiscalYear: programsTable.fiscalYear,
        isActive: programsTable.isActive,
      })
      .from(programsTable)
      .orderBy(asc(programsTable.name));
    const vendors = await db
      .select({
        id: vendorsTable.id,
        name: vendorsTable.name,
        category: vendorsTable.category,
        isActive: vendorsTable.isActive,
      })
      .from(vendorsTable)
      .where(eq(vendorsTable.isActive, true))
      .orderBy(asc(vendorsTable.name));
    return {
      ok: true,
      data: clampResult({
        chart_of_accounts_status:
          "Not yet integrated. Programs serve as fund/cost-center dimensions; vendors serve as payee dimensions.",
        programs,
        vendors,
        program_count: programs.length,
        vendor_count: vendors.length,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// 4. get_open_tasks
// ---------------------------------------------------------------------------
const getOpenTasks: ToolDefinition<{ limit?: number }> = {
  name: "get_open_tasks",
  description:
    "Lists open accounting work items the team needs to act on: bills/expenses awaiting approval, and any open month-end checklists.",
  argsSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
  },
  async execute(args) {
    const limit = args.limit ?? 20;
    const pendingBills = await db
      .select({
        id: billsTable.id,
        amount: billsTable.amount,
        dueDate: billsTable.dueDate,
        status: billsTable.status,
        vendorId: billsTable.vendorId,
        invoiceNumber: billsTable.invoiceNumber,
      })
      .from(billsTable)
      .where(eq(billsTable.status, "pending_approval"))
      .orderBy(asc(billsTable.dueDate))
      .limit(limit);
    const pendingExpenses = await db
      .select({
        id: expensesTable.id,
        amount: expensesTable.amount,
        merchant: expensesTable.merchant,
        status: expensesTable.status,
        submittedBy: expensesTable.submittedBy,
        expenseDate: expensesTable.expenseDate,
      })
      .from(expensesTable)
      .where(eq(expensesTable.status, "pending_approval"))
      .orderBy(desc(expensesTable.expenseDate))
      .limit(limit);
    const openChecklists = await db
      .select({
        id: monthEndChecklistsTable.id,
        month: monthEndChecklistsTable.month,
        fiscalYear: monthEndChecklistsTable.fiscalYear,
        status: monthEndChecklistsTable.status,
        owner: monthEndChecklistsTable.owner,
      })
      .from(monthEndChecklistsTable)
      .where(eq(monthEndChecklistsTable.status, "open"))
      .orderBy(desc(monthEndChecklistsTable.createdAt));

    return {
      ok: true,
      data: clampResult({
        bills_pending_approval: pendingBills,
        expenses_pending_approval: pendingExpenses,
        open_month_end_checklists: openChecklists,
        counts: {
          bills_pending_approval: pendingBills.length,
          expenses_pending_approval: pendingExpenses.length,
          open_month_end_checklists: openChecklists.length,
        },
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// 5. get_missing_receipts
// ---------------------------------------------------------------------------
const getMissingReceipts: ToolDefinition<{
  limit?: number;
  recordType?: "bill" | "expense" | "both";
}> = {
  name: "get_missing_receipts",
  description:
    "Lists bills and/or expenses that have no receipts attached. Use to flag documentation gaps.",
  argsSchema: z
    .object({
      limit: z.number().int().min(1).max(100).optional(),
      recordType: z.enum(["bill", "expense", "both"]).optional(),
    })
    .strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
      recordType: { type: "string", enum: ["bill", "expense", "both"] },
    },
  },
  async execute(args) {
    const limit = args.limit ?? 30;
    const recordType = args.recordType ?? "both";
    const noReceipts = sql<boolean>`(${billsTable.receiptIds} IS NULL OR cardinality(${billsTable.receiptIds}) = 0)`;
    const noReceiptsExp = sql<boolean>`(${expensesTable.receiptIds} IS NULL OR cardinality(${expensesTable.receiptIds}) = 0)`;
    const out: Record<string, unknown> = {};
    if (recordType !== "expense") {
      out["bills_missing_receipts"] = await db
        .select({
          id: billsTable.id,
          vendorId: billsTable.vendorId,
          amount: billsTable.amount,
          dueDate: billsTable.dueDate,
          status: billsTable.status,
        })
        .from(billsTable)
        .where(noReceipts)
        .orderBy(desc(billsTable.dueDate))
        .limit(limit);
    }
    if (recordType !== "bill") {
      out["expenses_missing_receipts"] = await db
        .select({
          id: expensesTable.id,
          merchant: expensesTable.merchant,
          amount: expensesTable.amount,
          expenseDate: expensesTable.expenseDate,
          status: expensesTable.status,
        })
        .from(expensesTable)
        .where(noReceiptsExp)
        .orderBy(desc(expensesTable.expenseDate))
        .limit(limit);
    }
    return { ok: true, data: clampResult(out) };
  },
};

// ---------------------------------------------------------------------------
// 6. get_reconciliation_status
// ---------------------------------------------------------------------------
const getReconciliationStatus: ToolDefinition<{ month?: string }> = {
  name: "get_reconciliation_status",
  description:
    "Returns reconciliation/close status: most recent month-end checklists with their items, and counts of unmatched bank transactions.",
  argsSchema: z
    .object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() })
    .strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "YYYY-MM" },
    },
  },
  async execute(args) {
    const checklistsQuery = args.month
      ? db
          .select()
          .from(monthEndChecklistsTable)
          .where(eq(monthEndChecklistsTable.month, args.month))
      : db
          .select()
          .from(monthEndChecklistsTable)
          .orderBy(desc(monthEndChecklistsTable.createdAt))
          .limit(3);
    const checklists = await checklistsQuery;
    const [{ unmatchedCount }] = await db
      .select({
        unmatchedCount: sql<number>`count(*)::int`,
      })
      .from(transactionsTable)
      .where(eq(transactionsTable.status, "unmatched"));
    return {
      ok: true,
      data: clampResult({
        recent_checklists: checklists,
        unmatched_transactions: unmatchedCount ?? 0,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// 7. search_chart_of_accounts (proxied to programs)
// ---------------------------------------------------------------------------
const searchChartOfAccounts: ToolDefinition<{ query: string }> = {
  name: "search_chart_of_accounts",
  description:
    "Searches the chart of accounts. NOTE: a formal chart of accounts is not yet integrated; this currently searches programs (the closest available analog). Always disclose this limitation in any answer that depends on the result.",
  argsSchema: z.object({ query: z.string().min(1).max(120) }).strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: { query: { type: "string", minLength: 1, maxLength: 120 } },
  },
  async execute(args) {
    const q = `%${args.query}%`;
    const matches = await db
      .select({
        id: programsTable.id,
        name: programsTable.name,
        code: programsTable.code,
        type: programsTable.type,
        isActive: programsTable.isActive,
      })
      .from(programsTable)
      .where(
        or(ilike(programsTable.name, q), ilike(programsTable.code, q)),
      )
      .limit(20);
    return {
      ok: true,
      data: {
        chart_of_accounts_status:
          "Not yet integrated. Returned matches are programs only.",
        query: args.query,
        matches,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 8. escalate_to_human
// ---------------------------------------------------------------------------
const escalateToHuman: ToolDefinition<{
  reason: string;
  severity: "low" | "medium" | "high";
  referenceType?: string;
  referenceId?: number;
}> = {
  name: "escalate_to_human",
  description:
    "Escalates a question or situation to a human accountant by creating a notification for all admin users. Use only when the situation genuinely requires human judgment, accounting review, or oversight. Does NOT make any ledger or approval changes.",
  argsSchema: z
    .object({
      reason: z.string().min(10).max(2000),
      severity: z.enum(["low", "medium", "high"]),
      referenceType: z.string().max(40).optional(),
      referenceId: z.number().int().positive().optional(),
    })
    .strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["reason", "severity"],
    properties: {
      reason: { type: "string", minLength: 10, maxLength: 2000 },
      severity: { type: "string", enum: ["low", "medium", "high"] },
      referenceType: { type: "string", maxLength: 40 },
      referenceId: { type: "integer", minimum: 1 },
    },
  },
  async execute(args, ctx) {
    const admins = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), eq(usersTable.isActive, true)));
    if (admins.length === 0) {
      return { ok: false, error: "No active admin users to escalate to." };
    }
    const title = `Copilot escalation (${args.severity}) from ${ctx.user.firstName} ${ctx.user.lastName}`;
    const body = args.reason;
    const inserted = await db
      .insert(notificationsTable)
      .values(
        admins.map((a) => ({
          userId: a.id,
          type: "copilot_escalation",
          title,
          body,
          link: `/accounting`,
          referenceType: args.referenceType ?? "copilot_thread",
          referenceId: args.referenceId ?? ctx.threadId,
          emailTo: a.email,
        })),
      )
      .returning({ id: notificationsTable.id, userId: notificationsTable.userId });
    return {
      ok: true,
      data: {
        escalated: true,
        severity: args.severity,
        recipient_count: admins.length,
        notification_ids: inserted.map((r) => r.id),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 9. create_followup_task
// ---------------------------------------------------------------------------
const createFollowupTask: ToolDefinition<{
  title: string;
  body: string;
  assignToSelf?: boolean;
}> = {
  name: "create_followup_task",
  description:
    "Creates a follow-up reminder for the current user (or, if assignToSelf=false, defaults to the current user — assigning to others is not yet supported). The reminder is delivered as a notification. Does NOT make any ledger or approval changes.",
  argsSchema: z
    .object({
      title: z.string().min(3).max(200),
      body: z.string().min(3).max(2000),
      assignToSelf: z.boolean().optional(),
    })
    .strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "body"],
    properties: {
      title: { type: "string", minLength: 3, maxLength: 200 },
      body: { type: "string", minLength: 3, maxLength: 2000 },
      assignToSelf: { type: "boolean", default: true },
    },
  },
  async execute(args, ctx) {
    const [n] = await db
      .insert(notificationsTable)
      .values({
        userId: ctx.user.id,
        type: "copilot_followup",
        title: `Follow-up: ${args.title}`,
        body: args.body,
        link: `/accounting`,
        referenceType: "copilot_thread",
        referenceId: ctx.threadId,
        emailTo: null,
      })
      .returning({ id: notificationsTable.id });
    return {
      ok: true,
      data: {
        created: true,
        notification_id: n?.id,
        assigned_to_user_id: ctx.user.id,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 10. draft_memo
// ---------------------------------------------------------------------------
const draftMemo: ToolDefinition<{
  topic: string;
  audience: string;
  body: string;
}> = {
  name: "draft_memo",
  description:
    "Records a draft memo for the user to review. The memo is returned to the assistant for confirmation and shown to the user as a draft artifact in the chat. NOT persisted to any ledger; NOT sent anywhere; the user must copy it themselves.",
  argsSchema: z
    .object({
      topic: z.string().min(2).max(200),
      audience: z.string().min(2).max(200),
      body: z.string().min(10).max(8000),
    })
    .strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["topic", "audience", "body"],
    properties: {
      topic: { type: "string", minLength: 2, maxLength: 200 },
      audience: { type: "string", minLength: 2, maxLength: 200 },
      body: { type: "string", minLength: 10, maxLength: 8000 },
    },
  },
  async execute(args) {
    return {
      ok: true,
      data: {
        artifact_type: "draft_memo",
        topic: args.topic,
        audience: args.audience,
        body: args.body,
        persisted: false,
        delivered: false,
        note: "Draft only. Not saved or sent. User must copy to use.",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
const TOOLS = [
  getCurrentPageContext,
  getCurrentRecord,
  getAccountingDimensions,
  getOpenTasks,
  getMissingReceipts,
  getReconciliationStatus,
  searchChartOfAccounts,
  escalateToHuman,
  createFollowupTask,
  draftMemo,
] as const;

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function getOpenAIToolDefinitions(): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}> {
  return TOOLS.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parametersJsonSchema,
    strict: false,
  }));
}

export async function runTool(
  name: string,
  rawArgs: unknown,
  ctx: CopilotToolContext,
): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name) as
    | ToolDefinition<unknown>
    | undefined;
  if (!tool) {
    return { ok: false, error: `Unknown tool: ${name}` };
  }
  const parsed = tool.argsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    };
  }
  try {
    return await tool.execute(parsed.data, ctx);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Tool execution failed",
    };
  }
}
