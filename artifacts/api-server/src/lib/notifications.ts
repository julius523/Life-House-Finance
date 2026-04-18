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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveAbsoluteLink(link: string): string {
  if (/^https?:\/\//i.test(link)) return link;
  const domains = process.env["REPLIT_DOMAINS"];
  const primary = domains?.split(",")[0]?.trim();
  const base = primary
    ? `https://${primary}`
    : process.env["REPLIT_DEV_DOMAIN"]
      ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
      : "";
  if (!base) return link;
  return `${base}${link.startsWith("/") ? "" : "/"}${link}`;
}

function renderHtmlEmail(opts: {
  subject: string;
  body: string;
  link?: string | null;
}): string {
  const safeSubject = escapeHtml(opts.subject);
  const safeBodyParagraphs = opts.body
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;color:#1f2937;font-size:15px;line-height:1.55;">${escapeHtml(
          p,
        ).replace(/\n/g, "<br />")}</p>`,
    )
    .join("");
  const absoluteLink = opts.link ? resolveAbsoluteLink(opts.link) : null;
  const button = absoluteLink
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
        <tr>
          <td bgcolor="#4175f4" style="border-radius:6px;">
            <a href="${escapeHtml(absoluteLink)}"
               style="display:inline-block;padding:12px 22px;font-family:Montserrat,Arial,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">
              View item
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 8px 0;color:#6b7280;font-size:12px;line-height:1.5;">
        If the button does not work, copy and paste this link into your browser:<br />
        <a href="${escapeHtml(absoluteLink)}" style="color:#4175f4;word-break:break-all;">${escapeHtml(absoluteLink)}</a>
      </p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeSubject}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Montserrat,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
            <tr>
              <td style="background-color:#1800ad;padding:20px 28px;">
                <div style="color:#ffffff;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">Life House Reentry</div>
                <div style="color:#ffffff;font-size:18px;font-weight:600;margin-top:4px;">Finance Portal</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 16px 0;font-size:20px;line-height:1.3;color:#111827;">${safeSubject}</h1>
                ${safeBodyParagraphs}
                ${button}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 24px 28px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.5;">
                You're receiving this email because you have an account on the Life House Finance Portal.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function deliverEmail(opts: {
  to: string;
  subject: string;
  body: string;
  link?: string | null;
}): Promise<boolean> {
  // Real outbound email requires an SMTP/transactional provider. When one is
  // configured (SENDGRID_API_KEY + NOTIFICATION_FROM_EMAIL), we send through
  // it; otherwise we log the message so it shows up in dev and is auditable in
  // prod logs. Failures are logged but never thrown — email is best-effort.
  const apiKey = process.env["SENDGRID_API_KEY"];
  const fromAddress = process.env["NOTIFICATION_FROM_EMAIL"];
  const fromName = process.env["NOTIFICATION_FROM_NAME"] ?? "Life House Finance Portal";
  if (!apiKey || !fromAddress) {
    logger.info(
      { to: opts.to, subject: opts.subject, link: opts.link },
      `[notification email] ${opts.subject} -> ${opts.to}`,
    );
    return false;
  }

  const absoluteLink = opts.link ? resolveAbsoluteLink(opts.link) : null;
  const plainText = `${opts.body}${absoluteLink ? `\n\n${absoluteLink}` : ""}`;
  const htmlBody = renderHtmlEmail(opts);

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: opts.to }] }],
        from: { email: fromAddress, name: fromName },
        subject: opts.subject,
        content: [
          { type: "text/plain", value: plainText },
          { type: "text/html", value: htmlBody },
        ],
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false },
        },
      }),
    });
    if (!res.ok) {
      const responseBody = await res.text().catch(() => "");
      logger.warn(
        {
          status: res.status,
          to: opts.to,
          subject: opts.subject,
          response: responseBody.slice(0, 500),
        },
        "Failed to send notification email via SendGrid",
      );
      return false;
    }
    logger.info(
      { to: opts.to, subject: opts.subject },
      "Notification email sent via SendGrid",
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, to: opts.to, subject: opts.subject },
      "Error sending notification email",
    );
    return false;
  }
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
    try {
      emailSent = await deliverEmail({
        to: emailTo,
        subject: input.title,
        body: input.body,
        link: input.link ?? null,
      });
    } catch (err) {
      // Defense in depth: deliverEmail already swallows its own errors, but
      // ensure email failures never break the calling API request.
      logger.warn(
        { err, to: emailTo, subject: input.title },
        "Unexpected error while delivering notification email",
      );
      emailSent = false;
    }
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
