import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

type SeedUser = {
  email: string;
  firstName: string;
  lastName: string;
  role: "admin" | "approver" | "submitter";
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

export async function seedUsers(): Promise<void> {
  for (const u of SEED_USERS) {
    const email = u.email.toLowerCase();
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
    if (existing) continue;
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
  }
}
