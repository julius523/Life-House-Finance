import { Router, type IRouter } from "express";
import { db, notificationsTable } from "@workspace/db";
import { and, count, desc, eq, isNull } from "drizzle-orm";

const router: IRouter = Router();

function format(n: typeof notificationsTable.$inferSelect) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link ?? undefined,
    referenceType: n.referenceType ?? undefined,
    referenceId: n.referenceId ?? undefined,
    readAt: n.readAt ? n.readAt.toISOString() : undefined,
    createdAt: n.createdAt.toISOString(),
  };
}

router.get("/notifications", async (req, res): Promise<void> => {
  if (!req.authUser) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const unreadOnly = req.query["unreadOnly"] === "true";
  const conditions = [eq(notificationsTable.userId, req.authUser.id)];
  if (unreadOnly) conditions.push(isNull(notificationsTable.readAt));
  const [rows, unreadResult] = await Promise.all([
    db
      .select()
      .from(notificationsTable)
      .where(and(...conditions))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(50),
    db
      .select({ cnt: count() })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.userId, req.authUser.id),
          isNull(notificationsTable.readAt),
        ),
      ),
  ]);
  const items = rows.map(format);
  const unreadCount = unreadResult[0]?.cnt ?? 0;
  res.json({ items, unreadCount });
});

router.post("/notifications/:id/read", async (req, res): Promise<void> => {
  if (!req.authUser) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [updated] = await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notificationsTable.id, id),
        eq(notificationsTable.userId, req.authUser.id),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(format(updated));
});

router.post("/notifications/read-all", async (req, res): Promise<void> => {
  if (!req.authUser) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notificationsTable.userId, req.authUser.id),
        isNull(notificationsTable.readAt),
      ),
    );
  res.json({ ok: true });
});

export default router;
