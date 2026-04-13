import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { monthEndChecklistsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ListMonthEndChecklistsResponse,
  CreateMonthEndChecklistBody,
  GetMonthEndChecklistParams,
  GetMonthEndChecklistResponse,
  UpdateMonthEndChecklistParams,
  UpdateMonthEndChecklistBody,
  UpdateMonthEndChecklistResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const DEFAULT_CHECKLIST_ITEMS = [
  { label: "Review all submitted expenses", category: "Expenses", isCompleted: false },
  { label: "Approve or reject pending expense claims", category: "Expenses", isCompleted: false },
  { label: "Verify all receipts are attached", category: "Expenses", isCompleted: false },
  { label: "Review vendor bills due this month", category: "Bills", isCompleted: false },
  { label: "Approve outstanding vendor bills", category: "Bills", isCompleted: false },
  { label: "Import bank statements", category: "Bank Reconciliation", isCompleted: false },
  { label: "Match transactions to expenses and bills", category: "Bank Reconciliation", isCompleted: false },
  { label: "Reconcile all matched transactions", category: "Bank Reconciliation", isCompleted: false },
  { label: "Identify unmatched transactions", category: "Bank Reconciliation", isCompleted: false },
  { label: "Review program/grant spending against budgets", category: "Reporting", isCompleted: false },
  { label: "Generate Statement of Activities", category: "Reporting", isCompleted: false },
  { label: "Generate Balance Sheet", category: "Reporting", isCompleted: false },
  { label: "Archive supporting documents", category: "Documentation", isCompleted: false },
  { label: "Send summary to finance lead", category: "Documentation", isCompleted: false },
];

type ChecklistItem = {
  id: number;
  label: string;
  category: string;
  isCompleted: boolean;
  completedBy?: string;
  completedAt?: string;
  notes?: string;
};

function formatChecklist(c: typeof monthEndChecklistsTable.$inferSelect) {
  const items = (c.items as ChecklistItem[]) ?? [];
  const completedCount = items.filter((item) => item.isCompleted).length;
  return {
    id: c.id,
    month: c.month,
    fiscalYear: c.fiscalYear,
    status: c.status as "open" | "in_progress" | "completed",
    owner: c.owner ?? undefined,
    items,
    completedCount,
    totalCount: items.length,
    createdAt: c.createdAt.toISOString(),
    closedAt: c.closedAt?.toISOString(),
  };
}

router.get("/month-end", async (_req, res): Promise<void> => {
  const checklists = await db.select().from(monthEndChecklistsTable);
  res.json(ListMonthEndChecklistsResponse.parse(checklists.map(formatChecklist)));
});

router.post("/month-end", async (req, res): Promise<void> => {
  const parsed = CreateMonthEndChecklistBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const items = DEFAULT_CHECKLIST_ITEMS.map((item, index) => ({ ...item, id: index + 1 }));
  const [checklist] = await db
    .insert(monthEndChecklistsTable)
    .values({
      month: parsed.data.month,
      fiscalYear: parsed.data.fiscalYear,
      owner: parsed.data.owner,
      items,
      status: "open",
    })
    .returning();

  if (!checklist) {
    res.status(500).json({ error: "Failed to create checklist" });
    return;
  }
  res.status(201).json(GetMonthEndChecklistResponse.parse(formatChecklist(checklist)));
});

router.get("/month-end/:id", async (req, res): Promise<void> => {
  const parsed = GetMonthEndChecklistParams.safeParse({ id: Number(req.params["id"]) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [checklist] = await db.select().from(monthEndChecklistsTable).where(eq(monthEndChecklistsTable.id, parsed.data.id));
  if (!checklist) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(GetMonthEndChecklistResponse.parse(formatChecklist(checklist)));
});

router.put("/month-end/:id", async (req, res): Promise<void> => {
  const idParsed = UpdateMonthEndChecklistParams.safeParse({ id: Number(req.params["id"]) });
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const bodyParsed = UpdateMonthEndChecklistBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const [existing] = await db.select().from(monthEndChecklistsTable).where(eq(monthEndChecklistsTable.id, idParsed.data.id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const data = bodyParsed.data;
  let items = (existing.items as ChecklistItem[]) ?? [];

  if (data.items) {
    items = items.map((item) => {
      const update = data.items?.find((u) => u.id === item.id);
      if (!update) return item;
      return {
        ...item,
        isCompleted: update.isCompleted,
        completedBy: update.completedBy ?? item.completedBy,
        completedAt: update.isCompleted ? new Date().toISOString() : item.completedAt,
        notes: update.notes ?? item.notes,
      };
    });
  }

  const completedCount = items.filter((item) => item.isCompleted).length;
  const newStatus = data.status ?? (completedCount === items.length && items.length > 0 ? "completed" : completedCount > 0 ? "in_progress" : "open");

  const updates: Record<string, unknown> = {
    items,
    status: newStatus,
  };
  if (data.owner !== undefined) updates["owner"] = data.owner;
  if (newStatus === "completed" && existing.status !== "completed") {
    updates["closedAt"] = new Date();
  }

  const [checklist] = await db
    .update(monthEndChecklistsTable)
    .set(updates as Parameters<typeof db.update>[0] extends unknown ? never : unknown)
    .where(eq(monthEndChecklistsTable.id, idParsed.data.id))
    .returning();

  if (!checklist) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(UpdateMonthEndChecklistResponse.parse(formatChecklist(checklist)));
});

export default router;
