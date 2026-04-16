import { useEffect, useState } from "react";
import {
  listUsers,
  createUser,
  changeUserPassword,
  type AuthUser,
  type UserRole,
} from "@/lib/auth";
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
import { Shield, UserPlus, KeyRound, AlertTriangle, History } from "lucide-react";

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
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{
    date: string;
    exists: boolean;
    createdAt: string | null;
  } | null>(null);

  useEffect(() => {
    fetch("/api/admin/daily-snapshot", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setInfo(j))
      .catch(() => setInfo(null));
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/restore-day", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterPassword }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Restore failed (${res.status})`);
      }
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
    } finally {
      setBusy(false);
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
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (confirmText !== "DELETE EVERYTHING") {
      toast({
        title: "Type DELETE EVERYTHING to confirm",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/admin/wipe-data", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterPassword }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Wipe failed (${res.status})`);
      }
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
    } finally {
      setBusy(false);
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
