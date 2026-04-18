import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { Plus, Pencil, Archive, ArchiveRestore, Eye } from "lucide-react";
import { Link } from "wouter";

type Account = {
  id: number;
  code: string;
  name: string;
  description: string | null;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  subtype: string | null;
  normalBalance: "debit" | "credit";
  parentAccountId: number | null;
  isActive: boolean;
  isSystem: boolean;
  allowManualPosting: boolean;
};

const TYPES: Account["type"][] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];
const NORMALS: Account["normalBalance"][] = ["debit", "credit"];

const DEFAULT_FORM = {
  code: "",
  name: "",
  description: "",
  type: "expense" as Account["type"],
  subtype: "",
  normalBalance: "debit" as Account["normalBalance"],
  isActive: true,
  allowManualPosting: true,
};

export default function AccountingCoaPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | Account["type"]>("all");

  const [editing, setEditing] = useState<Account | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (includeArchived) params.set("includeArchived", "true");
      const res = await apiJson<{ accounts: Account[] }>(
        `/accounting/chart-of-accounts?${params}`,
      );
      setAccounts(res.accounts);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to load",
        description: String((err as Error)?.message ?? err),
      });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts
      .filter((a) => (typeFilter === "all" ? true : a.type === typeFilter))
      .filter(
        (a) =>
          !q ||
          a.code.toLowerCase().includes(q) ||
          a.name.toLowerCase().includes(q) ||
          (a.subtype ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [accounts, search, typeFilter]);

  function openCreate() {
    setForm(DEFAULT_FORM);
    setEditing(null);
    setCreating(true);
  }
  function openEdit(a: Account) {
    setForm({
      code: a.code,
      name: a.name,
      description: a.description ?? "",
      type: a.type,
      subtype: a.subtype ?? "",
      normalBalance: a.normalBalance,
      isActive: a.isActive,
      allowManualPosting: a.allowManualPosting,
    });
    setEditing(a);
    setCreating(false);
  }
  function closeDialog() {
    setEditing(null);
    setCreating(false);
  }

  async function save() {
    setSaving(true);
    try {
      const body = {
        code: form.code.trim(),
        name: form.name.trim(),
        description: form.description.trim() || null,
        type: form.type,
        subtype: form.subtype.trim() || null,
        normalBalance: form.normalBalance,
        isActive: form.isActive,
        allowManualPosting: form.allowManualPosting,
      };
      if (editing) {
        await apiJson(`/accounting/chart-of-accounts/${editing.id}`, {
          method: "PATCH",
          body,
        });
        toast({ title: "Account updated" });
      } else {
        await apiJson("/accounting/chart-of-accounts", {
          method: "POST",
          body,
        });
        toast({ title: "Account created" });
      }
      closeDialog();
      await load();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Save failed",
        description: String((err as Error)?.message ?? err),
      });
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchive(a: Account) {
    try {
      await apiJson(`/accounting/chart-of-accounts/${a.id}`, {
        method: "PATCH",
        body: { isActive: !a.isActive },
      });
      toast({
        title: a.isActive ? "Account archived" : "Account restored",
      });
      await load();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: String((err as Error)?.message ?? err),
      });
    }
  }

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Chart of Accounts</h1>
          <p className="text-muted-foreground">
            GAAP account structure used by the General Ledger and AI copilot.
          </p>
        </div>
        {isAdmin && (
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" />
            New account
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            System accounts (locked code/type) come from the seeded GAAP
            defaults. Custom accounts can be added by admins.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3 items-center">
            <Input
              placeholder="Search code, name, subtype…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs"
            />
            <Select
              value={typeFilter}
              onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={includeArchived}
                onCheckedChange={(v) => setIncludeArchived(!!v)}
              />
              Include archived
            </label>
            <div className="ml-auto text-sm text-muted-foreground">
              {filtered.length} of {accounts.length}
            </div>
          </div>

          <div className="border rounded-md overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2">Code</th>
                  <th className="text-left p-2">Name</th>
                  <th className="text-left p-2">Type</th>
                  <th className="text-left p-2">Subtype</th>
                  <th className="text-left p-2">Normal</th>
                  <th className="text-left p-2">Flags</th>
                  <th className="text-right p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={7} className="p-4 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-4 text-center text-muted-foreground">
                      No accounts match.
                    </td>
                  </tr>
                ) : (
                  filtered.map((a) => (
                    <tr key={a.id} className="border-t hover:bg-muted/30">
                      <td className="p-2 font-mono">{a.code}</td>
                      <td className="p-2">
                        <div className="font-medium">{a.name}</div>
                        {a.description && (
                          <div className="text-xs text-muted-foreground">
                            {a.description}
                          </div>
                        )}
                      </td>
                      <td className="p-2">{a.type}</td>
                      <td className="p-2">{a.subtype ?? "—"}</td>
                      <td className="p-2">{a.normalBalance}</td>
                      <td className="p-2 space-x-1">
                        {a.isSystem && (
                          <Badge variant="secondary">system</Badge>
                        )}
                        {!a.isActive && (
                          <Badge variant="outline">archived</Badge>
                        )}
                        {!a.allowManualPosting && (
                          <Badge variant="outline">no-manual</Badge>
                        )}
                      </td>
                      <td className="p-2 text-right space-x-1">
                        <Link href={`/accounting/coa/${a.id}`}>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="View account detail"
                            data-testid={`coa-view-${a.id}`}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </Link>
                        {isAdmin && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openEdit(a)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => toggleArchive(a)}
                              title={a.isActive ? "Archive" : "Restore"}
                            >
                              {a.isActive ? (
                                <Archive className="h-4 w-4" />
                              ) : (
                                <ArchiveRestore className="h-4 w-4" />
                              )}
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={creating || !!editing} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${editing.code}` : "New account"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium">Code</label>
                <Input
                  value={form.code}
                  onChange={(e) =>
                    setForm({ ...form, code: e.target.value })
                  }
                  disabled={!!editing?.isSystem}
                />
              </div>
              <div>
                <label className="text-xs font-medium">Type</label>
                <Select
                  value={form.type}
                  onValueChange={(v) =>
                    setForm({ ...form, type: v as Account["type"] })
                  }
                  disabled={!!editing?.isSystem}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium">Name</label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium">Description</label>
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium">Subtype</label>
                <Input
                  value={form.subtype}
                  onChange={(e) =>
                    setForm({ ...form, subtype: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="text-xs font-medium">Normal balance</label>
                <Select
                  value={form.normalBalance}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      normalBalance: v as Account["normalBalance"],
                    })
                  }
                  disabled={!!editing?.isSystem}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {NORMALS.map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.isActive}
                  onCheckedChange={(v) =>
                    setForm({ ...form, isActive: !!v })
                  }
                />
                Active
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.allowManualPosting}
                  onCheckedChange={(v) =>
                    setForm({ ...form, allowManualPosting: !!v })
                  }
                />
                Allow manual posting
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !isAdmin}>
              {saving ? "Saving…" : editing ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
