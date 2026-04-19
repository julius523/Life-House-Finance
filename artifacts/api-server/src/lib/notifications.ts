import {
  db,
  notificationsTable,
  usersTable,
  emailSettingsTable,
  emailTemplatesTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

export type TemplateVariables = Record<string, string | number | null | undefined>;

export type CreateNotificationInput = {
  userId: number;
  type: string;
  title: string;
  body: string;
  link?: string | null;
  referenceType?: string | null;
  referenceId?: number | null;
  variables?: TemplateVariables;
};

export const DEFAULT_SENDER_NAME = "Life House Finance Portal";

export const DEFAULT_EMAIL_TEMPLATES: Record<
  string,
  { subject: string; body: string }
> = {
  bill_needs_correction: {
    subject: "Bill #{{itemId}} needs your attention",
    body: "Your bill for {{itemName}} (\${{amount}}) was sent back by {{actor}}. Reason: {{reason}}",
  },
  expense_needs_correction: {
    subject: "Expense #{{itemId}} needs your attention",
    body: "Your expense at {{itemName}} (\${{amount}}) was sent back by {{actor}}. Reason: {{reason}}",
  },
};

type DeliveryResult =
  | { status: "sent" }
  | { status: "failed"; error: string }
  | { status: "not_attempted"; reason: string };

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

export function renderTemplate(
  template: string,
  variables: TemplateVariables = {},
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const v = variables[key];
    if (v === undefined || v === null) return "";
    return String(v);
  });
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

export async function getSenderName(): Promise<string> {
  try {
    const [row] = await db.select().from(emailSettingsTable).limit(1);
    if (row?.senderName) return row.senderName;
  } catch (err) {
    logger.warn({ err }, "Failed to read sender name from email_settings");
  }
  return process.env["NOTIFICATION_FROM_NAME"] ?? DEFAULT_SENDER_NAME;
}

export async function getTemplate(
  type: string,
): Promise<{ subject: string; body: string } | null> {
  try {
    const [row] = await db
      .select()
      .from(emailTemplatesTable)
      .where(eq(emailTemplatesTable.type, type))
      .limit(1);
    if (row) return { subject: row.subject, body: row.body };
  } catch (err) {
    logger.warn({ err, type }, "Failed to read email template");
  }
  return DEFAULT_EMAIL_TEMPLATES[type] ?? null;
}

export type EmailAttachment = {
  filename: string;
  /** MIME type, e.g. "text/csv". */
  type: string;
  /** Base64-encoded file content (no data: URL prefix). */
  contentBase64: string;
};

export async function deliverEmail(opts: {
  to: string | string[];
  subject: string;
  body: string;
  link?: string | null;
  /**
   * Task #49 — Optional file attachments delivered alongside the message.
   * SendGrid caps a single request at 30 MB total payload; the caller is
   * responsible for not exceeding that.
   */
  attachments?: EmailAttachment[];
}): Promise<DeliveryResult> {
  const apiKey = process.env["SENDGRID_API_KEY"];
  const fromAddress = process.env["NOTIFICATION_FROM_EMAIL"];
  const fromName = await getSenderName();
  const recipients = (Array.isArray(opts.to) ? opts.to : [opts.to])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (recipients.length === 0) {
    return { status: "not_attempted", reason: "No recipients" };
  }
  if (!apiKey || !fromAddress) {
    logger.info(
      {
        to: recipients,
        subject: opts.subject,
        link: opts.link,
        fromName,
        attachmentCount: opts.attachments?.length ?? 0,
      },
      `[notification email] ${opts.subject} -> ${recipients.join(", ")}`,
    );
    return {
      status: "not_attempted",
      reason:
        "Email provider not configured (missing SENDGRID_API_KEY or NOTIFICATION_FROM_EMAIL).",
    };
  }

  const absoluteLink = opts.link ? resolveAbsoluteLink(opts.link) : null;
  const plainText = `${opts.body}${absoluteLink ? `\n\n${absoluteLink}` : ""}`;
  const htmlBody = renderHtmlEmail({
    ...opts,
    to: recipients[0]!,
  });

  const payload: Record<string, unknown> = {
    personalizations: [{ to: recipients.map((email) => ({ email })) }],
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
  };
  if (opts.attachments && opts.attachments.length > 0) {
    payload["attachments"] = opts.attachments.map((a) => ({
      filename: a.filename,
      type: a.type,
      content: a.contentBase64,
      disposition: "attachment",
    }));
  }

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const responseBody = await res.text().catch(() => "");
      logger.warn(
        {
          status: res.status,
          to: recipients,
          subject: opts.subject,
          response: responseBody.slice(0, 500),
        },
        "Failed to send notification email via SendGrid",
      );
      return {
        status: "failed",
        error: `SendGrid responded ${res.status}: ${
          responseBody.slice(0, 300) || "no body"
        }`,
      };
    }
    logger.info(
      {
        to: recipients,
        subject: opts.subject,
        attachmentCount: opts.attachments?.length ?? 0,
      },
      "Notification email sent via SendGrid",
    );
    return { status: "sent" };
  } catch (err) {
    logger.warn(
      { err, to: recipients, subject: opts.subject },
      "Error sending notification email",
    );
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function attemptDelivery(opts: {
  to: string | null;
  subject: string;
  body: string;
  link?: string | null;
}): Promise<DeliveryResult> {
  if (!opts.to) {
    return {
      status: "not_attempted",
      reason: "Recipient has no email address on file.",
    };
  }
  try {
    return await deliverEmail({
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      link: opts.link ?? null,
    });
  } catch (err) {
    logger.warn(
      { err, to: opts.to, subject: opts.subject },
      "Unexpected error while delivering notification email",
    );
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
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

  // Resolve template (DB > defaults > caller-provided fallback). Render with
  // variables so admins can customize wording without a code deploy.
  const template = await getTemplate(input.type);
  const variables: TemplateVariables = {
    ...(input.variables ?? {}),
    link: input.link ?? "",
  };
  const subject = template
    ? renderTemplate(template.subject, variables)
    : input.title;
  const body = template
    ? renderTemplate(template.body, variables)
    : input.body;

  const result = await attemptDelivery({
    to: emailTo,
    subject,
    body,
    link: input.link ?? null,
  });

  const attempted = result.status !== "not_attempted" || !!emailTo;
  const now = new Date();

  await db.insert(notificationsTable).values({
    userId: input.userId,
    type: input.type,
    title: subject,
    body,
    link: input.link ?? null,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    emailTo,
    emailSentAt: result.status === "sent" ? now : null,
    emailStatus: result.status,
    emailError:
      result.status === "failed"
        ? result.error
        : result.status === "not_attempted"
          ? result.reason
          : null,
    emailLastAttemptAt: attempted ? now : null,
    emailAttempts: attempted ? 1 : 0,
  });
}

export type ResendResult = {
  status: "sent" | "failed" | "not_attempted";
  error?: string;
};

export async function resendNotificationEmail(
  notificationId: number,
): Promise<ResendResult> {
  const [notification] = await db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.id, notificationId));
  if (!notification) {
    throw new Error("Notification not found");
  }

  // Refresh the recipient address from the user record in case it changed.
  const [user] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, notification.userId));
  const emailTo = user?.email ?? notification.emailTo ?? null;

  const result = await attemptDelivery({
    to: emailTo,
    subject: notification.title,
    body: notification.body,
    link: notification.link ?? null,
  });

  const now = new Date();
  const attempted = result.status !== "not_attempted" || !!emailTo;

  await db
    .update(notificationsTable)
    .set({
      emailTo,
      emailStatus: result.status,
      emailError:
        result.status === "failed"
          ? result.error
          : result.status === "not_attempted"
            ? result.reason
            : null,
      emailSentAt:
        result.status === "sent" ? now : notification.emailSentAt,
      emailLastAttemptAt: attempted ? now : notification.emailLastAttemptAt,
      emailAttempts: attempted
        ? (notification.emailAttempts ?? 0) + 1
        : notification.emailAttempts ?? 0,
    })
    .where(eq(notificationsTable.id, notificationId));

  if (result.status === "sent") return { status: "sent" };
  if (result.status === "failed") {
    return { status: "failed", error: result.error };
  }
  return { status: "not_attempted", error: result.reason };
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
