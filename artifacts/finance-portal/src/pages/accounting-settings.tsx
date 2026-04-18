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
import { Checkbox } from "@/components/ui/checkbox";
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

type Account = {
  id: number;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
};

type Settings = {
  id: number;
  accountingMethod: "cash" | "accrual";
  separationOfDuties: boolean;
  defaultCashAccountId: number | null;
  defaultApAccountId: number | null;
  defaultArAccountId: number | null;
  defaultExpenseClearingAccountId: number | null;
  defaultRoundingAccountId: number | null;
  receiptRequiredOverCents: number;
  periodCloseRequiresAdmin: boolean;
};

const NULL_ID = "__null__";

export default function AccountingSettingsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";

  const [settings, setSettings] = useState<Settings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Settings | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [s, a] = await Promise.all([
        apiJson<{ settings: Settings }>("/accounting/settings"),
        apiJson<{ accounts: Account[] }>(
          "/accounting/chart-of-accounts",
        ),
      ]);
      setSettings(s.settings);
      setForm(s.settings);
      setAccounts(a.accounts.filter((x) => x.isActive));
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
  }, []);

  const byType = useMemo(() => {
    const m: Record<string, Account[]> = {};
    for (const a of accounts) (m[a.type] ??= []).push(a);
    for (const k of Object.keys(m))
      m[k]!.sort((x, y) => x.code.localeCompare(y.code));
    return m;
  }, [accounts]);

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const body = {
        accountingMethod: form.accountingMethod,
        separationOfDuties: form.separationOfDuties,
        defaultCashAccountId: form.defaultCashAccountId,
        defaultApAccountId: form.defaultApAccountId,
        defaultArAccountId: form.defaultArAccountId,
        defaultExpenseClearingAccountId:
          form.defaultExpenseClearingAccountId,
        defaultRoundingAccountId: form.defaultRoundingAccountId,
        receiptRequiredOverCents: form.receiptRequiredOverCents,
        periodCloseRequiresAdmin: form.periodCloseRequiresAdmin,
      };
      const res = await apiJson<{ settings: Settings }>(
        "/accounting/settings",
        { method: "PATCH", body },
      );
      setSettings(res.settings);
      setForm(res.settings);
      toast({ title: "Settings saved" });
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

  function AccountPicker({
    label,
    value,
    onChange,
    types,
  }: {
    label: string;
    value: number | null;
    onChange: (id: number | null) => void;
    types: string[];
  }) {
    const opts = types.flatMap((t) => byType[t] ?? []);
    return (
      <div>
        <label className="text-xs font-medium">{label}</label>
        <Select
          value={value === null ? NULL_ID : String(value)}
          onValueChange={(v) =>
            onChange(v === NULL_ID ? null : Number(v))
          }
          disabled={!isAdmin}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NULL_ID}>— none —</SelectItem>
            {opts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.code} · {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (loading || !form) {
    return <div className="p-6">Loading…</div>;
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(settings);

  return (
    <div className="space-y-6 p-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold">Accounting Settings</h1>
        <p className="text-muted-foreground">
          Singleton configuration that controls posting rules, default
          accounts, and audit policy.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Method &amp; controls</CardTitle>
          <CardDescription>
            Cash basis records when money moves; accrual records on the
            invoice/bill date.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium">Accounting method</label>
              <Select
                value={form.accountingMethod}
                onValueChange={(v) =>
                  setForm({
                    ...form,
                    accountingMethod: v as Settings["accountingMethod"],
                  })
                }
                disabled={!isAdmin}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">cash</SelectItem>
                  <SelectItem value="accrual">accrual</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium">
                Receipt required over (USD)
              </label>
              <Input
                type="number"
                min={0}
                step={1}
                value={(form.receiptRequiredOverCents / 100).toString()}
                onChange={(e) =>
                  setForm({
                    ...form,
                    receiptRequiredOverCents: Math.round(
                      Number(e.target.value || 0) * 100,
                    ),
                  })
                }
                disabled={!isAdmin}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.separationOfDuties}
                onCheckedChange={(v) =>
                  setForm({ ...form, separationOfDuties: !!v })
                }
                disabled={!isAdmin}
              />
              Enforce separation of duties (preparer ≠ approver)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.periodCloseRequiresAdmin}
                onCheckedChange={(v) =>
                  setForm({ ...form, periodCloseRequiresAdmin: !!v })
                }
                disabled={!isAdmin}
              />
              Period close requires admin
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default accounts</CardTitle>
          <CardDescription>
            Used by automatic postings (bills, expenses, deposits, rounding).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          <AccountPicker
            label="Default cash account"
            value={form.defaultCashAccountId}
            onChange={(id) => setForm({ ...form, defaultCashAccountId: id })}
            types={["asset"]}
          />
          <AccountPicker
            label="Default Accounts Payable"
            value={form.defaultApAccountId}
            onChange={(id) => setForm({ ...form, defaultApAccountId: id })}
            types={["liability"]}
          />
          <AccountPicker
            label="Default Accounts Receivable"
            value={form.defaultArAccountId}
            onChange={(id) => setForm({ ...form, defaultArAccountId: id })}
            types={["asset"]}
          />
          <AccountPicker
            label="Expense clearing account"
            value={form.defaultExpenseClearingAccountId}
            onChange={(id) =>
              setForm({ ...form, defaultExpenseClearingAccountId: id })
            }
            types={["liability", "asset"]}
          />
          <AccountPicker
            label="Rounding account"
            value={form.defaultRoundingAccountId}
            onChange={(id) =>
              setForm({ ...form, defaultRoundingAccountId: id })
            }
            types={["expense", "revenue"]}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => setForm(settings)}
          disabled={saving || !dirty}
        >
          Reset
        </Button>
        <Button onClick={save} disabled={saving || !dirty || !isAdmin}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
