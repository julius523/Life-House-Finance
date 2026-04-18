import { useEffect, useMemo, useState } from "react";
import { useLocation, Link } from "wouter";
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
import { ArrowLeft, BookOpen, Plus, Trash2 } from "lucide-react";

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

export default function JournalEntriesNewPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const canPost = user?.role === "admin" || user?.role === "approver";

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
            New journal entry
          </h1>
          <p className="text-muted-foreground mt-1">
            Record an adjusting, accrual, depreciation, or reclass entry by
            hand. Posts immediately into the ledger.
          </p>
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
          <div className="flex items-center gap-2">
            <Button variant="ghost" asChild>
              <Link href="/accounting">Cancel</Link>
            </Button>
            <Button
              onClick={submit}
              disabled={submitting || !balanced || accountsLoading}
            >
              {submitting ? "Posting…" : "Post entry"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
