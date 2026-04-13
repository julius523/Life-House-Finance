import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { expensesTable, billsTable, programsTable, vendorsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  ListApprovalsQueryParams,
  ListApprovalsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/approvals", async (req, res): Promise<void> => {
  const parsed = ListApprovalsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { type } = parsed.data;
  const now = new Date();
  const items: unknown[] = [];

  if (!type || type === "expense") {
    const expenses = await db.select().from(expensesTable).where(eq(expensesTable.status, "submitted"));
    for (const e of expenses) {
      let programName: string | undefined;
      if (e.programId) {
        const [p] = await db.select({ name: programsTable.name }).from(programsTable).where(eq(programsTable.id, e.programId));
        programName = p?.name;
      }
      const submittedAt = e.createdAt;
      const daysWaiting = Math.floor((now.getTime() - submittedAt.getTime()) / (1000 * 60 * 60 * 24));
      const urgency = daysWaiting > 7 ? "high" : daysWaiting > 3 ? "medium" : "low";

      items.push({
        id: e.id * 100 + 1,
        type: "expense",
        referenceId: e.id,
        submittedBy: e.submittedBy,
        description: `${e.merchant} - ${e.description}`,
        amount: parseFloat(e.amount),
        programName,
        submittedAt: submittedAt.toISOString(),
        daysWaiting,
        urgency,
      });
    }
  }

  if (!type || type === "bill") {
    const bills = await db.select().from(billsTable).where(eq(billsTable.status, "submitted"));
    for (const b of bills) {
      let programName: string | undefined;
      if (b.programId) {
        const [p] = await db.select({ name: programsTable.name }).from(programsTable).where(eq(programsTable.id, b.programId));
        programName = p?.name;
      }
      const [vendor] = await db.select({ name: vendorsTable.name }).from(vendorsTable).where(eq(vendorsTable.id, b.vendorId));
      const submittedAt = b.createdAt;
      const daysWaiting = Math.floor((now.getTime() - submittedAt.getTime()) / (1000 * 60 * 60 * 24));
      const urgency = daysWaiting > 7 ? "high" : daysWaiting > 3 ? "medium" : "low";

      items.push({
        id: b.id * 100 + 2,
        type: "bill",
        referenceId: b.id,
        submittedBy: vendor?.name ?? "Unknown Vendor",
        description: b.description ?? `Invoice from ${vendor?.name ?? "Vendor"}`,
        amount: parseFloat(b.amount),
        programName,
        submittedAt: submittedAt.toISOString(),
        daysWaiting,
        urgency,
      });
    }
  }

  items.sort((a: unknown, b: unknown) => {
    const itemA = a as { urgency: string; daysWaiting: number };
    const itemB = b as { urgency: string; daysWaiting: number };
    const urgencyOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (urgencyOrder[itemA.urgency] ?? 2) - (urgencyOrder[itemB.urgency] ?? 2) || itemB.daysWaiting - itemA.daysWaiting;
  });

  res.json(ListApprovalsResponse.parse(items));
});

export default router;
