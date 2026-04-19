import { useEffect, useMemo, useState } from "react";
import { useLocation, Link, useSearch } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { ArrowLeft, BookOpen, Plus, Save, Trash2 } from "lucide-react";

type Account = {
  id: number;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  isActive: boolean;
  allowManualPosting: boolean;
};

type LineDraft = {
  uid: number;
  type: "debit" | "credit";
  accountCode: string;
  amount: string;
  program: string;
  fund: string;
  memo: string;
};

function todayIsoLocal(): string {
  const now = new Date();
  const tzOffsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

function makeBlankLine(type: "debit" | "credit"): LineDraft {
  return {
    uid: Math.random(),
    type,
    accountCode: "",
    amount: "",
    program: "",
    fund: "",
    memo: "",
  };
}

function parseAmountToCents(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

type DraftPayload = {
  entryDate: string;
  memo: string;
  lines: Array<Omit<LineDraft, "uid"> & { uid?: number }>;
};

type DraftRecord = {
  id: number;
  createdByUserId: number;
  entryDate: string | null;
  memo: string | null;
  payload: DraftPayload;
  createdAt: string;
  updatedAt: string;
};

function rehydrateLine(
  line: DraftPayload["lines"][number],
  fallbackType: "debit" | "credit",
): LineDraft {
  return {
    uid: typeof line.uid === "number" ? line.uid : Math.random(),
    type: line.type === "credit" ? "credit" : line.type === "debit" ? "debit" : fallbackType,
    accountCode: line.accountCode ?? "",
    amount: line.amount ?? "",
    program: line.program ?? "",
    fund: line.fund ?? "",
    memo: line.memo ?? "",
  };
}

export default function JournalEntriesNewPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const canPost = user?.role === "admin" || user?.role === "approver";

  const draftIdParam = useMemo(() => {
    const params = new URLSearchParams(search);
    const raw = params.get("draft");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }, [search]);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [entryDate, setEntryDate] = useState<string>(todayIsoLocal());
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([
    makeBlankLine("debit"),
    makeBlankLine("credit"),
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [discardingDraft, setDiscardingDraft] = useState(false);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftLoadError, setDraftLoadError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!canPost) return;
    let cancelled = false;
    setAccountsLoading(true);
    apiJson<{ accounts: Account[] }>("/accounting/chart-of-accounts")
      .then((data) => {
        if (cancelled) return;
        setAccounts(data.accounts);
        setAccountsError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setAccountsError(
          e instanceof Error ? e.message : "Failed to load chart of accounts.",
        );
      })
      .finally(() => {
        if (!cancelled) setAccountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canPost]);

  // Load existing draft if ?draft=ID is in the URL.
  useEffect(() => {
    if (!canPost) return;
    if (draftIdParam === null) {
      setDraftId(null);
      setDraftLoadError(null);
      return;
    }
    let cancelled = false;
    setDraftLoading(true);
    setDraftLoadError(null);
    apiJson<{ draft: DraftRecord }>(
      `/accounting/journal-entry-drafts/${draftIdParam}`,
    )
      .then(({ draft }) => {
        if (cancelled) return;
        setDraftId(draft.id);
        setLastSavedAt(draft.updatedAt);
        const p = draft.payload ?? { entryDate: "", memo: "", lines: [] };
        // Restore exactly what was saved — including blank values — so
        // a paused, partially-filled entry reopens identically.
        setEntryDate(p.entryDate ?? "");
        setMemo(p.memo ?? "");
        const restored = (p.lines ?? []).map((ln, i) =>
          rehydrateLine(ln, i === 0 ? "debit" : "credit"),
        );
        if (restored.length >= 2) {
          setLines(restored);
        } else if (restored.length === 1) {
          setLines([restored[0]!, makeBlankLine("credit")]);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        // Drop any stale in-memory draft id so a subsequent "Save draft"
        // doesn't try to PATCH an inaccessible/missing draft row.
        setDraftId(null);
        setLastSavedAt(null);
        setDraftLoadError(
          e instanceof Error ? e.message : "Failed to load draft.",
        );
      })
      .finally(() => {
        if (!cancelled) setDraftLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draftIdParam, canPost]);

  const postableAccounts = useMemo(
    () => accounts.filter((a) => a.isActive && a.allowManualPosting),
    [accounts],
  );

  const totals = useMemo(() => {
    let debits = 0;
    let credits = 0;
    let invalid = false;
    for (const ln of lines) {
      const cents = parseAmountToCents(ln.amount);
      if (cents === null && ln.amount.trim() !== "") {
        invalid = true;
        continue;
      }
      if (cents === null) continue;
      if (ln.type === "debit") debits += cents;
      else credits += cents;
    }
    return {
      debitsCents: debits,
      creditsCents: credits,
      diffCents: debits - credits,
      invalid,
    };
  }, [lines]);

  const balanced = totals.debitsCents > 0 && totals.diffCents === 0;

  const updateLine = (uid: number, patch: Partial<LineDraft>) => {
    setLines((curr) =>
      curr.map((l) => (l.uid === uid ? { ...l, ...patch } : l)),
    );
  };

  const removeLine = (uid: number) => {
    setLines((curr) =>
      curr.length <= 2 ? curr : curr.filter((l) => l.uid !== uid),
    );
  };

  const addLine = (type: "debit" | "credit") => {
    setLines((curr) => [...curr, makeBlankLine(type)]);
  };

  const validateBeforeSubmit = (): string | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
      return "Entry date is required.";
    }
    if (memo.trim().length === 0) {
      return "Memo is required.";
    }
    if (lines.length < 2) {
      return "At least two lines are required.";
    }
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]!;
      if (!ln.accountCode) {
        return `Line ${i + 1} is missing an account.`;
      }
      const cents = parseAmountToCents(ln.amount);
      if (cents === null || cents <= 0) {
        return `Line ${i + 1} amount must be greater than zero.`;
      }
      const acct = accounts.find((a) => a.code === ln.accountCode);
      if (!acct) {
        return `Line ${i + 1} account is not in the chart of accounts.`;
      }
      if (!acct.isActive) {
        return `Line ${i + 1} account '${acct.code}' is archived.`;
      }
      if (!acct.allowManualPosting) {
        return `Line ${i + 1} account '${acct.code}' is a header and cannot be posted to.`;
      }
    }
    if (!balanced) {
      return "Debits and credits must balance before posting.";
    }
    return null;
  };

  const buildDraftPayload = (): DraftPayload => ({
    entryDate,
    memo,
    lines: lines.map((l) => ({
      type: l.type,
      accountCode: l.accountCode,
      amount: l.amount,
      program: l.program,
      fund: l.fund,
      memo: l.memo,
    })),
  });

  const saveDraft = async () => {
    setSavingDraft(true);
    try {
      const payload = buildDraftPayload();
      if (draftId !== null) {
        const data = await apiJson<{ draft: DraftRecord }>(
          `/accounting/journal-entry-drafts/${draftId}`,
          { method: "PATCH", body: { payload } },
        );
        setLastSavedAt(data.draft.updatedAt);
        toast({
          title: "Draft saved",
          description: "Your changes are stored.",
        });
      } else {
        const data = await apiJson<{ draft: DraftRecord }>(
          "/accounting/journal-entry-drafts",
          { method: "POST", body: { payload } },
        );
        setDraftId(data.draft.id);
        setLastSavedAt(data.draft.updatedAt);
        // Reflect the draft id in the URL so a refresh resumes correctly.
        setLocation(`/accounting/journal-entries/new?draft=${data.draft.id}`, {
          replace: true,
        });
        toast({
          title: "Draft saved",
          description: "You can come back to it later from the entries list.",
        });
      }
    } catch (e) {
      toast({
        title: "Could not save draft",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSavingDraft(false);
    }
  };

  const discardDraft = async () => {
    if (draftId === null) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("Discard this draft? This cannot be undone.")
    ) {
      return;
    }
    setDiscardingDraft(true);
    try {
      await apiJson<null>(`/accounting/journal-entry-drafts/${draftId}`, {
        method: "DELETE",
      });
      toast({ title: "Draft discarded" });
      setLocation("/accounting/journal-entries");
    } catch (e) {
      toast({
        title: "Could not discard draft",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setDiscardingDraft(false);
    }
  };

  const submit = async () => {
    const err = validateBeforeSubmit();
    if (err) {
      toast({ title: "Cannot post entry", description: err, variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        entryDate,
        memo: memo.trim(),
        lines: lines.map((l) => ({
          type: l.type,
          amount: parseAmountToCents(l.amount)! / 100,
          account_code: l.accountCode,
          program: l.program.trim() || null,
          fund: l.fund.trim() || null,
          memo: l.memo.trim() || null,
        })),
      };
      const data = await apiJson<{
        journalEntry: { id: number; entryNo: string };
      }>("/accounting/journal-entries", {
        method: "POST",
        body: payload,
      });
      // Clean up the draft (if any) now that the entry is posted.
      if (draftId !== null) {
        try {
          await apiJson<null>(
            `/accounting/journal-entry-drafts/${draftId}`,
            { method: "DELETE" },
          );
        } catch {
          // Non-fatal: the post succeeded; a stale draft can be removed
          // from the drafts list.
        }
      }
      toast({
        title: `Posted ${data.journalEntry.entryNo}`,
        description: "Entry is now in the ledger and Trial Balance.",
      });
      setLocation("/reports");
    } catch (e) {
      toast({
        title: "Could not post entry",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!canPost) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">New journal entry</h1>
        <p className="text-muted-foreground">
          Only admins and approvers can post manual journal entries.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-7 w-7 text-primary" />
            {draftId !== null ? "Resume journal entry draft" : "New journal entry"}
          </h1>
          <p className="text-muted-foreground mt-1">
            Record an adjusting, accrual, depreciation, or reclass entry by
            hand. Save a draft to come back to later, or post it straight to
            the ledger.
          </p>
          {lastSavedAt && (
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-draft-status">
              Draft saved {new Date(lastSavedAt).toLocaleString()}
            </p>
          )}
          {draftLoadError && (
            <p className="text-xs text-destructive mt-1">{draftLoadError}</p>
          )}
        </div>
        <Button variant="ghost" asChild>
          <Link href="/accounting">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Header</CardTitle>
          <CardDescription>
            Date and memo apply to the entire entry.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="entry-date">Entry date</Label>
            <Input
              id="entry-date"
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="entry-memo">Memo</Label>
            <Input
              id="entry-memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="e.g. March 2026 depreciation"
              maxLength={2000}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base">Lines</CardTitle>
              <CardDescription>
                Pick accounts from the active Chart of Accounts. Headers and
                archived accounts are not selectable.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => addLine("debit")}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add debit
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => addLine("credit")}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add credit
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {accountsError && (
            <p className="text-sm text-destructive mb-3">{accountsError}</p>
          )}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">Type</TableHead>
                  <TableHead className="min-w-[260px]">Account</TableHead>
                  <TableHead className="w-[140px] text-right">Amount</TableHead>
                  <TableHead className="min-w-[140px]">Program</TableHead>
                  <TableHead className="min-w-[140px]">Fund</TableHead>
                  <TableHead className="min-w-[200px]">Line memo</TableHead>
                  <TableHead className="w-[40px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((ln, idx) => (
                  <TableRow key={ln.uid}>
                    <TableCell>
                      <Select
                        value={ln.type}
                        onValueChange={(v) =>
                          updateLine(ln.uid, {
                            type: v as "debit" | "credit",
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="debit">Debit</SelectItem>
                          <SelectItem value="credit">Credit</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={ln.accountCode}
                        onValueChange={(v) =>
                          updateLine(ln.uid, { accountCode: v })
                        }
                        disabled={accountsLoading}
                      >
                        <SelectTrigger>
                          <SelectValue
                            placeholder={
                              accountsLoading
                                ? "Loading…"
                                : "Select account…"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {postableAccounts.length === 0 && (
                            <div className="px-2 py-1.5 text-xs text-muted-foreground">
                              No postable accounts found.
                            </div>
                          )}
                          {postableAccounts.map((a) => (
                            <SelectItem key={a.id} value={a.code}>
                              {a.code} — {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0"
                        className="text-right"
                        value={ln.amount}
                        onChange={(e) =>
                          updateLine(ln.uid, { amount: e.target.value })
                        }
                        placeholder="0.00"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={ln.program}
                        onChange={(e) =>
                          updateLine(ln.uid, { program: e.target.value })
                        }
                        placeholder="(optional)"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={ln.fund}
                        onChange={(e) =>
                          updateLine(ln.uid, { fund: e.target.value })
                        }
                        placeholder="(optional)"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={ln.memo}
                        onChange={(e) =>
                          updateLine(ln.uid, { memo: e.target.value })
                        }
                        placeholder="(optional)"
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeLine(ln.uid)}
                        disabled={lines.length <= 2}
                        title={
                          lines.length <= 2
                            ? "At least two lines are required"
                            : `Remove line ${idx + 1}`
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-6 text-sm">
            <div>
              <div className="text-muted-foreground text-xs uppercase tracking-wide">
                Total debits
              </div>
              <div className="font-mono text-base">
                {(totals.debitsCents / 100).toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs uppercase tracking-wide">
                Total credits
              </div>
              <div className="font-mono text-base">
                {(totals.creditsCents / 100).toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs uppercase tracking-wide">
                Status
              </div>
              {balanced ? (
                <Badge variant="default">Balanced</Badge>
              ) : totals.debitsCents === 0 && totals.creditsCents === 0 ? (
                <Badge variant="secondary">Empty</Badge>
              ) : (
                <Badge variant="destructive">
                  Off by {(Math.abs(totals.diffCents) / 100).toFixed(2)}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" asChild>
              <Link href="/accounting/journal-entries">Cancel</Link>
            </Button>
            {draftId !== null && (
              <Button
                variant="outline"
                onClick={discardDraft}
                disabled={discardingDraft || savingDraft || submitting}
                data-testid="button-discard-draft"
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {discardingDraft ? "Discarding…" : "Discard draft"}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={saveDraft}
              disabled={savingDraft || submitting || draftLoading}
              data-testid="button-save-draft"
            >
              <Save className="h-4 w-4 mr-1" />
              {savingDraft
                ? "Saving…"
                : draftId !== null
                  ? "Update draft"
                  : "Save draft"}
            </Button>
            <Button
              onClick={submit}
              disabled={submitting || !balanced || accountsLoading || savingDraft}
              data-testid="button-post-entry"
            >
              {submitting ? "Posting…" : "Post entry"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
