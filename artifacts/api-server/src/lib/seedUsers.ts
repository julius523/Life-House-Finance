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

/**
 * Synthetic development-only seed accounts.
 *
 * These accounts are NEVER seeded in production. Seeding is gated behind
 * the SEED_DEV_USERS=true environment variable. A startup guard (below)
 * halts the process if SEED_DEV_USERS=true is detected in a non-development
 * NODE_ENV to prevent accidental use in staging or production.
 *
 * Credentials are intentionally synthetic (dev-only.example addresses,
 * obviously-fake passwords) so they cannot be mistaken for real accounts
 * or reused in operational systems.
 */
const DEV_SEED_USERS: SeedUser[] = [
  {
    email: "dev-admin1@dev-only.example",
    firstName: "DevAdmin",
    lastName: "One",
    role: "admin",
    password: "Dev-Seed-Admin1!",
  },
  {
    email: "dev-admin2@dev-only.example",
    firstName: "DevAdmin",
    lastName: "Two",
    role: "admin",
    password: "Dev-Seed-Admin2!",
  },
  {
    email: "dev-approver@dev-only.example",
    firstName: "DevApprover",
    lastName: "One",
    role: "approver",
    password: "Dev-Seed-Approver1!",
  },
  {
    email: "dev-submitter@dev-only.example",
    firstName: "DevSubmitter",
    lastName: "One",
    role: "submitter",
    password: "Dev-Seed-Submitter1!",
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

/**
 * Guards against accidentally enabling SEED_DEV_USERS in a non-development
 * environment. If the flag is set outside of NODE_ENV=development, the
 * process is terminated immediately so the misconfiguration is caught
 * at deploy time rather than silently seeding known credentials.
 */
function assertDevSeedSafe(): void {
  const flagSet =
    process.env["SEED_DEV_USERS"]?.trim().toLowerCase() === "true";
  const nodeEnv = (process.env["NODE_ENV"] ?? "").trim().toLowerCase();
  if (flagSet && nodeEnv !== "development") {
    logger.fatal(
      { NODE_ENV: nodeEnv },
      "SEED_DEV_USERS=true is not allowed outside NODE_ENV=development. " +
        "Halting to prevent seeding known credentials into a non-development environment.",
    );
    process.exit(1);
  }
}

export async function seedUsers(): Promise<void> {
  // Safety guard: crash fast if SEED_DEV_USERS is enabled in the wrong env.
  assertDevSeedSafe();

  // Pass 1: human seed users.
  //
  // This block only runs when SEED_DEV_USERS=true is explicitly set AND
  // NODE_ENV=development. It must NEVER be enabled in production or staging.
  //
  // When the flag is absent (the default, including all production
  // deployments), this block is skipped entirely. User accounts must be
  // created through the admin UI or a secure provisioning process.
  //
  // When enabled: accounts are inserted only if missing (first boot only).
  // Existing account passwords are NEVER overwritten, so credentials
  // rotated by an operator survive subsequent restarts.
  const devSeedEnabled =
    process.env["SEED_DEV_USERS"]?.trim().toLowerCase() === "true";

  if (devSeedEnabled) {
    logger.warn(
      "SEED_DEV_USERS=true — inserting synthetic development seed accounts. " +
        "This must not be enabled in production.",
    );
    for (const u of DEV_SEED_USERS) {
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
        logger.info({ email }, "Dev seed: inserted user (first boot only)");
      }
    }
  } else {
    logger.info(
      "SEED_DEV_USERS not set — skipping hardcoded credential seeding (production-safe default).",
    );
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
