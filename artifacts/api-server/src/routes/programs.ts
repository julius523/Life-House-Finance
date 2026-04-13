import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { programsTable, expensesTable, billsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  ListProgramsQueryParams,
  ListProgramsResponse,
  CreateProgramBody,
  GetProgramParams,
  GetProgramResponse,
  UpdateProgramParams,
  UpdateProgramBody,
  UpdateProgramResponse,
  GetProgramSpendingParams,
  GetProgramSpendingQueryParams,
  GetProgramSpendingResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function getProgramTotals(programId: number) {
  const [expenseSum] = await db
    .select({ total: sql<string>`coalesce(sum(${expensesTable.amount}), 0)`, cnt: sql<number>`count(*)` })
    .from(expensesTable)
    .where(eq(expensesTable.programId, programId));

  const [billSum] = await db
    .select({ total: sql<string>`coalesce(sum(${billsTable.amount}), 0)`, cnt: sql<number>`count(*)` })
    .from(billsTable)
    .where(eq(billsTable.programId, programId));

  return {
    totalSpend: parseFloat(expenseSum?.total ?? "0") + parseFloat(billSum?.total ?? "0"),
    expenseCount: Number(expenseSum?.cnt ?? 0),
    billCount: Number(billSum?.cnt ?? 0),
  };
}

function formatProgram(p: typeof programsTable.$inferSelect, totalSpend: number, percentUsed?: number) {
  return {
    id: p.id,
    name: p.name,
    type: p.type as "program" | "grant" | "fund" | "site" | "department",
    description: p.description ?? undefined,
    code: p.code ?? undefined,
    budgetAmount: p.budgetAmount ? parseFloat(p.budgetAmount) : undefined,
    fiscalYear: p.fiscalYear ?? undefined,
    isActive: p.isActive,
    totalSpend,
    percentUsed,
    createdAt: p.createdAt.toISOString(),
  };
}

router.get("/programs", async (req, res): Promise<void> => {
  const parsed = ListProgramsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { type } = parsed.data;

  const programs = type
    ? await db.select().from(programsTable).where(eq(programsTable.type, type))
    : await db.select().from(programsTable);

  const items = await Promise.all(
    programs.map(async (p) => {
      const { totalSpend } = await getProgramTotals(p.id);
      const budget = p.budgetAmount ? parseFloat(p.budgetAmount) : undefined;
      const percentUsed = budget && budget > 0 ? (totalSpend / budget) * 100 : undefined;
      return formatProgram(p, totalSpend, percentUsed);
    })
  );

  res.json(ListProgramsResponse.parse(items));
});

router.post("/programs", async (req, res): Promise<void> => {
  const parsed = CreateProgramBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = parsed.data;
  const [program] = await db
    .insert(programsTable)
    .values({
      name: data.name,
      type: data.type,
      description: data.description,
      code: data.code,
      budgetAmount: data.budgetAmount !== undefined ? String(data.budgetAmount) : undefined,
      fiscalYear: data.fiscalYear,
    })
    .returning();

  if (!program) {
    res.status(500).json({ error: "Failed to create program" });
    return;
  }
  res.status(201).json(GetProgramResponse.parse(formatProgram(program, 0)));
});

router.get("/programs/:id", async (req, res): Promise<void> => {
  const parsed = GetProgramParams.safeParse({ id: Number(req.params["id"]) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [program] = await db.select().from(programsTable).where(eq(programsTable.id, parsed.data.id));
  if (!program) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { totalSpend } = await getProgramTotals(program.id);
  const budget = program.budgetAmount ? parseFloat(program.budgetAmount) : undefined;
  const percentUsed = budget && budget > 0 ? (totalSpend / budget) * 100 : undefined;
  res.json(GetProgramResponse.parse(formatProgram(program, totalSpend, percentUsed)));
});

router.put("/programs/:id", async (req, res): Promise<void> => {
  const idParsed = UpdateProgramParams.safeParse({ id: Number(req.params["id"]) });
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const bodyParsed = UpdateProgramBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = bodyParsed.data;
  const updates: Record<string, unknown> = {};
  if (data.name !== undefined) updates["name"] = data.name;
  if (data.type !== undefined) updates["type"] = data.type;
  if (data.description !== undefined) updates["description"] = data.description;
  if (data.code !== undefined) updates["code"] = data.code;
  if (data.budgetAmount !== undefined) updates["budgetAmount"] = String(data.budgetAmount);
  if (data.fiscalYear !== undefined) updates["fiscalYear"] = data.fiscalYear;

  const [program] = await db
    .update(programsTable)
    .set(updates as Parameters<typeof db.update>[0] extends unknown ? never : unknown)
    .where(eq(programsTable.id, idParsed.data.id))
    .returning();

  if (!program) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { totalSpend } = await getProgramTotals(program.id);
  const budget = program.budgetAmount ? parseFloat(program.budgetAmount) : undefined;
  const percentUsed = budget && budget > 0 ? (totalSpend / budget) * 100 : undefined;
  res.json(UpdateProgramResponse.parse(formatProgram(program, totalSpend, percentUsed)));
});

router.get("/programs/:id/spending", async (req, res): Promise<void> => {
  const idParsed = GetProgramSpendingParams.safeParse({ id: Number(req.params["id"]) });
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const queryParsed = GetProgramSpendingQueryParams.safeParse(req.query);

  const [program] = await db.select().from(programsTable).where(eq(programsTable.id, idParsed.data.id));
  if (!program) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const { totalSpend, expenseCount, billCount } = await getProgramTotals(program.id);

  const expenses = await db.select().from(expensesTable).where(eq(expensesTable.programId, program.id));
  const bills = await db.select().from(billsTable).where(eq(billsTable.programId, program.id));

  const monthlyMap = new Map<string, number>();
  for (const e of expenses) {
    const month = e.expenseDate.substring(0, 7);
    monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + parseFloat(e.amount));
  }
  for (const b of bills) {
    const month = b.dueDate.substring(0, 7);
    monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + parseFloat(b.amount));
  }

  const spendByMonth = Array.from(monthlyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({ month, amount }));

  const budget = program.budgetAmount ? parseFloat(program.budgetAmount) : undefined;
  const percentUsed = budget && budget > 0 ? (totalSpend / budget) * 100 : undefined;

  res.json(
    GetProgramSpendingResponse.parse({
      programId: program.id,
      programName: program.name,
      fiscalYear: program.fiscalYear ?? (queryParsed.success ? (queryParsed.data.fiscalYear ?? "2024-2025") : "2024-2025"),
      budgetAmount: budget,
      totalSpend,
      percentUsed,
      expenseCount,
      billCount,
      spendByMonth,
    })
  );
});

export default router;
