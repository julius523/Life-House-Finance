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
  emailSettingsTable,
  emailTemplatesTable,
} from "@workspace/db";
import { eq, asc, isNull, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole, toAuthUser } from "../lib/auth";
import {
  getTodaySnapshotInfo,
  restoreTodaySnapshot,
} from "../lib/dailySnapshot";
import {
  DEFAULT_EMAIL_TEMPLATES,
  DEFAULT_SENDER_NAME,
  deliverEmail,
  getSenderName,
  renderTemplate,
} from "../lib/notifications";

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

// --- Email settings & templates ----------------------------------------

const KNOWN_TEMPLATE_TYPES = Object.keys(DEFAULT_EMAIL_TEMPLATES);

const TEMPLATE_VARIABLES: Record<string, string[]> = {
  bill_needs_correction: ["itemId", "itemName", "amount", "actor", "reason", "link"],
  expense_needs_correction: ["itemId", "itemName", "amount", "actor", "reason", "link"],
};

const SAMPLE_VARIABLES: Record<string, Record<string, string>> = {
  bill_needs_correction: {
    itemId: "1234",
    itemName: "Acme Plumbing",
    amount: "245.00",
    actor: "Casey Admin",
    reason: "Please attach a clearer copy of the invoice.",
    link: "/bills/1234",
  },
  expense_needs_correction: {
    itemId: "987",
    itemName: "Costco Wholesale",
    amount: "84.21",
    actor: "Casey Admin",
    reason: "Please split the food and supplies portions.",
    link: "/expenses/987",
  },
};

router.get("/admin/email-settings", async (_req, res): Promise<void> => {
  const senderName = await getSenderName();
  const rows = await db.select().from(emailTemplatesTable);
  const byType = new Map(rows.map((r) => [r.type, r]));
  const templates = KNOWN_TEMPLATE_TYPES.map((type) => {
    const stored = byType.get(type);
    const fallback = DEFAULT_EMAIL_TEMPLATES[type]!;
    return {
      type,
      subject: stored?.subject ?? fallback.subject,
      body: stored?.body ?? fallback.body,
      defaultSubject: fallback.subject,
      defaultBody: fallback.body,
      variables: TEMPLATE_VARIABLES[type] ?? [],
      sampleVariables: SAMPLE_VARIABLES[type] ?? {},
      updatedAt: stored?.updatedAt ?? null,
    };
  });
  res.json({
    senderName,
    defaultSenderName: DEFAULT_SENDER_NAME,
    templates,
  });
});

const EmailSettingsBody = z.object({
  senderName: z.string().min(1).max(120),
  templates: z.array(
    z.object({
      type: z.string().min(1),
      subject: z.string().min(1).max(300),
      body: z.string().min(1).max(8000),
    }),
  ),
});

router.put("/admin/email-settings", async (req, res): Promise<void> => {
  const parsed = EmailSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid body",
    });
    return;
  }
  const { senderName, templates } = parsed.data;

  for (const t of templates) {
    if (!KNOWN_TEMPLATE_TYPES.includes(t.type)) {
      res.status(400).json({ error: `Unknown template type: ${t.type}` });
      return;
    }
  }

  const now = new Date();
  // Wrap sender + template upserts in one transaction so a mid-loop failure
  // can never leave the settings half-applied.
  await db.transaction(async (tx) => {
    await tx
      .insert(emailSettingsTable)
      .values({ id: 1, senderName, updatedAt: now })
      .onConflictDoUpdate({
        target: emailSettingsTable.id,
        set: { senderName, updatedAt: now },
      });

    for (const t of templates) {
      await tx
        .insert(emailTemplatesTable)
        .values({
          type: t.type,
          subject: t.subject,
          body: t.body,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: emailTemplatesTable.type,
          set: { subject: t.subject, body: t.body, updatedAt: now },
        });
    }
  });

  res.json({ ok: true });
});

const SendTestBody = z.object({
  type: z.string().min(1),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(8000),
});

router.post("/admin/email-settings/test", async (req, res): Promise<void> => {
  const parsed = SendTestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid body",
    });
    return;
  }
  if (!KNOWN_TEMPLATE_TYPES.includes(parsed.data.type)) {
    res.status(400).json({ error: `Unknown template type: ${parsed.data.type}` });
    return;
  }
  const me = req.authUser;
  if (!me?.email) {
    res
      .status(400)
      .json({ error: "Your account has no email address on file." });
    return;
  }

  const sample = SAMPLE_VARIABLES[parsed.data.type] ?? {};
  const subject = renderTemplate(parsed.data.subject, sample);
  const body = renderTemplate(parsed.data.body, sample);
  const link = sample["link"] ?? null;

  const sent = await deliverEmail({
    to: me.email,
    subject: `[TEST] ${subject}`,
    body,
    link,
  });

  res.json({
    ok: true,
    delivered: sent,
    to: me.email,
    subject,
    body,
    note: sent
      ? "Test email queued for delivery."
      : "No SMTP provider is configured (SENDGRID_API_KEY + NOTIFICATION_FROM_EMAIL). The rendered email was logged to the server logs instead.",
  });
});

export default router;
