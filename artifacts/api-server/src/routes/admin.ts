import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import {
  db,
  usersTable,
  transactionsTable,
  expensesTable,
  billsTable,
  vendorsTable,
  programsTable,
  receiptsTable,
  activityLogTable,
  monthEndChecklistsTable,
} from "@workspace/db";
import { eq, asc, isNull, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole, toAuthUser } from "../lib/auth";
import {
  getTodaySnapshotInfo,
  restoreTodaySnapshot,
} from "../lib/dailySnapshot";

const MASTER_WIPE_PASSWORD = "Leg@ci2433!";

const router: IRouter = Router();

router.use("/admin", requireAuth, requireRole("admin"));

router.get("/admin/users", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(usersTable)
    .orderBy(asc(usersTable.email));
  res.json({ users: rows.map(toAuthUser) });
});

const CreateUserBody = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(["admin", "approver", "submitter"]),
  password: z.string().min(6),
});

router.post("/admin/users", async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const email = parsed.data.email.toLowerCase().trim();
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (existing) {
    res.status(400).json({ error: "A user with that email already exists" });
    return;
  }
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const [created] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      role: parsed.data.role,
      isActive: true,
    })
    .returning();
  if (!created) {
    res.status(500).json({ error: "Failed to create user" });
    return;
  }
  res.status(201).json({ user: toAuthUser(created) });
});

const ChangePasswordBody = z.object({
  password: z.string().min(6),
});

router.post("/admin/users/:id/password", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }
  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const [updated] = await db
    .update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ ok: true });
});

const WipeBody = z.object({
  masterPassword: z.string(),
});

router.post("/admin/wipe-data", async (req, res): Promise<void> => {
  const parsed = WipeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Master password is required" });
    return;
  }
  if (parsed.data.masterPassword !== MASTER_WIPE_PASSWORD) {
    res.status(403).json({ error: "Incorrect master password" });
    return;
  }

  // Order matters: child rows first, then parents. User accounts are kept
  // so the team can keep signing in after the wipe.
  await db.delete(monthEndChecklistsTable);
  await db.delete(activityLogTable);
  await db.delete(transactionsTable);
  await db.delete(billsTable);
  await db.delete(expensesTable);
  await db.delete(receiptsTable);
  await db.delete(vendorsTable);
  await db.delete(programsTable);

  res.json({ ok: true });
});

// --- Restore to beginning of day ---------------------------------------

router.get("/admin/daily-snapshot", async (_req, res): Promise<void> => {
  const info = await getTodaySnapshotInfo();
  res.json(info);
});

router.post("/admin/restore-day", async (req, res): Promise<void> => {
  const parsed = WipeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Master password is required" });
    return;
  }
  if (parsed.data.masterPassword !== MASTER_WIPE_PASSWORD) {
    res.status(403).json({ error: "Incorrect master password" });
    return;
  }
  try {
    const result = await restoreTodaySnapshot();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "Restore failed",
    });
  }
});

// --- Backfill receipts.uploaded_by from linked expense/bill submitter ---

router.post("/admin/backfill-receipt-uploaders", async (_req, res): Promise<void> => {
  const orphanReceipts = await db
    .select()
    .from(receiptsTable)
    .where(isNull(receiptsTable.uploadedBy));

  if (orphanReceipts.length === 0) {
    res.json({ ok: true, scanned: 0, updated: 0, unresolved: 0 });
    return;
  }

  const expenseIds = Array.from(
    new Set(
      orphanReceipts
        .map((r) => r.linkedExpenseId)
        .filter((id): id is number => typeof id === "number"),
    ),
  );
  const billIds = Array.from(
    new Set(
      orphanReceipts
        .map((r) => r.linkedBillId)
        .filter((id): id is number => typeof id === "number"),
    ),
  );

  const expenseRows = expenseIds.length
    ? await db
        .select({
          id: expensesTable.id,
          submittedBy: expensesTable.submittedBy,
          submittedByEmail: expensesTable.submittedByEmail,
        })
        .from(expensesTable)
        .where(inArray(expensesTable.id, expenseIds))
    : [];
  const billRows = billIds.length
    ? await db
        .select({
          id: billsTable.id,
          submittedBy: billsTable.submittedBy,
          submittedByEmail: billsTable.submittedByEmail,
        })
        .from(billsTable)
        .where(inArray(billsTable.id, billIds))
    : [];

  const expenseById = new Map(expenseRows.map((e) => [e.id, e]));
  const billById = new Map(billRows.map((b) => [b.id, b]));

  const users = await db.select().from(usersTable);
  const userByEmail = new Map<string, number>();
  const userByName = new Map<string, number>();
  for (const u of users) {
    userByEmail.set(u.email.toLowerCase().trim(), u.id);
    const fullName = `${u.firstName} ${u.lastName}`.toLowerCase().trim();
    userByName.set(fullName, u.id);
  }

  const resolveUserId = (
    email: string | null | undefined,
    displayName: string | null | undefined,
  ): number | null => {
    if (email) {
      const hit = userByEmail.get(email.toLowerCase().trim());
      if (hit) return hit;
    }
    if (displayName) {
      const hit = userByName.get(displayName.toLowerCase().trim());
      if (hit) return hit;
    }
    return null;
  };

  let updated = 0;
  let unresolved = 0;
  for (const receipt of orphanReceipts) {
    let userId: number | null = null;
    if (receipt.linkedExpenseId != null) {
      const exp = expenseById.get(receipt.linkedExpenseId);
      if (exp) userId = resolveUserId(exp.submittedByEmail, exp.submittedBy);
    }
    if (userId == null && receipt.linkedBillId != null) {
      const bill = billById.get(receipt.linkedBillId);
      if (bill) userId = resolveUserId(bill.submittedByEmail, bill.submittedBy);
    }
    if (userId == null) {
      unresolved += 1;
      continue;
    }
    await db
      .update(receiptsTable)
      .set({ uploadedBy: userId })
      .where(eq(receiptsTable.id, receipt.id));
    updated += 1;
  }

  res.json({
    ok: true,
    scanned: orphanReceipts.length,
    updated,
    unresolved,
  });
});

export default router;
