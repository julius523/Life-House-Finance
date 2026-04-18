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
  copilotDocumentsTable,
  agentActionsTable,
  activityLogTable,
} from "@workspace/db";
import type { AuthUser } from "./auth";

export type RetrievedSnippet = {
  snippetId: string;
  documentId: number;
  documentTitle: string;
  chunkId: number;
  snippet: string;
  rank: number;
};

export type CopilotToolContext = {
  user: AuthUser;
  pageContext: PageContextLike | null;
  threadId: number;
  // Mutated by retrieval tools so the route handler can validate citations.
  retrievedSnippets: Map<string, RetrievedSnippet>;
  // Mutated by drafting tools (Step 6). The route handler back-fills the
  // assistant_message_id and final evidence on these rows after the assistant
  // message is persisted.
  agentActionIds?: number[];
  // When true, side-effecting tools must short-circuit and return a structured
  // preview of what they WOULD do, without writing any rows.
  dryRun?: boolean;
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
  | { ok: false; error: string; denied?: boolean };

// ---------------------------------------------------------------------------
// Step 7: per-role tool scopes (server-side, fail closed).
//
// This is the authoritative access matrix for the GAAP Copilot tool surface.
// It is enforced inside `runTool` BEFORE arg validation so that denials do
// not leak schema information to the model or to a probing user.
//
// Closed-world policy: any tool name not present in this map is denied for
// every role. Adding a new tool requires explicitly listing the roles that
// may invoke it.
// ---------------------------------------------------------------------------
export type CopilotRole = AuthUser["role"];

export const TOOL_ROLE_SCOPES: Readonly<Record<string, ReadonlyArray<CopilotRole>>> = {
  // Read-only tools — available to every authenticated finance-portal role.
  get_current_page_context: ["admin", "approver", "submitter"],
  get_current_record: ["admin", "approver", "submitter"],
  get_accounting_dimensions: ["admin", "approver", "submitter"],
  get_open_tasks: ["admin", "approver", "submitter"],
  get_missing_receipts: ["admin", "approver", "submitter"],
  get_reconciliation_status: ["admin", "approver", "submitter"],
  search_chart_of_accounts: ["admin", "approver", "submitter"],
  search_internal_policies: ["admin", "approver", "submitter"],

  // Drafting tools — restricted by role per the Step 7 access matrix.
  // Memos are documentation; any staff member may propose one.
  draft_memo: ["admin", "approver", "submitter"],
  // Follow-up tasks assign work to other people; submitters cannot do this
  // directly (they may escalate instead).
  create_followup_task: ["admin", "approver"],
  // Escalation is the safety valve; everyone must be able to call it.
  escalate_to_human: ["admin", "approver", "submitter"],
  // Journal-entry drafts touch GL semantics; only admins and approvers may
  // propose them. (Posting still requires explicit approval — see Step 6.)
  draft_journal_entry: ["admin", "approver"],
};

export function isToolAllowedForRole(
  toolName: string,
  role: CopilotRole,
): { allowed: true } | { allowed: false; reason: string } {
  const allowedRoles = TOOL_ROLE_SCOPES[toolName];
  if (!allowedRoles) {
    return {
      allowed: false,
      reason: `Tool '${toolName}' has no role scope configured and is denied by default. Contact an administrator if you believe this is wrong.`,
    };
  }
  if (!allowedRoles.includes(role)) {
    return {
      allowed: false,
      reason: `Tool '${toolName}' is not available for role '${role}'. Allowed roles: ${allowedRoles.join(", ")}.`,
    };
  }
  return { allowed: true };
}

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
    const programMatches = await db
      .select({
        id: programsTable.id,
        name: programsTable.name,
        code: programsTable.code,
        type: programsTable.type,
        isActive: programsTable.isActive,
      })
      .from(programsTable)
      .where(or(ilike(programsTable.name, q), ilike(programsTable.code, q)))
      .limit(20);
    return {
      ok: true,
      data: {
        no_formal_chart_of_accounts: true,
        official_matches: [],
        related_internal_mappings: programMatches.map((p) => ({
          mapping_type: "program",
          ...p,
        })),
        disclosure:
          "No formal chart of accounts is configured yet. Programs are NOT a chart of accounts — they are internal cost-center / fund codes. Do not present them as official GL accounts.",
        query: args.query,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 11. search_internal_policies (Step 5 — document-backed retrieval)
// ---------------------------------------------------------------------------
const searchInternalPolicies: ToolDefinition<{
  query: string;
  limit?: number;
}> = {
  name: "search_internal_policies",
  description:
    "Searches Life House's internal accounting policies, procedures, memos, and other ingested documents using full-text search. Returns ranked snippets, each with a stable snippet_id you MUST cite verbatim in any source you list. Citing a snippet_id you did not receive from this tool is a hard error and your response will be rejected. If no documents are indexed yet, say so explicitly in missing_information.",
  argsSchema: z
    .object({
      query: z.string().min(2).max(300),
      limit: z.number().int().min(1).max(8).optional(),
    })
    .strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 2, maxLength: 300 },
      limit: { type: "integer", minimum: 1, maximum: 8, default: 5 },
    },
  },
  async execute(args, ctx) {
    const limit = args.limit ?? 5;
    const [{ totalDocs }] = await db
      .select({
        totalDocs: sql<number>`count(*)::int`,
      })
      .from(copilotDocumentsTable)
      .where(eq(copilotDocumentsTable.isActive, true));
    if (!totalDocs || totalDocs === 0) {
      return {
        ok: true,
        data: {
          no_documents_indexed: true,
          query: args.query,
          matches: [],
          disclosure:
            "No internal policy documents have been ingested yet. Do NOT cite internal sources.",
        },
      };
    }
    const rows = await db.execute(sql`
      SELECT
        c.id            AS chunk_id,
        c.document_id   AS document_id,
        c.chunk_index   AS chunk_index,
        c.content       AS content,
        d.title         AS document_title,
        ts_rank(to_tsvector('english', c.content),
                plainto_tsquery('english', ${args.query})) AS rank
      FROM copilot_document_chunks c
      JOIN copilot_documents d ON d.id = c.document_id
      WHERE d.is_active = true
        AND to_tsvector('english', c.content) @@ plainto_tsquery('english', ${args.query})
      ORDER BY rank DESC
      LIMIT ${limit}
    `);
    const matches = (rows.rows as Array<Record<string, unknown>>).map((r) => {
      const documentId = Number(r["document_id"]);
      const chunkId = Number(r["chunk_id"]);
      const chunkIndex = Number(r["chunk_index"]);
      const snippetId = `doc${documentId}-chunk${chunkIndex}`;
      const snippet: RetrievedSnippet = {
        snippetId,
        documentId,
        documentTitle: String(r["document_title"]),
        chunkId,
        snippet: String(r["content"]),
        rank: Number(r["rank"]),
      };
      ctx.retrievedSnippets.set(snippetId, snippet);
      return {
        snippet_id: snippetId,
        document_id: documentId,
        document_title: snippet.documentTitle,
        snippet: snippet.snippet,
        rank: snippet.rank,
      };
    });
    return {
      ok: true,
      data: {
        no_documents_indexed: false,
        query: args.query,
        matches,
        instructions:
          "If you cite any of these in your answer, list each one in the top-level `sources` array with its exact snippet_id.",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Step 6 — drafting & approval-gated tools
//
// All four tools below write a row into agent_actions with status =
// pending_review. They never mutate the financial ledger directly. Only the
// human approval workflow (POST /accounting/agent-actions/:id/approve) can
// trigger any downstream effect, and even then ledger posting is OUT OF SCOPE
// for Step 6 — drafts stay drafts until a future phase wires posting.
// ---------------------------------------------------------------------------

function snapshotEvidence(ctx: CopilotToolContext): Record<string, unknown> {
  const snippets = Array.from(ctx.retrievedSnippets.values()).map((s) => ({
    snippet_id: s.snippetId,
    document_id: s.documentId,
    document_title: s.documentTitle,
    rank: s.rank,
  }));
  return {
    snippets_available_at_draft_time: snippets,
    page_context: ctx.pageContext,
  };
}

async function persistAgentAction(
  ctx: CopilotToolContext,
  args: {
    actionType: string;
    payload: Record<string, unknown>;
    confidence?: string | null;
    riskFlags?: string | null;
    policyEvidenceBasis?: string | null;
  },
): Promise<{ id: number; createdAt: Date }> {
  const evidence = {
    ...snapshotEvidence(ctx),
    ...(args.policyEvidenceBasis
      ? { policy_evidence_basis: args.policyEvidenceBasis }
      : {}),
  };
  const [row] = await db
    .insert(agentActionsTable)
    .values({
      userId: ctx.user.id,
      threadId: ctx.threadId,
      actionType: args.actionType,
      payload: args.payload,
      evidence,
      confidence: args.confidence ?? null,
      riskFlags: args.riskFlags ?? null,
      requiresHumanReview: true,
      status: "pending_review",
    })
    .returning({ id: agentActionsTable.id, createdAt: agentActionsTable.createdAt });
  if (!row) throw new Error("Failed to persist agent_action");
  if (!ctx.agentActionIds) ctx.agentActionIds = [];
  ctx.agentActionIds.push(row.id);
  await db.insert(activityLogTable).values({
    type: "copilot_draft_created",
    description: `Copilot drafted ${args.actionType} (pending review)`,
    actor: `${ctx.user.firstName} ${ctx.user.lastName} (via copilot)`,
    referenceId: row.id,
    referenceType: "agent_action",
  });
  return row;
}

// ---------------------------------------------------------------------------
// 8. draft_journal_entry  (NEW — Step 6)
// ---------------------------------------------------------------------------
const JournalLineSchema = z
  .object({
    type: z.enum(["debit", "credit"]),
    amount: z.number().positive().max(1_000_000_000),
    account: z.string().min(1).max(200),
    dimension: z.string().max(200).optional(),
    description: z.string().max(500).optional(),
  })
  .strict();

const draftJournalEntry: ToolDefinition<{
  date: string;
  memo: string;
  lines: Array<z.infer<typeof JournalLineSchema>>;
  proposedDimensions?: Record<string, string>;
  policyEvidenceBasis: string;
  confidence: "low" | "medium" | "high";
  riskFlags?: string;
}> = {
  name: "draft_journal_entry",
  description:
    "Drafts a proposed journal entry for human review. NEVER posts to the ledger. NEVER changes balances. NEVER marks anything compliant. The draft is stored in agent_actions with status=pending_review and surfaces in the approvals UI. Validates that debits and credits balance to the cent before persisting; an unbalanced entry is rejected with an error and not saved. Use this when the user asks for a journal entry suggestion.",
  argsSchema: z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
      memo: z.string().min(3).max(500),
      lines: z.array(JournalLineSchema).min(2).max(40),
      proposedDimensions: z.record(z.string(), z.string()).optional(),
      policyEvidenceBasis: z.string().min(3).max(2000),
      confidence: z.enum(["low", "medium", "high"]),
      riskFlags: z.string().max(2000).optional(),
    })
    .strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["date", "memo", "lines", "policyEvidenceBasis", "confidence"],
    properties: {
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      memo: { type: "string", minLength: 3, maxLength: 500 },
      lines: {
        type: "array",
        minItems: 2,
        maxItems: 40,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "amount", "account"],
          properties: {
            type: { type: "string", enum: ["debit", "credit"] },
            amount: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000_000 },
            account: { type: "string", minLength: 1, maxLength: 200 },
            dimension: { type: "string", maxLength: 200 },
            description: { type: "string", maxLength: 500 },
          },
        },
      },
      proposedDimensions: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      policyEvidenceBasis: { type: "string", minLength: 3, maxLength: 2000 },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      riskFlags: { type: "string", maxLength: 2000 },
    },
  },
  async execute(args, ctx) {
    // To-the-cent balance check using integer arithmetic to avoid float drift.
    const cents = (n: number): number => Math.round(n * 100);
    let debitsCents = 0;
    let creditsCents = 0;
    for (const l of args.lines) {
      const c = cents(l.amount);
      if (c <= 0) {
        return {
          ok: false,
          error: `Invalid line amount ${l.amount} for ${l.account}; amounts must be > 0.`,
        };
      }
      if (l.type === "debit") debitsCents += c;
      else creditsCents += c;
    }
    if (debitsCents === 0 || creditsCents === 0) {
      return {
        ok: false,
        error: "Journal entry must include at least one debit and one credit line.",
      };
    }
    if (debitsCents !== creditsCents) {
      return {
        ok: false,
        error: `Unbalanced journal entry: debits=${(debitsCents / 100).toFixed(2)} vs credits=${(creditsCents / 100).toFixed(2)}. Draft NOT saved. Fix the lines and try again.`,
      };
    }
    const totalAmount = debitsCents / 100;
    if (ctx.dryRun) {
      return {
        ok: true,
        data: {
          dry_run: true,
          would_have_drafted: true,
          totals: { debits: totalAmount, credits: totalAmount, balanced: true },
          note: "Preview only — no agent_action row written.",
        },
      };
    }
    const payload = {
      date: args.date,
      memo: args.memo,
      lines: args.lines,
      totals: {
        debits: Number((debitsCents / 100).toFixed(2)),
        credits: Number((creditsCents / 100).toFixed(2)),
        balanced: true,
      },
      proposed_dimensions: args.proposedDimensions ?? {},
      policy_evidence_basis: args.policyEvidenceBasis,
      ledger_posted: false,
      ledger_posting_supported: false,
    };
    const row = await persistAgentAction(ctx, {
      actionType: "draft_journal_entry",
      payload,
      confidence: args.confidence,
      riskFlags: args.riskFlags ?? null,
      policyEvidenceBasis: args.policyEvidenceBasis,
    });
    return {
      ok: true,
      data: {
        agent_action_id: row.id,
        action_type: "draft_journal_entry",
        status: "pending_review",
        ledger_posted: false,
        requires_human_review: true,
        totals: payload.totals,
        note: "Draft saved for human review. Nothing was posted to any ledger and no balances changed.",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 9. draft_memo  (Step 6 — now persisted to agent_actions)
// ---------------------------------------------------------------------------
const draftMemo: ToolDefinition<{
  topic: string;
  audience: string;
  body: string;
  evidenceUsed?: string;
  missingInformation?: string;
}> = {
  name: "draft_memo",
  description:
    "Drafts an accounting memo for human review. NEVER sends, emails, or distributes the memo. NEVER posts to any ledger. The draft is stored in agent_actions with status=pending_review. Use this when the user asks for a memo or written narrative.",
  argsSchema: z
    .object({
      topic: z.string().min(2).max(200),
      audience: z.string().min(2).max(200),
      body: z.string().min(10).max(8000),
      evidenceUsed: z.string().max(2000).optional(),
      missingInformation: z.string().max(2000).optional(),
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
      evidenceUsed: { type: "string", maxLength: 2000 },
      missingInformation: { type: "string", maxLength: 2000 },
    },
  },
  async execute(args, ctx) {
    if (ctx.dryRun) {
      return {
        ok: true,
        data: {
          dry_run: true,
          would_have_drafted: true,
          topic: args.topic,
          audience: args.audience,
          note: "Preview only — no agent_action row written.",
        },
      };
    }
    const payload = {
      topic: args.topic,
      audience: args.audience,
      body: args.body,
      evidence_used: args.evidenceUsed ?? null,
      missing_information: args.missingInformation ?? null,
      delivered: false,
    };
    const row = await persistAgentAction(ctx, {
      actionType: "draft_memo",
      payload,
      policyEvidenceBasis: args.evidenceUsed ?? null,
    });
    return {
      ok: true,
      data: {
        agent_action_id: row.id,
        action_type: "draft_memo",
        status: "pending_review",
        delivered: false,
        requires_human_review: true,
        note: "Memo draft saved for human review. Nothing was sent or distributed.",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 10. create_followup_task (Step 6 — now approval-gated)
// ---------------------------------------------------------------------------
const createFollowupTask: ToolDefinition<{
  title: string;
  body: string;
  dueHint?: string;
}> = {
  name: "create_followup_task",
  description:
    "Drafts a follow-up reminder for the current user. The reminder notification is NOT created until a human reviewer approves the draft in the approvals UI. Use this to capture an action item that requires the user to take a follow-up step.",
  argsSchema: z
    .object({
      title: z.string().min(3).max(200),
      body: z.string().min(3).max(2000),
      dueHint: z.string().max(200).optional(),
    })
    .strict(),
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "body"],
    properties: {
      title: { type: "string", minLength: 3, maxLength: 200 },
      body: { type: "string", minLength: 3, maxLength: 2000 },
      dueHint: { type: "string", maxLength: 200 },
    },
  },
  async execute(args, ctx) {
    if (ctx.dryRun) {
      return {
        ok: true,
        data: {
          dry_run: true,
          would_have_drafted: true,
          assigned_to_user_id: ctx.user.id,
          note: "Preview only — no agent_action row written.",
        },
      };
    }
    const payload = {
      title: args.title,
      body: args.body,
      due_hint: args.dueHint ?? null,
      assigned_to_user_id: ctx.user.id,
      assigned_to_email: ctx.user.email,
      notification_created: false,
    };
    const row = await persistAgentAction(ctx, {
      actionType: "create_followup_task",
      payload,
    });
    return {
      ok: true,
      data: {
        agent_action_id: row.id,
        action_type: "create_followup_task",
        status: "pending_review",
        notification_created: false,
        requires_human_review: true,
        note: "Follow-up task draft saved for review. The reminder will only be sent after a human approves the draft.",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 11. escalate_to_human (Step 6 — also tracked in agent_actions)
//
// Escalation differs from the other three drafting tools: the entire purpose
// of the call is to put a notification in front of an admin RIGHT NOW, so we
// fire admin notifications immediately AND record an agent_action so the
// escalation has the same audit/review surface as other drafts. The
// "approve" action becomes "acknowledge"; "reject" becomes "dismiss".
// ---------------------------------------------------------------------------
const escalateToHuman: ToolDefinition<{
  reason: string;
  severity: "low" | "medium" | "high";
  referenceType?: string;
  referenceId?: number;
}> = {
  name: "escalate_to_human",
  description:
    "Escalates the current question to human accountants. Immediately creates a notification for all admin users AND records an entry in agent_actions for review/acknowledgement. Does NOT change any ledger, balance, approval, or compliance status. Use only when human judgment is genuinely required.",
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
    if (ctx.dryRun) {
      return {
        ok: true,
        data: {
          dry_run: true,
          would_have_escalated: true,
          severity: args.severity,
          would_have_notified_user_ids: admins.map((a) => a.id),
          recipient_count: admins.length,
          note: "No notifications were created because this call ran in preview mode.",
        },
      };
    }
    const inserted = await db
      .insert(notificationsTable)
      .values(
        admins.map((a) => ({
          userId: a.id,
          type: "copilot_escalation",
          title,
          body: args.reason,
          link: `/approvals/copilot`,
          referenceType: args.referenceType ?? "copilot_thread",
          referenceId: args.referenceId ?? ctx.threadId,
          emailTo: a.email,
        })),
      )
      .returning({ id: notificationsTable.id, userId: notificationsTable.userId });
    const payload = {
      reason: args.reason,
      severity: args.severity,
      reference_type: args.referenceType ?? null,
      reference_id: args.referenceId ?? null,
      notified_user_ids: admins.map((a) => a.id),
      notification_ids: inserted.map((r) => r.id),
      acknowledged: false,
    };
    const row = await persistAgentAction(ctx, {
      actionType: "escalate_to_human",
      payload,
      riskFlags: `severity:${args.severity}`,
    });
    return {
      ok: true,
      data: {
        agent_action_id: row.id,
        action_type: "escalate_to_human",
        status: "pending_review",
        escalated: true,
        severity: args.severity,
        recipient_count: admins.length,
        notification_ids: inserted.map((r) => r.id),
        note: "Admins were notified and an agent_action row was created for acknowledgement.",
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
  searchInternalPolicies,
  draftJournalEntry,
  draftMemo,
  createFollowupTask,
  escalateToHuman,
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
  // Step 7: enforce per-role tool scope BEFORE arg validation.
  // Fail closed — the caller is expected to log this as status='denied'.
  const scope = isToolAllowedForRole(name, ctx.user.role);
  if (!scope.allowed) {
    return { ok: false, error: scope.reason, denied: true };
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
