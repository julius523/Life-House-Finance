import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { AUTOMATION_USER_EMAIL, AUTOMATION_DISPLAY_NAME } from "./apiKey";

type SeedUser = {
  email: string;
  firstName: string;
  lastName: string;
  role: "admin" | "approver" | "submitter" | "service";
  password: string;
};

const SEED_USERS: SeedUser[] = [
  {
    email: "julius@lifehousereentry.com",
    firstName: "Julius",
    lastName: "Reentry",
    role: "admin",
    password: "Julius2433!",
  },
  {
    email: "kai@lifehousereentry.com",
    firstName: "Kai",
    lastName: "Reentry",
    role: "admin",
    password: "Julius2433!",
  },
  {
    email: "brittney@lifehousereentry.com",
    firstName: "Brittney",
    lastName: "Reentry",
    role: "approver",
    password: "Julius2433!",
  },
  {
    email: "lifeup@lifehousereentry.com",
    firstName: "LifeUp",
    lastName: "Staff",
    role: "submitter",
    password: "LifeHouse1!",
  },
];

/**
 * Generates a cryptographically random non-loginable password hash for
 * the automation service account. The plaintext is never persisted or
 * logged — there is no human-typeable credential associated with the
 * service account; it can only authenticate via the
 * INTEGRATION_API_KEY bearer token.
 */
function generateServiceAccountHash(): string {
  const random = crypto.randomBytes(48).toString("base64url");
  return bcrypt.hashSync(random, 10);
}

export async function seedUsers(): Promise<void> {
  // Pass 1: human seed users. If the row exists but the stored hash no
  // longer verifies against the seed password (e.g. an earlier deploy
  // saved the wrong hash, or someone rotated it manually and we want
  // the seed to be authoritative again), heal it in place. New rows
  // are inserted with the seed password.
  for (const u of SEED_USERS) {
    const email = u.email.toLowerCase();
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
    if (!existing) {
      const passwordHash = await bcrypt.hash(u.password, 10);
      await db.insert(usersTable).values({
        email,
        passwordHash,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        isActive: true,
      });
      logger.info({ email }, "Seeded user");
      continue;
    }
    const matches = await bcrypt.compare(u.password, existing.passwordHash);
    if (!matches) {
      const passwordHash = await bcrypt.hash(u.password, 10);
      await db
        .update(usersTable)
        .set({ passwordHash, isActive: true })
        .where(eq(usersTable.email, email));
      logger.info(
        { email },
        "Seed user password hash drifted from the seed value; restored",
      );
    }
  }

  // Pass 2: service account. Idempotent — only created on first boot.
  // Subsequent boots leave the password hash alone so rotating the
  // INTEGRATION_API_KEY does not invalidate the row, and so the
  // (unloginable) hash is not needlessly churned.
  const serviceEmail = AUTOMATION_USER_EMAIL.toLowerCase();
  const [existingService] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, serviceEmail));
  if (!existingService) {
    await db.insert(usersTable).values({
      email: serviceEmail,
      passwordHash: generateServiceAccountHash(),
      firstName: AUTOMATION_DISPLAY_NAME,
      lastName: "Service",
      role: "service",
      isActive: true,
    });
    logger.info({ email: serviceEmail }, "Seeded automation service account");
  } else if (existingService.role !== "service") {
    // Heal a misconfigured row (shouldn't happen, but if a human ever
    // mis-seeded it as admin/approver/submitter we lock it back down).
    await db
      .update(usersTable)
      .set({ role: "service", isActive: true })
      .where(eq(usersTable.email, serviceEmail));
    logger.info(
      { email: serviceEmail },
      "Healed automation account role back to 'service'",
    );
  }
}
