import { useEffect, useState } from "react";
import {
  listUsers,
  createUser,
  changeUserPassword,
  type AuthUser,
  type UserRole,
} from "@/lib/auth";
import {
  useGetDailySnapshotInfo,
  useRestoreToday,
  useWipeAllData,
  useGetEmailSettings,
  useUpdateEmailSettings,
  useSendEmailSettingsTest,
  useListAdminNotifications,
  useResendAdminNotification,
  getListAdminNotificationsQueryKey,
  getGetEmailSettingsQueryKey,
  type EmailTemplate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Shield,
  UserPlus,
  KeyRound,
  AlertTriangle,
  History,
  Mail,
  MailCheck,
  MailX,
  MailWarning,
  RefreshCw,
  Send,
  RotateCcw,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { formatDistanceToNow } from "date-fns";

const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Admin",
  approver: "Approver",
  submitter: "Submitter",
};

export default function AdminPage() {
  const { toast } = useToast();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [passwordFor, setPasswordFor] = useState<AuthUser | null>(null);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const refresh = async () => {
    try {
      setLoading(true);
      const list = await listUsers();
      setUsers(list);
    } catch (e) {
      toast({
        title: "Could not load users",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Shield className="h-7 w-7 text-primary" />
            Admin — User Management
          </h1>
          <p className="text-muted-foreground mt-1">
            Add staff accounts and change passwords.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <UserPlus className="mr-2 h-4 w-4" />
          Add user
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Admins can manage every account; approvers can approve;
            submitters only submit expenses and bills.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-muted-foreground">Loading…</div>
          ) : (
            <div className="divide-y">
              {users.map((u) => (
                <div
                  key={u.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 hover:bg-muted/30"
                >
                  <div>
                    <div className="font-semibold">
                      {u.firstName} {u.lastName}
                    </div>
                    <div className="text-sm text-muted-foreground">{u.email}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="secondary">{ROLE_LABEL[u.role]}</Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPasswordFor(u)}
                    >
                      <KeyRound className="mr-2 h-3 w-3" />
                      Change password
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {addOpen && (
        <AddUserDialog
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false);
            refresh();
          }}
        />
      )}
      {passwordFor && (
        <ChangePasswordDialog
          user={passwordFor}
          onClose={() => setPasswordFor(null)}
          onSaved={() => setPasswordFor(null)}
        />
      )}

      <EmailSettingsCard />

      <EmailDeliveryCard />

      <Card className="border-amber-500/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-amber-600">
            <History className="h-5 w-5" />
            Restore to start of day
          </CardTitle>
          <CardDescription>
            Revert every expense, bill, vendor, program, receipt, transaction,
            credit, contact, month-end checklist, and activity log entry back
            to the state they were in at the beginning of today. User accounts
            are preserved. Requires the master password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="border-amber-500/60 text-amber-700 hover:bg-amber-50"
            onClick={() => setRestoreOpen(true)}
          >
            <History className="mr-2 h-4 w-4" />
            Restore to start of day
          </Button>
        </CardContent>
      </Card>

      {restoreOpen && (
        <RestoreDayDialog
          onClose={() => setRestoreOpen(false)}
          onRestored={() => setRestoreOpen(false)}
        />
      )}

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Danger zone
          </CardTitle>
          <CardDescription>
            Permanently delete every transaction, expense, bill, vendor,
            program, receipt, and activity log entry. User accounts are
            preserved so the team can still sign in. Requires the master
            password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => setWipeOpen(true)}>
            <AlertTriangle className="mr-2 h-4 w-4" />
            Clear all data
          </Button>
        </CardContent>
      </Card>

      {wipeOpen && (
        <WipeDataDialog
          onClose={() => setWipeOpen(false)}
          onWiped={() => setWipeOpen(false)}
        />
      )}
    </div>
  );
}

function RestoreDayDialog({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  onRestored: () => void;
}) {
  const { toast } = useToast();
  const [masterPassword, setMasterPassword] = useState("");
  const { data: info } = useGetDailySnapshotInfo();
  const restoreMut = useRestoreToday();
  const busy = restoreMut.isPending;

  const submit = async () => {
    try {
      await restoreMut.mutateAsync({ data: { masterPassword } });
      toast({
        title: "Restored to start of day",
        description: "All data has been reverted to this morning's snapshot.",
      });
      onRestored();
      // Refresh so cached queries reload.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      toast({
        title: "Could not restore",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-700">
            <History className="h-5 w-5" />
            Restore to start of day
          </DialogTitle>
          <DialogDescription>
            This reverts every expense, bill, vendor, program, receipt,
            transaction, credit, contact, month-end checklist, and activity log
            entry back to the snapshot captured at the beginning of today. Any
            changes made since this morning will be lost. User accounts stay
            intact.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {info && (
            <div className="text-sm bg-muted/50 rounded-md p-3">
              {info.exists && info.createdAt ? (
                <>
                  Snapshot for{" "}
                  <span className="font-semibold">{info.date}</span> was
                  captured at{" "}
                  <span className="font-semibold">
                    {new Date(info.createdAt).toLocaleString()}
                  </span>
                  .
                </>
              ) : (
                <>No snapshot exists yet for today.</>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Master password</Label>
            <Input
              type="password"
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || !masterPassword || !info?.exists}
            className="bg-amber-600 text-white hover:bg-amber-700"
          >
            {busy ? "Restoring…" : "Restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WipeDataDialog({
  onClose,
  onWiped,
}: {
  onClose: () => void;
  onWiped: () => void;
}) {
  const { toast } = useToast();
  const [masterPassword, setMasterPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const wipeMut = useWipeAllData();
  const busy = wipeMut.isPending;

  const submit = async () => {
    if (confirmText !== "DELETE EVERYTHING") {
      toast({
        title: "Type DELETE EVERYTHING to confirm",
        variant: "destructive",
      });
      return;
    }
    try {
      await wipeMut.mutateAsync({ data: { masterPassword } });
      toast({
        title: "All data cleared",
        description: "Transactions, expenses, bills, and related records were deleted.",
      });
      onWiped();
    } catch (e) {
      toast({
        title: "Could not clear data",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Clear all data
          </DialogTitle>
          <DialogDescription>
            This permanently deletes every transaction, expense, bill,
            vendor, program, receipt, and activity log entry. User
            accounts are kept. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Master password</Label>
            <Input
              type="password"
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label>
              Type{" "}
              <span className="font-mono font-semibold">DELETE EVERYTHING</span>{" "}
              to confirm
            </Label>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE EVERYTHING"
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={busy || !masterPassword || confirmText !== "DELETE EVERYTHING"}
          >
            {busy ? "Clearing…" : "Clear all data"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState<UserRole>("submitter");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email || !firstName || !lastName || !password) {
      toast({ title: "Please complete every field", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await createUser({ email, firstName, lastName, role, password });
      toast({ title: "User created" });
      onCreated();
    } catch (e) {
      toast({
        title: "Could not create user",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            Set an initial password — the user can change it later.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>First name</Label>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Last name</Label>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@lifehousereentry.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="submitter">Submitter</SelectItem>
                <SelectItem value="approver">Approver</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangePasswordDialog({
  user,
  onClose,
  onSaved,
}: {
  user: AuthUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password.length < 6) {
      toast({
        title: "Password must be at least 6 characters",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      await changeUserPassword(user.id, password);
      toast({ title: `Password updated for ${user.email}` });
      onSaved();
    } catch (e) {
      toast({
        title: "Could not change password",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            Set a new password for {user.firstName} {user.lastName} ({user.email}).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>New password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


type TemplateForm = {
  type: string;
  subject: string;
  body: string;
  defaultSubject: string;
  defaultBody: string;
  variables: string[];
  sampleVariables: Record<string, string>;
};

const TEMPLATE_LABELS: Record<string, string> = {
  bill_needs_correction: "Bill sent back for correction",
  expense_needs_correction: "Expense sent back for correction",
};

// Mirrors renderTemplate in artifacts/api-server/src/lib/notifications.ts so
// admins see the same substitution behavior as a real send.
function renderTemplatePreview(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const v = variables[key];
    if (v === undefined || v === null) return "";
    return String(v);
  });
}

function escapeHtmlPreview(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolvePreviewLink(link: string): string {
  if (/^https?:\/\//i.test(link)) return link;
  if (typeof window === "undefined") return link;
  return `${window.location.origin}${link.startsWith("/") ? "" : "/"}${link}`;
}

// Mirrors renderHtmlEmail in artifacts/api-server/src/lib/notifications.ts so
// admins see the same branded wrapper, CTA button, and footer that recipients
// will receive. Kept in sync manually; update both places together.
function renderEmailHtmlPreview(opts: {
  subject: string;
  body: string;
  link?: string | null;
}): string {
  const safeSubject = escapeHtmlPreview(opts.subject || "(empty)");
  const safeBodyParagraphs = (opts.body || "")
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;color:#1f2937;font-size:15px;line-height:1.55;">${escapeHtmlPreview(
          p,
        ).replace(/\n/g, "<br />")}</p>`,
    )
    .join("");
  const absoluteLink = opts.link ? resolvePreviewLink(opts.link) : null;
  const button = absoluteLink
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
        <tr>
          <td bgcolor="#4175f4" style="border-radius:6px;">
            <a href="${escapeHtmlPreview(absoluteLink)}"
               style="display:inline-block;padding:12px 22px;font-family:Montserrat,Arial,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">
              View item
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 8px 0;color:#6b7280;font-size:12px;line-height:1.5;">
        If the button does not work, copy and paste this link into your browser:<br />
        <a href="${escapeHtmlPreview(absoluteLink)}" style="color:#4175f4;word-break:break-all;">${escapeHtmlPreview(absoluteLink)}</a>
      </p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeSubject}</title>
    <base target="_blank" />
  </head>
  <body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Montserrat,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;padding:16px 0;">
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

function EmailHtmlPreview({
  subject,
  body,
  link,
}: {
  subject: string;
  body: string;
  link?: string | null;
}) {
  const html = renderEmailHtmlPreview({ subject, body, link: link ?? null });
  return (
    <iframe
      title="Email preview"
      sandbox="allow-popups"
      srcDoc={html}
      className="w-full h-[520px] rounded-md border bg-muted/30"
    />
  );
}

function EmailSettingsCard() {
  const { toast } = useToast();
  const [testingType, setTestingType] = useState<string | null>(null);
  const [senderName, setSenderName] = useState("");
  const [defaultSenderName, setDefaultSenderName] = useState("");
  const [templates, setTemplates] = useState<TemplateForm[]>([]);

  const queryClient = useQueryClient();
  const { data: settings, isLoading: loading, error: loadError } =
    useGetEmailSettings();
  const saveMut = useUpdateEmailSettings();
  const testMut = useSendEmailSettingsTest();
  const saving = saveMut.isPending;

  useEffect(() => {
    if (loadError) {
      toast({
        title: "Could not load email settings",
        description: loadError instanceof Error ? loadError.message : undefined,
        variant: "destructive",
      });
    }
  }, [loadError, toast]);

  useEffect(() => {
    if (settings) {
      setSenderName(settings.senderName);
      setDefaultSenderName(settings.defaultSenderName);
      setTemplates(settings.templates as TemplateForm[]);
    }
  }, [settings]);

  const updateTemplate = (type: string, patch: Partial<TemplateForm>) => {
    setTemplates((prev) =>
      prev.map((t) => (t.type === type ? { ...t, ...patch } : t)),
    );
  };

  const save = async () => {
    try {
      await saveMut.mutateAsync({
        data: {
          senderName: senderName.trim(),
          templates: templates.map((t) => ({
            type: t.type as EmailTemplate["type"],
            subject: t.subject,
            body: t.body,
          })),
        },
      });
      // Refetch so the form re-syncs with whatever the server normalized
      // (trimmed sender name, defaulted blanks, template ordering, etc.).
      await queryClient.invalidateQueries({
        queryKey: getGetEmailSettingsQueryKey(),
      });
      toast({ title: "Email settings saved" });
    } catch (e) {
      toast({
        title: "Could not save",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const sendTest = async (t: TemplateForm) => {
    setTestingType(t.type);
    try {
      const data = await testMut.mutateAsync({
        data: {
          type: t.type as EmailTemplate["type"],
          subject: t.subject,
          body: t.body,
        },
      });
      toast({
        title: data.delivered
          ? `Test sent to ${data.to}`
          : "Test email logged (no SMTP configured)",
        description: data.note ?? undefined,
      });
    } catch (e) {
      toast({
        title: "Could not send test",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setTestingType(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-primary" />
          Email templates &amp; sender
        </CardTitle>
        <CardDescription>
          Customize the wording of notification emails and the sender name
          shown to recipients. Use{" "}
          <span className="font-mono text-xs">{`{{placeholder}}`}</span>{" "}
          tokens to insert values like the item name or link.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <div className="text-muted-foreground">Loading…</div>
        ) : (
          <>
            <div className="space-y-1.5 max-w-md">
              <Label>Sender name</Label>
              <Input
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                placeholder={defaultSenderName}
              />
              <p className="text-xs text-muted-foreground">
                Shown in the "From" line of outgoing emails (the email
                address itself is set via{" "}
                <span className="font-mono">NOTIFICATION_FROM_EMAIL</span>).
              </p>
            </div>

            <div className="space-y-5">
              {templates.map((t) => (
                <div
                  key={t.type}
                  className="rounded-md border p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="font-semibold">
                        {TEMPLATE_LABELS[t.type] ?? t.type}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Available placeholders:{" "}
                        {t.variables.map((v, i) => (
                          <span key={v}>
                            <span className="font-mono">{`{{${v}}}`}</span>
                            {i < t.variables.length - 1 ? ", " : ""}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          updateTemplate(t.type, {
                            subject: t.defaultSubject,
                            body: t.defaultBody,
                          })
                        }
                      >
                        <RotateCcw className="mr-2 h-3 w-3" />
                        Reset
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={testingType === t.type}
                        onClick={() => sendTest(t)}
                      >
                        <Send className="mr-2 h-3 w-3" />
                        {testingType === t.type
                          ? "Sending…"
                          : "Send test to me"}
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <Label>Subject</Label>
                        <Input
                          value={t.subject}
                          onChange={(e) =>
                            updateTemplate(t.type, { subject: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Body</Label>
                        <Textarea
                          value={t.body}
                          onChange={(e) =>
                            updateTemplate(t.type, { body: e.target.value })
                          }
                          rows={8}
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="flex items-center justify-between gap-2">
                        <span>Preview</span>
                        <span className="text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                          Sample — not sent
                        </span>
                      </Label>
                      <div className="rounded-md border bg-background/60 px-3 py-2 text-xs">
                        <div className="text-muted-foreground">Subject</div>
                        <div className="font-semibold break-words">
                          {renderTemplatePreview(
                            t.subject,
                            t.sampleVariables,
                          ) || (
                            <span className="text-muted-foreground italic font-normal">
                              (empty)
                            </span>
                          )}
                        </div>
                      </div>
                      <EmailHtmlPreview
                        subject={renderTemplatePreview(
                          t.subject,
                          t.sampleVariables,
                        )}
                        body={renderTemplatePreview(
                          t.body,
                          t.sampleVariables,
                        )}
                        link={t.sampleVariables["link"] ?? null}
                      />
                      <p className="text-xs text-muted-foreground">
                        Full HTML email a recipient sees, filled in with the
                        same sample values used by{" "}
                        <span className="font-medium">Send test to me</span>.
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end">
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save email settings"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type AdminNotification = {
  id: number;
  userId: number;
  type: string;
  title: string;
  body: string;
  link?: string;
  emailTo?: string;
  emailStatus: "sent" | "failed" | "not_attempted";
  emailError?: string;
  emailSentAt?: string;
  emailLastAttemptAt?: string;
  emailAttempts: number;
  createdAt: string;
  recipientName?: string;
  recipientEmail?: string;
};

function EmailDeliveryCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"all" | "failed" | "not_attempted" | "sent">(
    "all",
  );
  const [resendingId, setResendingId] = useState<number | null>(null);

  const {
    data: notificationsData,
    isFetching: loading,
    error: loadError,
    refetch,
  } = useListAdminNotifications();
  const resendMut = useResendAdminNotification();

  useEffect(() => {
    if (loadError) {
      toast({
        title: "Could not load notification history",
        description: loadError instanceof Error ? loadError.message : undefined,
        variant: "destructive",
      });
    }
  }, [loadError, toast]);

  const items = (notificationsData?.items ?? []) as AdminNotification[];

  const refresh = () => {
    void refetch();
  };

  const resend = async (id: number) => {
    setResendingId(id);
    try {
      const body = await resendMut.mutateAsync({ id });
      if (body.ok) {
        toast({ title: "Email resent successfully" });
      } else {
        toast({
          title: "Resend failed",
          description: body.error ?? "Request failed",
          variant: "destructive",
        });
      }
      await queryClient.invalidateQueries({
        queryKey: getListAdminNotificationsQueryKey(),
      });
    } catch (e) {
      toast({
        title: "Resend failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setResendingId(null);
    }
  };

  const counts = {
    sent: items.filter((i) => i.emailStatus === "sent").length,
    failed: items.filter((i) => i.emailStatus === "failed").length,
    not_attempted: items.filter((i) => i.emailStatus === "not_attempted").length,
  };

  const filtered =
    filter === "all" ? items : items.filter((i) => i.emailStatus === filter);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              Email delivery
            </CardTitle>
            <CardDescription>
              The most recent 200 notifications and whether their emails
              reached the recipient. Use Resend to retry failed deliveries.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw
              className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <FilterChip
            label={`All (${items.length})`}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          <FilterChip
            label={`Sent (${counts.sent})`}
            active={filter === "sent"}
            onClick={() => setFilter("sent")}
          />
          <FilterChip
            label={`Failed (${counts.failed})`}
            active={filter === "failed"}
            onClick={() => setFilter("failed")}
          />
          <FilterChip
            label={`Not attempted (${counts.not_attempted})`}
            active={filter === "not_attempted"}
            onClick={() => setFilter("not_attempted")}
          />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-6 text-muted-foreground">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-muted-foreground text-center text-sm">
            No notifications match this filter.
          </div>
        ) : (
          <div className="divide-y">
            {filtered.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                onResend={() => resend(n.id)}
                resending={resendingId === n.id}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-3 py-1 rounded-full border transition-colors ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background text-foreground border-border hover:bg-muted"
      }`}
      data-testid={`filter-${label.split(" ")[0]?.toLowerCase()}`}
    >
      {label}
    </button>
  );
}

function NotificationRow({
  n,
  onResend,
  resending,
}: {
  n: AdminNotification;
  onResend: () => void;
  resending: boolean;
}) {
  const statusBadge = (() => {
    if (n.emailStatus === "sent") {
      return (
        <Badge className="bg-green-100 text-green-800 hover:bg-green-100 border-green-200">
          <MailCheck className="h-3 w-3 mr-1" />
          Sent
        </Badge>
      );
    }
    if (n.emailStatus === "failed") {
      return (
        <Badge variant="destructive">
          <MailX className="h-3 w-3 mr-1" />
          Failed
        </Badge>
      );
    }
    return (
      <Badge variant="secondary">
        <MailWarning className="h-3 w-3 mr-1" />
        Not attempted
      </Badge>
    );
  })();

  const lastAttempt = n.emailLastAttemptAt ?? n.emailSentAt;

  return (
    <div
      className="p-4 hover:bg-muted/30"
      data-testid={`notification-row-${n.id}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {statusBadge}
            <span className="text-sm font-semibold truncate">{n.title}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            To{" "}
            <span className="font-medium text-foreground">
              {n.recipientName ?? "Unknown user"}
            </span>{" "}
            &lt;{n.emailTo ?? n.recipientEmail ?? "no email on file"}&gt;
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Created{" "}
            {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
            {lastAttempt && (
              <>
                {" · Last attempt "}
                {formatDistanceToNow(new Date(lastAttempt), {
                  addSuffix: true,
                })}
              </>
            )}
            {n.emailAttempts > 0 && (
              <>
                {" · "}
                {n.emailAttempts} attempt{n.emailAttempts === 1 ? "" : "s"}
              </>
            )}
          </div>
          {n.emailError && (
            <div className="mt-2 text-xs bg-destructive/10 text-destructive rounded px-2 py-1 font-mono break-words">
              {n.emailError}
            </div>
          )}
        </div>
        <div className="shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={onResend}
            disabled={resending}
            data-testid={`button-resend-${n.id}`}
          >
            <RefreshCw
              className={`mr-2 h-3 w-3 ${resending ? "animate-spin" : ""}`}
            />
            {resending ? "Resending…" : "Resend"}
          </Button>
        </div>
      </div>
    </div>
  );
}
