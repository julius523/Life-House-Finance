import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft } from "lucide-react";
import { apiJson } from "@/lib/api";

type Account = {
  id: number;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  normalBalance: "debit" | "credit";
  isActive: boolean;
  isSystem: boolean;
  allowManualPosting: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

type ActivityRow = {
  lineId: number;
  journalEntryId: number;
  type: "debit" | "credit";
  amountCents: number;
  memo: string | null;
  program: string | null;
  fund: string | null;
  entryDate: string;
  entryMemo: string | null;
  entryStatus: string;
  postedAt: string | null;
};

type ActivityResponse = { account: Account; activity: ActivityRow[] };

const fmtUsd = (cents: number) =>
  `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function AccountingCoaDetail() {
  const [, params] = useRoute<{ id: string }>("/accounting/coa/:id");
  const id = params?.id;
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    apiJson<ActivityResponse>(`/accounting/chart-of-accounts/${id}/activity?limit=100`)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (error)
    return (
      <div className="p-6 text-sm text-destructive" data-testid="coa-detail-error">
        {error}
      </div>
    );
  if (!data) return null;

  const { account, activity } = data;
  const totalDebits = activity
    .filter((a) => a.type === "debit")
    .reduce((s, a) => s + a.amountCents, 0);
  const totalCredits = activity
    .filter((a) => a.type === "credit")
    .reduce((s, a) => s + a.amountCents, 0);
  const net =
    account.normalBalance === "debit"
      ? totalDebits - totalCredits
      : totalCredits - totalDebits;

  return (
    <div className="space-y-6 p-6" data-testid="coa-detail-page">
      <div className="flex items-center gap-2">
        <Link href="/accounting/coa">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1 h-4 w-4" /> Chart of Accounts
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-2xl">
                {account.code} — {account.name}
              </CardTitle>
              <CardDescription>
                {account.type}
                {account.subtype ? ` · ${account.subtype}` : ""} · normal{" "}
                {account.normalBalance}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              {account.isSystem && <Badge variant="secondary">System</Badge>}
              {!account.isActive && <Badge variant="destructive">Archived</Badge>}
              {!account.allowManualPosting && (
                <Badge variant="outline">Manual posting disabled</Badge>
              )}
              {account.isActive && (
                <Badge variant="default" className="bg-success">
                  Active
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {account.description && (
            <p className="text-sm text-muted-foreground">{account.description}</p>
          )}
          <Separator />
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <div className="text-xs text-muted-foreground">Debits in view</div>
              <div className="text-xl font-semibold">{fmtUsd(totalDebits)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Credits in view</div>
              <div className="text-xl font-semibold">{fmtUsd(totalCredits)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                Net ({account.normalBalance})
              </div>
              <div className="text-xl font-semibold">{fmtUsd(net)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent ledger activity</CardTitle>
          <CardDescription>
            Last {activity.length} posted journal lines touching this account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No posted ledger activity for this account yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="coa-detail-activity">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="px-2 py-2">Date</th>
                    <th className="px-2 py-2">JE</th>
                    <th className="px-2 py-2">Memo</th>
                    <th className="px-2 py-2">Program / Fund</th>
                    <th className="px-2 py-2 text-right">Debit</th>
                    <th className="px-2 py-2 text-right">Credit</th>
                    <th className="px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((row) => (
                    <tr key={row.lineId} className="border-b">
                      <td className="px-2 py-2 whitespace-nowrap">
                        {row.entryDate}
                      </td>
                      <td className="px-2 py-2 font-mono text-xs">
                        #{row.journalEntryId}
                      </td>
                      <td className="px-2 py-2">
                        <div>{row.memo ?? row.entryMemo ?? "—"}</div>
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {row.program ?? "—"}
                        {row.fund ? ` · ${row.fund}` : ""}
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        {row.type === "debit" ? fmtUsd(row.amountCents) : ""}
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        {row.type === "credit" ? fmtUsd(row.amountCents) : ""}
                      </td>
                      <td className="px-2 py-2">
                        <Badge
                          variant={
                            row.entryStatus === "posted"
                              ? "default"
                              : row.entryStatus === "reversed"
                                ? "destructive"
                                : "outline"
                          }
                        >
                          {row.entryStatus}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
