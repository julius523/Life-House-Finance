import { Router, type IRouter } from "express";
import { requireRole } from "../lib/auth";
import { db } from "@workspace/db";
import {
  billsTable,
  vendorsTable,
  programsTable,
  expenseCategoriesTable,
  activityLogTable,
  transactionsTable,
  accountingSourceLinksTable,
  manualJournalEntryDraftsTable,
  journalEntriesTable,
} from "@workspace/db";
import { eq, and, desc, isNull, inArray } from "drizzle-orm";
import { createNotification, findUserByEmail } from "../lib/notifications";
import {
  generateAccrualDraftFromBill,
  generatePaymentDraftFromBill,
} from "../lib/billDraftService";
import {
  ListBillsQueryParams,
  ListBillsResponse,
  CreateBillBody,
  GetBillParams,
  GetBillResponse,
  UpdateBillParams,
  UpdateBillBody,
  UpdateBillResponse,
  ApproveBillParams,
  ApproveBillBody,
  ApproveBillResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function getVendorName(vendorId: number): Promise<string> {
  const [v] = await db
    .select({ name: vendorsTable.name })
    .from(vendorsTable)
    .where(eq(vendorsTable.id, vendorId));
  return v?.name ?? "Unknown Vendor";
}

async function getProgramName(
  programId: number | null | undefined,
): Promise<string | undefined> {
  if (!programId) return undefined;
  const [p] = await db
    .select({ name: programsTable.name })
    .from(programsTable)
    .where(eq(programsTable.id, programId));
  return p?.name;
}

async function getCategoryName(
  categoryId: number | null | undefined,
): Promise<string | null> {
  if (!categoryId) return null;
  const [c] = await db
    .select({ name: expenseCategoriesTable.name })
    .from(expenseCategoriesTable)
    .where(eq(expenseCategoriesTable.id, categoryId));
  return c?.name ?? null;
}

/**
 * Task #63 — surface the linked manual draft / posted JE per leg so the
 * bill detail page can deep-link reviewers into the accounting bridge.
 * Returns null entries when no link exists yet (pending or not_applicable).
 */
type BillBridgeLeg = {
  draftId: number | null;
  draftStatus: string | null;
  journalEntryId: number | null;
  journalEntryStatus: string | null;
};
async function loadBillAccountingBridge(billId: number): Promise<{
  accrual: BillBridgeLeg;
  payment: BillBridgeLeg;
}> {
  const empty = (): BillBridgeLeg => ({
    draftId: null,
    draftStatus: null,
    journalEntryId: null,
    journalEntryStatus: null,
  });
  const links = await db
    .select()
    .from(accountingSourceLinksTable)
    .where(
      and(
        eq(accountingSourceLinksTable.sourceType, "bill"),
        eq(accountingSourceLinksTable.sourceId, billId),
      ),
    );
  const draftIds = Array.from(
    new Set(
      links
        .map((l) => l.manualJournalEntryDraftId)
        .filter((v): v is number => v != null),
    ),
  );
  const jeIds = Array.from(
    new Set(
      links
        .map((l) => l.journalEntryId)
        .filter((v): v is number => v != null),
    ),
  );
  const [drafts, entries] = await Promise.all([
    draftIds.length > 0
      ? db
          .select({
            id: manualJournalEntryDraftsTable.id,
            status: manualJournalEntryDraftsTable.status,
          })
          .from(manualJournalEntryDraftsTable)
          .where(inArray(manualJournalEntryDraftsTable.id, draftIds))
      : Promise.resolve([] as Array<{ id: number; status: string }>),
    jeIds.length > 0
      ? db
          .select({
            id: journalEntriesTable.id,
            status: journalEntriesTable.status,
          })
          .from(journalEntriesTable)
          .where(inArray(journalEntriesTable.id, jeIds))
      : Promise.resolve([] as Array<{ id: number; status: string }>),
  ]);
  const draftById = new Map(drafts.map((d) => [d.id, d.status]));
  const jeById = new Map(entries.map((e) => [e.id, e.status]));
  const out = { accrual: empty(), payment: empty() };
  for (const link of links) {
    const slot =
      link.eventType === "accrual"
        ? out.accrual
        : link.eventType === "payment"
          ? out.payment
          : null;
    if (!slot) continue;
    if (link.manualJournalEntryDraftId != null) {
      slot.draftId = link.manualJournalEntryDraftId;
      slot.draftStatus =
        draftById.get(link.manualJournalEntryDraftId) ?? null;
    }
    if (link.journalEntryId != null) {
      slot.journalEntryId = link.journalEntryId;
      slot.journalEntryStatus = jeById.get(link.journalEntryId) ?? null;
    }
  }
  return out;
}

function formatBill(
  b: typeof billsTable.$inferSelect,
  vendorName: string,
  programName?: string,
  categoryName?: string | null,
) {
  return {
    id: b.id,
    vendorId: b.vendorId,
    vendorName,
    invoiceNumber: b.invoiceNumber ?? undefined,
    invoiceDate: b.invoiceDate ?? undefined,
    dueDate: b.dueDate,
    amount: parseFloat(b.amount),
    description: b.description ?? undefined,
    programId: b.programId ?? undefined,
    programName,
    categoryId: b.categoryId ?? null,
    categoryName: categoryName ?? null,
    status: b.status as
      | "draft"
      | "submitted"
      | "approved"
      | "paid"
      | "overdue"
      | "rejected"
      | "needs_correction",
    approvedBy: b.approvedBy ?? undefined,
    rejectionReason: b.rejectionReason ?? undefined,
    paidDate: b.paidDate ?? undefined,
    receiptIds: b.receiptIds ?? undefined,
    submittedBy: b.submittedBy ?? undefined,
    submittedByEmail: b.submittedByEmail ?? undefined,
    accountingStatus: b.accountingStatus as
      | "pending"
      | "draft_created"
      | "blocked"
      | "not_applicable",
    accountingBlockReason: b.accountingBlockReason ?? null,
    accountingGeneratedAt: b.accountingGeneratedAt?.toISOString() ?? null,
    accountingPaymentStatus: b.accountingPaymentStatus as
      | "pending"
      | "draft_created"
      | "blocked"
      | "not_applicable",
    accountingPaymentBlockReason: b.accountingPaymentBlockReason ?? null,
    accountingPaymentGeneratedAt:
      b.accountingPaymentGeneratedAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
  };
}

router.get("/bills", async (req, res): Promise<void> => {
  const parsed = ListBillsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { status, vendorId, programId, submittedBy, submittedByEmail } =
    parsed.data;

  const conditions = [];
  if (status) conditions.push(eq(billsTable.status, status));
  if (vendorId) conditions.push(eq(billsTable.vendorId, vendorId));
  if (programId) conditions.push(eq(billsTable.programId, programId));
  if (submittedBy) conditions.push(eq(billsTable.submittedBy, submittedBy));
  if (submittedByEmail)
    conditions.push(eq(billsTable.submittedByEmail, submittedByEmail));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const bills = await db
    .select()
    .from(billsTable)
    .where(where)
    .orderBy(desc(billsTable.createdAt));

  // Batch lookups so list pages aren't N+1.
  const vendorIds = Array.from(new Set(bills.map((b) => b.vendorId)));
  const programIds = Array.from(
    new Set(
      bills.map((b) => b.programId).filter((v): v is number => v !== null),
    ),
  );
  const categoryIds = Array.from(
    new Set(
      bills.map((b) => b.categoryId).filter((v): v is number => v !== null),
    ),
  );
  const vendorRows =
    vendorIds.length > 0
      ? await db
          .select({ id: vendorsTable.id, name: vendorsTable.name })
          .from(vendorsTable)
          .where(inArray(vendorsTable.id, vendorIds))
      : [];
  const programRows =
    programIds.length > 0
      ? await db
          .select({ id: programsTable.id, name: programsTable.name })
          .from(programsTable)
          .where(inArray(programsTable.id, programIds))
      : [];
  const categoryRows =
    categoryIds.length > 0
      ? await db
          .select({
            id: expenseCategoriesTable.id,
            name: expenseCategoriesTable.name,
          })
          .from(expenseCategoriesTable)
          .where(inArray(expenseCategoriesTable.id, categoryIds))
      : [];
  const vendorById = new Map(vendorRows.map((r) => [r.id, r.name]));
  const programById = new Map(programRows.map((r) => [r.id, r.name]));
  const categoryById = new Map(categoryRows.map((r) => [r.id, r.name]));

  const items = bills.map((b) =>
    formatBill(
      b,
      vendorById.get(b.vendorId) ?? "Unknown Vendor",
      b.programId ? programById.get(b.programId) : undefined,
      b.categoryId ? (categoryById.get(b.categoryId) ?? null) : null,
    ),
  );

  res.json(ListBillsResponse.parse(items));
});

router.post("/bills", async (req, res): Promise<void> => {
  const parsed = CreateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = parsed.data;
  const submittedBy =
    (req.body && typeof req.body.submittedBy === "string"
      ? req.body.submittedBy.trim()
      : "") ||
    (req.authUser
      ? `${req.authUser.firstName} ${req.authUser.lastName}`
      : "Unknown");
  const submittedByEmail = req.authUser?.email ?? null;
  const [bill] = await db
    .insert(billsTable)
    .values({
      vendorId: data.vendorId,
      invoiceNumber: data.invoiceNumber,
      invoiceDate: data.invoiceDate,
      dueDate: data.dueDate,
      amount: String(data.amount),
      description: data.description,
      programId: data.programId,
      categoryId: data.categoryId ?? null,
      receiptIds: data.receiptIds,
      status: "submitted",
      submittedBy,
      submittedByEmail,
    })
    .returning();

  if (!bill) {
    res.status(500).json({ error: "Failed to create bill" });
    return;
  }

  const vendorName = await getVendorName(bill.vendorId);
  await db.insert(activityLogTable).values({
    type: "bill_created",
    description: `Bill created for ${vendorName}`,
    actor: "Finance Staff",
    amount: String(bill.amount),
    referenceId: bill.id,
    referenceType: "bill",
  });

  const programName = await getProgramName(bill.programId);
  const categoryName = await getCategoryName(bill.categoryId);
  res
    .status(201)
    .json(
      GetBillResponse.parse(
        formatBill(bill, vendorName, programName, categoryName),
      ),
    );
});

router.get("/bills/:id", async (req, res): Promise<void> => {
  const parsed = GetBillParams.safeParse({ id: Number(req.params["id"]) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [bill] = await db
    .select()
    .from(billsTable)
    .where(eq(billsTable.id, parsed.data.id));
  if (!bill) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const vendorName = await getVendorName(bill.vendorId);
  const programName = await getProgramName(bill.programId);
  const categoryName = await getCategoryName(bill.categoryId);
  // Task #63 — append accountingBridge as a passthrough field outside the
  // strict openapi-zod schema (mirrors the originatingExpense passthrough
  // pattern on JE responses).
  const accountingBridge = await loadBillAccountingBridge(bill.id);
  res.json({
    ...GetBillResponse.parse(
      formatBill(bill, vendorName, programName, categoryName),
    ),
    accountingBridge,
  });
});

router.put("/bills/:id", async (req, res): Promise<void> => {
  const idParsed = UpdateBillParams.safeParse({ id: Number(req.params["id"]) });
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const bodyParsed = UpdateBillBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = bodyParsed.data;
  const updates: Record<string, unknown> = {};
  if (data.vendorId !== undefined) updates["vendorId"] = data.vendorId;
  if (data.invoiceNumber !== undefined)
    updates["invoiceNumber"] = data.invoiceNumber;
  if (data.invoiceDate !== undefined) updates["invoiceDate"] = data.invoiceDate;
  if (data.dueDate !== undefined) updates["dueDate"] = data.dueDate;
  if (data.amount !== undefined) updates["amount"] = String(data.amount);
  if (data.description !== undefined) updates["description"] = data.description;
  if (data.programId !== undefined) updates["programId"] = data.programId;
  if (data.categoryId !== undefined) updates["categoryId"] = data.categoryId;
  if (data.receiptIds !== undefined) updates["receiptIds"] = data.receiptIds;

  const [bill] = await db
    .update(billsTable)
    .set(
      updates as Parameters<typeof db.update>[0] extends unknown
        ? never
        : unknown,
    )
    .where(eq(billsTable.id, idParsed.data.id))
    .returning();

  if (!bill) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const vendorName = await getVendorName(bill.vendorId);
  const programName = await getProgramName(bill.programId);
  const categoryName = await getCategoryName(bill.categoryId);
  res.json(
    UpdateBillResponse.parse(
      formatBill(bill, vendorName, programName, categoryName),
    ),
  );
});

router.post(
  "/bills/:id/approve",
  requireRole("admin", "approver"),
  async (req, res): Promise<void> => {
    const idParsed = ApproveBillParams.safeParse({
      id: Number(req.params["id"]),
    });
    if (!idParsed.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const bodyParsed = ApproveBillBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }

    const [bill] = await db
      .update(billsTable)
      .set({ status: "approved", approvedBy: bodyParsed.data.approvedBy })
      .where(eq(billsTable.id, idParsed.data.id))
      .returning();

    if (!bill) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const vendorName = await getVendorName(bill.vendorId);
    await db.insert(activityLogTable).values({
      // Task #63 — distinct activity type so loadOriginatingBills can
      // recover the approval timestamp for bill-origin draft / JE cards.
      type: "bill_approved",
      description: `Bill approved by ${bodyParsed.data.approvedBy}`,
      actor: bodyParsed.data.approvedBy,
      actorUserId: req.authUser?.id ?? null,
      amount: String(bill.amount),
      referenceId: bill.id,
      referenceType: "bill",
    });

    // Task #63 — accrual leg of the bridge. Approval succeeds even if draft
    // generation blocks; we surface the result on the response so the UI
    // can show success / blocked without a second call.
    const accountingResult = await generateAccrualDraftFromBill(bill.id, {
      id: req.authUser!.id,
      display: bodyParsed.data.approvedBy,
    });

    const [refreshed] = await db
      .select()
      .from(billsTable)
      .where(eq(billsTable.id, bill.id));
    const finalBill = refreshed ?? bill;
    const programName = await getProgramName(finalBill.programId);
    const categoryName = await getCategoryName(finalBill.categoryId);
    const accounting = accountingResult.ok
      ? {
          ok: true as const,
          created: accountingResult.created,
          manualJournalEntryDraftId: accountingResult.draftId,
        }
      : {
          ok: false as const,
          reason: accountingResult.reason,
          message: accountingResult.message,
        };
    res.json({
      ...ApproveBillResponse.parse(
        formatBill(finalBill, vendorName, programName, categoryName),
      ),
      accounting,
    });
  },
);

// Task #63 — manual retry. Same generator + same idempotency contract.
// Admin/approver only because it can produce ledger-bound work.
router.post(
  "/bills/:id/regenerate-accounting-draft",
  requireRole("admin", "approver"),
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const eventType = req.body?.eventType;
    if (eventType !== "accrual" && eventType !== "payment") {
      res
        .status(400)
        .json({ error: "eventType must be 'accrual' or 'payment'" });
      return;
    }
    const [bill] = await db
      .select()
      .from(billsTable)
      .where(eq(billsTable.id, id));
    if (!bill) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (eventType === "accrual" && bill.status !== "approved" && bill.status !== "paid") {
      res.status(409).json({
        error: "Bill must be approved before generating an accrual draft",
        code: "BILL_NOT_APPROVED",
      });
      return;
    }
    if (eventType === "payment" && bill.status !== "paid") {
      res.status(409).json({
        error: "Bill must be paid before generating a payment draft",
        code: "BILL_NOT_PAID",
      });
      return;
    }
    const u = req.authUser!;
    const display = `${u.firstName} ${u.lastName}`.trim() || u.email;
    const result =
      eventType === "accrual"
        ? await generateAccrualDraftFromBill(id, { id: u.id, display })
        : await generatePaymentDraftFromBill(id, { id: u.id, display });
    if (result.ok) {
      res.json({
        ok: true,
        created: result.created,
        manualJournalEntryDraftId: result.draftId,
      });
      return;
    }
    res
      .status(422)
      .json({ ok: false, reason: result.reason, message: result.message });
  },
);

// Task #63 — flip a blocked bill leg to not_applicable with a required note.
router.post(
  "/bills/:id/mark-accounting-not-applicable",
  requireRole("admin", "approver"),
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const eventType = req.body?.eventType;
    if (eventType !== "accrual" && eventType !== "payment") {
      res
        .status(400)
        .json({ error: "eventType must be 'accrual' or 'payment'" });
      return;
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (note.length < 3 || note.length > 500) {
      res.status(400).json({ error: "note is required (3–500 characters)" });
      return;
    }
    const [bill] = await db
      .select()
      .from(billsTable)
      .where(eq(billsTable.id, id));
    if (!bill) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const update: Record<string, unknown> =
      eventType === "accrual"
        ? {
            accountingStatus: "not_applicable",
            accountingBlockReason: null,
          }
        : {
            accountingPaymentStatus: "not_applicable",
            accountingPaymentBlockReason: null,
          };
    // Task #63 — atomic state guard: only flip a leg that is currently
    // 'blocked'. Prevents trampling a draft that was generated by a
    // parallel retry between the GET and this POST.
    const [updated] = await db
      .update(billsTable)
      .set(update)
      .where(
        and(
          eq(billsTable.id, id),
          eq(
            eventType === "accrual"
              ? billsTable.accountingStatus
              : billsTable.accountingPaymentStatus,
            "blocked",
          ),
        ),
      )
      .returning();
    if (!updated) {
      // Either the bill doesn't exist (we already 404'd above), or the
      // leg was no longer 'blocked' when we tried to flip it.
      res.status(409).json({
        error:
          `Bill #${id} ${eventType} leg is not currently blocked; ` +
          `refresh and try again.`,
      });
      return;
    }
    const u = req.authUser!;
    const display = `${u.firstName} ${u.lastName}`.trim() || u.email;
    await db.insert(activityLogTable).values({
      type: "bill_accounting_not_applicable",
      description: `Bill #${id} ${eventType} leg marked not applicable: ${note}`,
      actor: display,
      actorUserId: u.id,
      referenceId: id,
      referenceType: "bill",
      metadata: { eventType, note },
    });
    const vendorName = await getVendorName(updated.vendorId);
    const programName = await getProgramName(updated.programId);
    const categoryName = await getCategoryName(updated.categoryId);
    const accountingBridge = await loadBillAccountingBridge(updated.id);
    res.json({
      ...formatBill(updated, vendorName, programName, categoryName),
      accountingBridge,
    });
  },
);

router.post(
  "/bills/:id/reject",
  requireRole("admin", "approver"),
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const action = req.body?.action === "send_back" ? "send_back" : "close";
    if (reason.length < 3) {
      res.status(400).json({ error: "Rejection reason is required" });
      return;
    }
    const newStatus = action === "send_back" ? "needs_correction" : "rejected";
    const rejectedBy = req.authUser
      ? `${req.authUser.firstName} ${req.authUser.lastName}`
      : "Finance User";

    const [bill] = await db
      .update(billsTable)
      .set({ status: newStatus, rejectionReason: reason })
      .where(eq(billsTable.id, id))
      .returning();
    if (!bill) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    await db.insert(activityLogTable).values({
      type: "bill_created",
      description:
        action === "send_back"
          ? `Bill sent back for correction: ${reason}`
          : `Bill rejected: ${reason}`,
      actor: rejectedBy,
      amount: String(bill.amount),
      referenceId: bill.id,
      referenceType: "bill",
    });

    const vendorName = await getVendorName(bill.vendorId);

    if (action === "send_back" && bill.submittedByEmail) {
      const submitter = await findUserByEmail(bill.submittedByEmail);
      if (submitter) {
        await createNotification({
          userId: submitter.id,
          type: "bill_needs_correction",
          title: `Bill #${bill.id} needs your attention`,
          body: `Your bill for ${vendorName} ($${Number(bill.amount).toFixed(2)}) was sent back by ${rejectedBy}. Reason: ${reason}`,
          link: `/bills/${bill.id}`,
          referenceType: "bill",
          referenceId: bill.id,
          variables: {
            itemId: bill.id,
            itemName: vendorName,
            amount: Number(bill.amount).toFixed(2),
            actor: rejectedBy,
            reason,
          },
        });
      }
    }

    const programName = await getProgramName(bill.programId);
    const categoryName = await getCategoryName(bill.categoryId);
    res.json(formatBill(bill, vendorName, programName, categoryName));
  },
);

router.post("/bills/:id/resubmit", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db
    .select()
    .from(billsTable)
    .where(eq(billsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.status !== "needs_correction") {
    res
      .status(409)
      .json({ error: "Only bills needing correction can be resubmitted" });
    return;
  }
  const isAdmin = req.authUser?.role === "admin";
  const callerEmail = req.authUser?.email?.toLowerCase() ?? null;
  const ownerEmail = existing.submittedByEmail?.toLowerCase() ?? null;
  const isOwnerByEmail =
    callerEmail !== null && ownerEmail !== null && callerEmail === ownerEmail;
  const submitterName = req.authUser
    ? `${req.authUser.firstName} ${req.authUser.lastName}`
    : null;
  const isOwnerByName =
    ownerEmail === null &&
    submitterName !== null &&
    existing.submittedBy === submitterName;
  if (!isAdmin && !isOwnerByEmail && !isOwnerByName) {
    res
      .status(403)
      .json({ error: "Only the original submitter can resubmit this bill" });
    return;
  }
  const actorName = submitterName ?? existing.submittedBy ?? "Submitter";

  const [bill] = await db
    .update(billsTable)
    .set({ status: "submitted", rejectionReason: null })
    .where(eq(billsTable.id, id))
    .returning();
  if (!bill) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const vendorName = await getVendorName(bill.vendorId);
  await db.insert(activityLogTable).values({
    type: "bill_created",
    description: `Bill resubmitted for ${vendorName}`,
    actor: actorName,
    amount: String(bill.amount),
    referenceId: bill.id,
    referenceType: "bill",
  });

  const programName = await getProgramName(bill.programId);
  const categoryName = await getCategoryName(bill.categoryId);
  res.json(
    GetBillResponse.parse(
      formatBill(bill, vendorName, programName, categoryName),
    ),
  );
});

router.delete(
  "/bills/:id",
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db
      .update(transactionsTable)
      .set({ matchedBillId: null, status: "unmatched" })
      .where(
        and(
          eq(transactionsTable.matchedBillId, id),
          isNull(transactionsTable.matchedExpenseId),
        ),
      );
    await db
      .update(transactionsTable)
      .set({ matchedBillId: null })
      .where(eq(transactionsTable.matchedBillId, id));

    const [deleted] = await db
      .delete(billsTable)
      .where(eq(billsTable.id, id))
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    await db.insert(activityLogTable).values({
      type: "bill_created",
      description: `Bill #${id} deleted`,
      actor: req.authUser
        ? `${req.authUser.firstName} ${req.authUser.lastName}`
        : "Finance User",
      amount: String(deleted.amount),
      referenceId: id,
      referenceType: "bill",
    });

    res.json({ ok: true });
  },
);

export default router;
