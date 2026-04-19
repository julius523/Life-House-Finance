import { useEffect, useState } from "react";
import {
  useGetDashboardSummary,
  useGetSpendingByProgram,
  useGetRecentActivity,
  useListBills,
  useGetAccountingDashboardStatus,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiJson } from "@/lib/api";
import { CREDIT_STATUSES, STATUS_LABEL, STATUS_COLOR, type CreditStatus } from "@/pages/credits";
import { TrendingUp } from "lucide-react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend
} from "recharts";
import { format } from "date-fns";
import { DollarSign, Clock, AlertCircle, CheckSquare, Receipt, FileText, FileBox, AlertTriangle } from "lucide-react";
import { useAuth } from "@/lib/auth";

function SubmitterNeedsAttention() {
  const { user } = useAuth();
  const email = user?.email ?? "";
  const { data, isLoading } = useListBills(
    { status: "needs_correction", submittedByEmail: email },
    { query: { enabled: !!email } },
  );

  if (isLoading || !user) return null;
  const items = data ?? [];
  if (items.length === 0) return null;

  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardHeader>
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-warning" />
          <CardTitle>Needs your attention</CardTitle>
        </div>
        <CardDescription>
          {items.length === 1
            ? "1 bill was sent back to you for correction. Update it and resubmit."
            : `${items.length} bills were sent back to you for correction. Update them and resubmit.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {items.map((b) => (
          <Link key={b.id} href={`/bills/${b.id}`}>
            <div className="flex items-start justify-between gap-4 py-3 hover:bg-muted/30 -mx-2 px-2 rounded transition-colors cursor-pointer">
              <div className="min-w-0">
                <div className="font-semibold truncate">
                  Bill #{b.id} · {b.vendorName}
                </div>
                {b.rejectionReason && (
                  <div className="text-sm text-muted-foreground mt-1 line-clamp-2">
                    {b.rejectionReason}
                  </div>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="font-semibold">${b.amount.toFixed(2)}</div>
                <div className="text-xs text-muted-foreground">
                  Due {format(new Date(b.dueDate), "MMM d, yyyy")}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

function SubmitterDashboard() {
  const { user } = useAuth();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Welcome{user ? `, ${user.firstName}` : ""}!
        </h1>
        <p className="text-muted-foreground mt-1">
          Submit a new expense or bill below. Finance staff will review and
          approve it.
        </p>
      </div>
      <SubmitterNeedsAttention />
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="hover-elevate">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-primary" />
              <CardTitle>New expense</CardTitle>
            </div>
            <CardDescription>
              Submit a receipt for reimbursement or a card charge.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/expenses/new">
              <Button className="w-full">Start expense</Button>
            </Link>
          </CardContent>
        </Card>
        <Card className="hover-elevate">
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              <CardTitle>New bill</CardTitle>
            </div>
            <CardDescription>
              Enter a vendor invoice so finance can schedule payment.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/bills/new">
              <Button className="w-full">Start bill</Button>
            </Link>
          </CardContent>
        </Card>
        <Card className="hover-elevate">
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileBox className="h-5 w-5 text-primary" />
              <CardTitle>My submissions</CardTitle>
            </div>
            <CardDescription>
              Check on expenses and bills you've already sent in.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Link href="/expenses">
              <Button variant="outline" className="flex-1">
                Expenses
              </Button>
            </Link>
            <Link href="/bills">
              <Button variant="outline" className="flex-1">
                Bills
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  if (user?.role === "submitter") {
    return <SubmitterDashboard />;
  }
  return <FullDashboard />;
}

function FullDashboard() {
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary();
  const { data: spending, isLoading: loadingSpending } = useGetSpendingByProgram();
  const { data: activities, isLoading: loadingActivities } = useGetRecentActivity({ limit: 5 });

  const COLORS = ['#24b556', '#4175f4', '#9649e2', '#1800ad', '#eab308'];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1">
          Welcome back. Here's what's happening today.
        </p>
      </div>

      {loadingSummary ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <Skeleton className="h-4 w-[100px]" />
                <Skeleton className="h-4 w-4" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-[120px]" />
                <Skeleton className="h-3 w-[80px] mt-2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : summary ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Approvals</CardTitle>
              <CheckSquare className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.pendingApprovalsCount}</div>
              <p className="text-xs text-muted-foreground">
                Items waiting for review
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Expenses Pending</CardTitle>
              <Receipt className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.totalExpensesPending}</div>
              <p className="text-xs text-muted-foreground">
                ${summary.totalExpensesThisMonth.toLocaleString()} submitted this month
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Overdue Bills</CardTitle>
              <AlertCircle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{summary.totalBillsOverdue}</div>
              <p className="text-xs text-muted-foreground">
                {summary.totalBillsDueThisMonth} total due this month
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Unmatched Transactions</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.unmatchedTransactions}</div>
              <p className="text-xs text-muted-foreground">
                Require reconciliation
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <AccountingStatusCard />

      <CreditsDonut />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4">
          <CardHeader>
            <CardTitle>Spending by Program</CardTitle>
            <CardDescription>Current fiscal year spending distribution</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            {loadingSpending ? (
              <div className="h-full flex items-center justify-center">
                <Skeleton className="h-[250px] w-[250px] rounded-full" />
              </div>
            ) : spending && spending.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={spending}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="totalAmount"
                    nameKey="programName"
                  >
                    {spending.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    formatter={(value: number) => [`$${value.toLocaleString()}`, 'Amount']}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground">
                No spending data available
              </div>
            )}
          </CardContent>
        </Card>
        
        <Card className="col-span-3">
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest actions in the portal</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingActivities ? (
              <div className="space-y-4">
                {[1, 2, 3, 4, 5].map(i => (
                  <div key={i} className="flex items-center space-x-4">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-[200px]" />
                      <Skeleton className="h-3 w-[150px]" />
                    </div>
                  </div>
                ))}
              </div>
            ) : activities && activities.length > 0 ? (
              <div className="space-y-6">
                {activities.map((activity) => (
                  <div key={activity.id} className="flex items-start gap-4">
                    <div className="rounded-full bg-muted p-2 mt-0.5">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm font-medium leading-none">
                        {activity.description}
                      </p>
                      <div className="flex items-center mt-1 text-xs text-muted-foreground space-x-2">
                        <span>{activity.actor}</span>
                        <span>•</span>
                        <span>{format(new Date(activity.createdAt), 'MMM d, h:mm a')}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center text-muted-foreground py-8">
                No recent activity
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

type CreditSummary = {
  realized: number;
  potential: number;
  writeOff: number;
  byStatus: { status: CreditStatus; amount: number; count: number }[];
};

function AccountingStatusCard() {
  const { data: status, isLoading: loading, error } =
    useGetAccountingDashboardStatus();

  const fmtUsd = (cents: number) =>
    `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle>Accounting status</CardTitle>
          <CardDescription>
            Open period, drafts awaiting posting, ledger balance, last close.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Link href="/accounting/coa">
            <Button variant="outline" size="sm">
              Chart of Accounts
            </Button>
          </Link>
          <Link href="/accounting/settings">
            <Button variant="outline" size="sm">
              Settings
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : error ? (
          <div className="text-sm text-muted-foreground">
            {String((error as Error)?.message ?? error)}
          </div>
        ) : status ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Link href="/accounting">
              <div className="rounded-lg border p-3 cursor-pointer hover:border-primary transition-colors">
                <div className="text-xs text-muted-foreground">Open period</div>
                <div className="text-lg font-bold">
                  {status.openPeriod ? status.openPeriod.label : "None"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {status.openPeriod
                    ? `${status.openPeriod.startDate} → ${status.openPeriod.endDate}`
                    : "No open period covers today"}
                </div>
              </div>
            </Link>
            <Link href="/accounting?tab=approvals">
              <div className="rounded-lg border p-3 cursor-pointer hover:border-primary transition-colors">
                <div className="text-xs text-muted-foreground">
                  Unposted drafts
                </div>
                <div className="text-2xl font-bold">
                  {status.unpostedDrafts.count}
                </div>
                <div className="text-xs text-muted-foreground">
                  Pending review
                </div>
              </div>
            </Link>
            <Link href="/reports">
              <div className="rounded-lg border p-3 cursor-pointer hover:border-primary transition-colors">
                <div className="text-xs text-muted-foreground">
                  Trial Balance
                </div>
                <div className="text-lg font-bold">
                  {fmtUsd(status.trialBalanceStatus.debitsCents)}
                </div>
                <div
                  className={`text-xs ${status.trialBalanceStatus.inBalance ? "text-success" : "text-destructive"}`}
                >
                  {status.trialBalanceStatus.inBalance
                    ? "Debits = Credits"
                    : `Out of balance by ${fmtUsd(Math.abs(status.trialBalanceStatus.debitsCents - status.trialBalanceStatus.creditsCents))}`}
                </div>
              </div>
            </Link>
            <Link href="/accounting">
              <div className="rounded-lg border p-3 cursor-pointer hover:border-primary transition-colors">
                <div className="text-xs text-muted-foreground">
                  Last close date
                </div>
                <div className="text-lg font-bold">
                  {status.lastClosedPeriod
                    ? status.lastClosedPeriod.endDate
                    : "—"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {status.lastClosedPeriod
                    ? status.lastClosedPeriod.label
                    : "No closed periods yet"}
                </div>
              </div>
            </Link>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CreditsDonut() {
  const [data, setData] = useState<CreditSummary | null>(null);
  const [filter, setFilter] = useState<CreditStatus | "all">("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const summary = await apiJson<CreditSummary>(`/credit-summary`);
        if (!cancelled) setData(summary);
      } catch {
        // ignore — user may not have access
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (!data) return null;

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  const slices = data.byStatus
    .filter((s) => (filter === "all" ? true : s.status === filter))
    .filter((s) => s.amount > 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 flex-wrap">
        <div>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" /> Credits & Deposits
          </CardTitle>
          <CardDescription>
            Realized income only counts items marked Received. Write-offs are excluded from potential.
          </CardDescription>
        </div>
        <Select value={filter} onValueChange={(v) => setFilter(v as CreditStatus | "all")}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {CREDIT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
          <div className="space-y-3">
            <div className="rounded-lg border p-4 bg-success/5">
              <div className="text-xs text-muted-foreground">Realized income</div>
              <div className="text-2xl font-bold" style={{ color: "#24b556" }}>{fmt(data.realized)}</div>
            </div>
            <div className="rounded-lg border p-4 bg-primary/5">
              <div className="text-xs text-muted-foreground">Potential income</div>
              <div className="text-2xl font-bold" style={{ color: "#4175f4" }}>{fmt(data.potential)}</div>
            </div>
            <div className="rounded-lg border p-4 bg-destructive/5">
              <div className="text-xs text-muted-foreground">Write-offs</div>
              <div className="text-2xl font-bold" style={{ color: "#ef4444" }}>{fmt(data.writeOff)}</div>
            </div>
          </div>
          <div className="md:col-span-2 h-[260px]">
            {slices.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                No credits in this view yet.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={slices}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="amount"
                    nameKey="status"
                  >
                    {slices.map((s) => (
                      <Cell key={s.status} fill={STATUS_COLOR[s.status]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number, _name: string, p: any) => [
                      `$${value.toLocaleString()}`,
                      STATUS_LABEL[p.payload.status as CreditStatus],
                    ]}
                  />
                  <Legend
                    formatter={(value: string) => STATUS_LABEL[value as CreditStatus] ?? value}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
