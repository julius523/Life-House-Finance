import { db, notificationsTable, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

export type CreateNotificationInput = {
  userId: number;
  type: string;
  title: string;
  body: string;
  link?: string | null;
  referenceType?: string | null;
  referenceId?: number | null;
};

async function deliverEmail(opts: {
  to: string;
  subject: string;
  body: string;
  link?: string | null;
}): Promise<boolean> {
  // Real outbound email requires an SMTP/transactional provider. When one is
  // configured (e.g. SENDGRID_API_KEY), we send through it; otherwise we log
  // the message so it shows up in dev and is auditable in prod logs.
  const apiKey = process.env["SENDGRID_API_KEY"];
  const fromAddress = process.env["NOTIFICATION_FROM_EMAIL"];
  if (apiKey && fromAddress) {
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: opts.to }] }],
          from: { email: fromAddress },
          subject: opts.subject,
          content: [
            {
              type: "text/plain",
              value: `${opts.body}${opts.link ? `\n\n${opts.link}` : ""}`,
            },
          ],
        }),
      });
      if (!res.ok) {
        logger.warn(
          { status: res.status, to: opts.to },
          "Failed to send notification email via SendGrid",
        );
        return false;
      }
      return true;
    } catch (err) {
      logger.warn({ err, to: opts.to }, "Error sending notification email");
      return false;
    }
  }
  logger.info(
    { to: opts.to, subject: opts.subject, link: opts.link },
    `[notification email] ${opts.subject} -> ${opts.to}`,
  );
  return false;
}

export async function createNotification(
  input: CreateNotificationInput,
): Promise<void> {
  const [user] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, input.userId));
  const emailTo = user?.email ?? null;

  let emailSent = false;
  if (emailTo) {
    emailSent = await deliverEmail({
      to: emailTo,
      subject: input.title,
      body: input.body,
      link: input.link ?? null,
    });
  }

  await db.insert(notificationsTable).values({
    userId: input.userId,
    type: input.type,
    title: input.title,
    body: input.body,
    link: input.link ?? null,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    emailTo,
    emailSentAt: emailSent ? new Date() : null,
  });
}

export async function findUserByEmail(
  email: string,
): Promise<{ id: number } | null> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return null;
  const [match] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${trimmed}`)
    .limit(1);
  return match ? { id: match.id } : null;
}
