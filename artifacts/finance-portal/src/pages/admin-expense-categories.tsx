/**
 * Task #51 — Admin UI for Expense Categories and per-payment-method
 * credit rules. Admin-only.
 *
 * Read endpoints are open to any authenticated user; mutation endpoints
 * are server-guarded with role==="admin", and this UI mirrors that by
 * hiding all action buttons unless the current user is admin.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
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
import {
  useListChartOfAccounts,
  type ChartOfAccount,
} from "@workspace/api-client-react";
import { Plus, Pencil, Archive, AlertTriangle } from "lucide-react";

const PAYMENT_METHODS = [
  "cash",
  "check",
  "credit_card",
  "debit_card",
  "bank_transfer",
  "other",
] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

interface PaymentMethodRule {
  id: number;
  categoryId: number;
  paymentMethod: PaymentMethod;
  creditAccountId: number;
  isDefault: boolean;
  creditAccountCode: string | null;
  creditAccountName: string | null;
  creditAccountIsActive: boolean | null;
  creditAccountAllowManualPosting: boolean | null;
}

interface ExpenseCategory {
  id: number;
  name: string;
  debitAccountId: number;
  isActive: boolean;
  isSystem: boolean;
  debitAccountCode: string | null;
  debitAccountName: string | null;
  debitAccountIsActive: boolean | null;
  debitAccountAllowManualPosting: boolean | null;
  rules: PaymentMethodRule[];
  hasCompleteMapping: boolean;
}

interface MissingMappingRow {
  id: number;
  name: string;
  isActive: boolean;
  missingDebit: boolean;
  missingDefaultCredit: boolean;
  archivedDebit: boolean;
  nonPostableDebit: boolean;
  archivedCreditRules: number;
  nonPostableCreditRules: number;
}

const CATEGORIES_QK = ["expense-categories"] as const;
const MISSING_QK = ["expense-categories", "missing-mapping"] as const;

function postable(a: ChartOfAccount): boolean {
  return a.isActive !== false && a.allowManualPosting !== false;
}

function paymentMethodLabel(pm: PaymentMethod): string {
  switch (pm) {
    case "cash":
      return "Cash";
    case "check":
      return "Check";
    case "credit_card":
      return "Credit Card";
    case "debit_card":
      return "Debit Card";
    case "bank_transfer":
      return "Bank Transfer";
    case "other":
      return "Other";
  }
}

export default function AdminExpenseCategoriesPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isAdmin = user?.role === "admin";

  const [includeInactive, setIncludeInactive] = useState(false);

  const accountsQuery = useListChartOfAccounts();
  const allAccounts = accountsQuery.data?.accounts ?? [];
  // Mapping pickers should only offer active+postable accounts.
  const postableAccounts = useMemo(
    () => allAccounts.filter(postable),
    [allAccounts],
  );

  const categoriesQuery = useQuery({
    queryKey: [...CATEGORIES_QK, { includeInactive }],
    queryFn: async () => {
      const qs = includeInactive ? "?includeInactive=true" : "";
      return apiJson<{ categories: ExpenseCategory[] }>(
        `/accounting/expense-categories${qs}`,
      );
    },
  });

  const missingQuery = useQuery({
    queryKey: MISSING_QK,
    queryFn: () =>
      apiJson<{ categories: MissingMappingRow[] }>(
        `/accounting/expense-categories/missing-mapping`,
      ),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: CATEGORIES_QK });
    qc.invalidateQueries({ queryKey: MISSING_QK });
  };

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseCategory | null>(null);
  const [ruleEditingFor, setRuleEditingFor] = useState<ExpenseCategory | null>(
    null,
  );

  const categories = categoriesQuery.data?.categories ?? [];
  const missing = missingQuery.data?.categories ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Expense Categories</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Map every expense category to a debit account, and decide which
            credit account is used for each payment method. These rules feed
            the auto-generated journal entry drafts on expense approval.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={includeInactive}
              onCheckedChange={(v) => setIncludeInactive(v === true)}
            />
            Show inactive
          </label>
          {isAdmin ? (
            <Button onClick={() => setCreateOpen(true)} data-testid="button-new-category">
              <Plus className="mr-2 h-4 w-4" />
              New Category
            </Button>
          ) : null}
        </div>
      </div>

      {missing.length > 0 ? (
        <Card className="border-amber-300">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-4 w-4" />
              {missing.length} categor{missing.length === 1 ? "y" : "ies"} missing mapping
            </CardTitle>
            <CardDescription>
              Until these are fixed, expenses using them will block auto-draft
              generation on approval.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {missing.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between border-b last:border-b-0 py-2"
              >
                <span className="font-medium">{m.name}</span>
                <span className="text-xs text-muted-foreground space-x-2">
                  {m.missingDebit ? <Badge variant="destructive">no debit</Badge> : null}
                  {m.missingDefaultCredit ? (
                    <Badge variant="destructive">no default credit</Badge>
                  ) : null}
                  {m.archivedDebit ? (
                    <Badge variant="secondary">debit archived</Badge>
                  ) : null}
                  {m.nonPostableDebit ? (
                    <Badge variant="secondary">debit not postable</Badge>
                  ) : null}
                  {m.archivedCreditRules > 0 ? (
                    <Badge variant="secondary">
                      {m.archivedCreditRules} archived credit
                    </Badge>
                  ) : null}
                  {m.nonPostableCreditRules > 0 ? (
                    <Badge variant="secondary">
                      {m.nonPostableCreditRules} non-postable credit
                    </Badge>
                  ) : null}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>All categories</CardTitle>
          <CardDescription>
            <Link href="/accounting/coa" className="underline">
              Manage Chart of Accounts
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {categoriesQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : categoriesQuery.error ? (
            <div className="text-sm text-destructive">
              Failed to load categories.
            </div>
          ) : categories.length === 0 ? (
            <div className="text-sm text-muted-foreground">No categories.</div>
          ) : (
            <div className="space-y-3">
              {categories.map((cat) => (
                <CategoryRow
                  key={cat.id}
                  category={cat}
                  isAdmin={isAdmin}
                  onEdit={() => setEditing(cat)}
                  onEditRules={() => setRuleEditingFor(cat)}
                  onDeactivate={async () => {
                    await apiJson(
                      `/accounting/expense-categories/${cat.id}/deactivate`,
                      { method: "POST" },
                    );
                    invalidate();
                    toast({ title: `Deactivated "${cat.name}"` });
                  }}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {createOpen ? (
        <CategoryEditor
          mode="create"
          accounts={postableAccounts}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            invalidate();
          }}
        />
      ) : null}

      {editing ? (
        <CategoryEditor
          mode="edit"
          category={editing}
          accounts={postableAccounts}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      ) : null}

      {ruleEditingFor ? (
        <RulesEditor
          category={ruleEditingFor}
          accounts={postableAccounts}
          onClose={() => setRuleEditingFor(null)}
          onChanged={() => invalidate()}
        />
      ) : null}
    </div>
  );
}

function CategoryRow({
  category,
  isAdmin,
  onEdit,
  onEditRules,
  onDeactivate,
}: {
  category: ExpenseCategory;
  isAdmin: boolean;
  onEdit: () => void;
  onEditRules: () => void;
  onDeactivate: () => Promise<void> | void;
}) {
  return (
    <div className="border rounded-md p-3 space-y-2" data-testid={`category-row-${category.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium flex items-center gap-2">
            {category.name}
            {!category.isActive ? <Badge variant="secondary">inactive</Badge> : null}
            {category.isSystem ? <Badge variant="outline">system</Badge> : null}
            {!category.hasCompleteMapping ? (
              <Badge variant="destructive">incomplete mapping</Badge>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Debit:{" "}
            {category.debitAccountCode ? (
              <span>
                {category.debitAccountCode} — {category.debitAccountName}
                {category.debitAccountIsActive === false ? " (archived)" : null}
                {category.debitAccountAllowManualPosting === false
                  ? " (non-postable)"
                  : null}
              </span>
            ) : (
              <span className="text-destructive">unset</span>
            )}
          </div>
        </div>
        {isAdmin ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil className="mr-1 h-3 w-3" />
              Edit
            </Button>
            <Button size="sm" variant="outline" onClick={onEditRules}>
              Payment Rules
            </Button>
            {!category.isSystem && category.isActive ? (
              <Button size="sm" variant="ghost" onClick={() => void onDeactivate()}>
                <Archive className="mr-1 h-3 w-3" />
                Deactivate
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="text-xs space-y-1 pl-2">
        {category.rules.length === 0 ? (
          <span className="text-destructive">No payment-method rules.</span>
        ) : (
          category.rules.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <span className="font-medium">{paymentMethodLabel(r.paymentMethod)}</span>
              {r.isDefault ? <Badge variant="secondary">default</Badge> : null}
              <span className="text-muted-foreground">
                → {r.creditAccountCode ?? "?"} — {r.creditAccountName ?? "?"}
                {r.creditAccountIsActive === false ? " (archived)" : null}
                {r.creditAccountAllowManualPosting === false
                  ? " (non-postable)"
                  : null}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CategoryEditor({
  mode,
  category,
  accounts,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  category?: ExpenseCategory;
  accounts: ChartOfAccount[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(category?.name ?? "");
  const [debitId, setDebitId] = useState<string>(
    category?.debitAccountId ? String(category.debitAccountId) : "",
  );
  const [isActive, setIsActive] = useState(category?.isActive ?? true);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    if (!debitId) {
      toast({ title: "Debit account is required", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        debitAccountId: Number(debitId),
        isActive,
      };
      if (mode === "create") {
        await apiJson(`/accounting/expense-categories`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        toast({ title: `Created "${name.trim()}"` });
      } else if (category) {
        await apiJson(`/accounting/expense-categories/${category.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        toast({ title: `Updated "${name.trim()}"` });
      }
      onSaved();
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New Expense Category" : `Edit "${category?.name}"`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={category?.isSystem === true}
              data-testid="input-category-name"
            />
            {category?.isSystem ? (
              <p className="text-xs text-muted-foreground mt-1">
                System categories cannot be renamed.
              </p>
            ) : null}
          </div>
          <div>
            <label className="text-sm font-medium">Debit account</label>
            <Select value={debitId} onValueChange={setDebitId}>
              <SelectTrigger data-testid="select-debit-account">
                <SelectValue placeholder="Select an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.code} — {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Only active accounts that allow manual posting are listed.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={isActive}
              onCheckedChange={(v) => setIsActive(v === true)}
              disabled={category?.isSystem === true}
            />
            Active
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting} data-testid="button-save-category">
            {submitting ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RulesEditor({
  category,
  accounts,
  onClose,
  onChanged,
}: {
  category: ExpenseCategory;
  accounts: ChartOfAccount[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const detailQuery = useQuery({
    queryKey: ["expense-categories", category.id, "rules"],
    queryFn: () =>
      apiJson<{ category: ExpenseCategory }>(
        `/accounting/expense-categories/${category.id}`,
      ),
  });
  const current = detailQuery.data?.category ?? category;

  const refresh = () => {
    qc.invalidateQueries({
      queryKey: ["expense-categories", category.id, "rules"],
    });
    onChanged();
  };

  const [pm, setPm] = useState<PaymentMethod>("other");
  const [creditId, setCreditId] = useState<string>("");
  const [isDefault, setIsDefault] = useState(false);

  const create = useMutation({
    mutationFn: async () => {
      if (!creditId) throw new Error("Credit account is required");
      return apiJson(
        `/accounting/expense-categories/${category.id}/payment-method-rules`,
        {
          method: "POST",
          body: JSON.stringify({
            paymentMethod: pm,
            creditAccountId: Number(creditId),
            isDefault,
          }),
        },
      );
    },
    onSuccess: () => {
      toast({ title: "Rule added" });
      setCreditId("");
      setIsDefault(false);
      refresh();
    },
    onError: (e) =>
      toast({
        title: "Add failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      }),
  });

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Payment-method rules — {current.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            {current.rules.length === 0 ? (
              <div className="text-sm text-muted-foreground">No rules yet.</div>
            ) : (
              current.rules.map((r) => (
                <RuleRow
                  key={r.id}
                  categoryId={category.id}
                  rule={r}
                  accounts={accounts}
                  onChanged={refresh}
                />
              ))
            )}
          </div>

          <div className="border-t pt-3 space-y-2">
            <div className="text-sm font-medium">Add a rule</div>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="text-xs">Payment method</label>
                <Select value={pm} onValueChange={(v) => setPm(v as PaymentMethod)}>
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {paymentMethodLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs">Credit account</label>
                <Select value={creditId} onValueChange={setCreditId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={isDefault}
                  onCheckedChange={(v) => setIsDefault(v === true)}
                />
                Default
              </label>
              <Button
                onClick={() => create.mutate()}
                disabled={create.isPending}
                data-testid="button-add-rule"
              >
                {create.isPending ? "Adding…" : "Add"}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RuleRow({
  categoryId,
  rule,
  accounts,
  onChanged,
}: {
  categoryId: number;
  rule: PaymentMethodRule;
  accounts: ChartOfAccount[];
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [creditId, setCreditId] = useState(String(rule.creditAccountId));
  const [editing, setEditing] = useState(false);

  const save = async () => {
    try {
      await apiJson(
        `/accounting/expense-categories/${categoryId}/payment-method-rules/${rule.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ creditAccountId: Number(creditId) }),
        },
      );
      setEditing(false);
      onChanged();
      toast({ title: "Updated" });
    } catch (e) {
      toast({
        title: "Update failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const promote = async () => {
    try {
      await apiJson(
        `/accounting/expense-categories/${categoryId}/payment-method-rules/${rule.id}`,
        { method: "PATCH", body: JSON.stringify({ isDefault: true }) },
      );
      onChanged();
      toast({ title: "Set as default" });
    } catch (e) {
      toast({
        title: "Update failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const remove = async () => {
    try {
      await apiJson(
        `/accounting/expense-categories/${categoryId}/payment-method-rules/${rule.id}`,
        { method: "DELETE" },
      );
      onChanged();
      toast({ title: "Deleted" });
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="border rounded p-2 flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium w-28">{paymentMethodLabel(rule.paymentMethod)}</span>
      {rule.isDefault ? <Badge variant="secondary">default</Badge> : null}
      {editing ? (
        <Select value={creditId} onValueChange={setCreditId}>
          <SelectTrigger className="w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.code} — {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="flex-1 text-muted-foreground">
          → {rule.creditAccountCode ?? "?"} — {rule.creditAccountName ?? "?"}
          {rule.creditAccountIsActive === false ? " (archived)" : null}
          {rule.creditAccountAllowManualPosting === false ? " (non-postable)" : null}
        </span>
      )}
      <div className="flex items-center gap-1 ml-auto">
        {editing ? (
          <>
            <Button size="sm" onClick={() => void save()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Change
            </Button>
            {!rule.isDefault ? (
              <Button size="sm" variant="ghost" onClick={() => void promote()}>
                Make default
              </Button>
            ) : null}
            {!rule.isDefault ? (
              <Button size="sm" variant="ghost" onClick={() => void remove()}>
                Delete
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
