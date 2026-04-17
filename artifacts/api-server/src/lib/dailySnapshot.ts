import {
  db,
  dailySnapshotsTable,
  programsTable,
  vendorsTable,
  vendorContactsTable,
  programContactsTable,
  receiptsTable,
  expensesTable,
  billsTable,
  transactionsTable,
  monthEndChecklistsTable,
  activityLogTable,
  creditsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

const TABLES = [
  { name: "programs", table: programsTable },
  { name: "vendors", table: vendorsTable },
  { name: "vendor_contacts", table: vendorContactsTable },
  { name: "program_contacts", table: programContactsTable },
  { name: "receipts", table: receiptsTable },
  { name: "expenses", table: expensesTable },
  { name: "bills", table: billsTable },
  { name: "transactions", table: transactionsTable },
  { name: "month_end_checklists", table: monthEndChecklistsTable },
  { name: "activity_log", table: activityLogTable },
  { name: "credits", table: creditsTable },
] as const;

// Delete in this order (children first) when restoring / clearing.
const DELETE_ORDER = [
  "month_end_checklists",
  "activity_log",
  "transactions",
  "bills",
  "expenses",
  "receipts",
  "credits",
  "vendor_contacts",
  "program_contacts",
  "vendors",
  "programs",
] as const;

// Insert in reverse dependency order when restoring.
const INSERT_ORDER = [
  "programs",
  "vendors",
  "vendor_contacts",
  "program_contacts",
  "receipts",
  "credits",
  "expenses",
  "bills",
  "transactions",
  "month_end_checklists",
  "activity_log",
] as const;

type TableName = (typeof TABLES)[number]["name"];

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

let ensuredDate: string | null = null;

export async function ensureTodaySnapshot(): Promise<void> {
  const key = todayKey();
  if (ensuredDate === key) return;
  try {
    const [existing] = await db
      .select({ id: dailySnapshotsTable.id })
      .from(dailySnapshotsTable)
      .where(eq(dailySnapshotsTable.snapshotDate, key));
    if (existing) {
      ensuredDate = key;
      return;
    }
    const payload: Record<string, unknown[]> = {};
    for (const { name, table } of TABLES) {
      payload[name] = await db.select().from(table);
    }
    await db
      .insert(dailySnapshotsTable)
      .values({ snapshotDate: key, payload })
      .onConflictDoNothing({ target: dailySnapshotsTable.snapshotDate });
    ensuredDate = key;
    logger.info({ snapshotDate: key }, "Daily snapshot captured");
  } catch (err) {
    logger.error({ err }, "Failed to ensure daily snapshot");
  }
}

export async function restoreTodaySnapshot(): Promise<{
  restoredDate: string;
  tableCounts: Record<string, number>;
}> {
  const key = todayKey();
  const [snap] = await db
    .select()
    .from(dailySnapshotsTable)
    .where(eq(dailySnapshotsTable.snapshotDate, key));
  if (!snap) {
    throw new Error(
      "No snapshot exists for today yet. Please try again in a moment.",
    );
  }
  const payload = snap.payload as Record<TableName, unknown[]>;

  // Wipe current data (child rows first).
  for (const name of DELETE_ORDER) {
    const entry = TABLES.find((t) => t.name === name)!;
    await db.delete(entry.table);
  }

  // Re-insert snapshot rows (parents first).
  const counts: Record<string, number> = {};
  for (const name of INSERT_ORDER) {
    const entry = TABLES.find((t) => t.name === name)!;
    const rows = (payload[name] ?? []) as Record<string, unknown>[];
    counts[name] = rows.length;
    if (rows.length === 0) continue;
    // Drizzle + jsonb round-trips Date objects as ISO strings. That's fine for
    // pg's date/timestamp columns — they accept ISO strings on insert.
    // Insert in chunks to avoid parameter limits.
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.insert(entry.table as any).values(chunk as any);
    }
  }

  // Reset each table's id sequence to max(id)+1 so new inserts don't collide.
  for (const { name } of TABLES) {
    try {
      await db.execute(
        sql`SELECT setval(pg_get_serial_sequence(${name}, 'id'),
            COALESCE((SELECT MAX(id) FROM ${sql.identifier(name)}), 1),
            (SELECT MAX(id) IS NOT NULL FROM ${sql.identifier(name)}))`,
      );
    } catch (err) {
      logger.warn({ err, table: name }, "Could not reset sequence");
    }
  }

  return { restoredDate: key, tableCounts: counts };
}

export async function getTodaySnapshotInfo(): Promise<{
  date: string;
  exists: boolean;
  createdAt: string | null;
}> {
  const key = todayKey();
  const [snap] = await db
    .select({
      createdAt: dailySnapshotsTable.createdAt,
    })
    .from(dailySnapshotsTable)
    .where(eq(dailySnapshotsTable.snapshotDate, key));
  return {
    date: key,
    exists: !!snap,
    createdAt: snap ? snap.createdAt.toISOString() : null,
  };
}
