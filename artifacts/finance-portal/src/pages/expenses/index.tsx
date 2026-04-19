import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { useListExpenses } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { Plus, Receipt, Filter } from "lucide-react";
import { Empty } from "@/components/ui/empty";

type ExpenseStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "needs_correction"
  | "reimbursed";

export default function ExpensesList() {
  const search = useSearch();
  const initialStatus = new URLSearchParams(search).get("status") ?? "all";
  const [status, setStatus] = useState<string>(initialStatus);

  // Keep filter in sync if URL changes (e.g. AI import navigation).
  useEffect(() => {
    const next = new URLSearchParams(search).get("status") ?? "all";
    setStatus(next);
  }, [search]);

  const { data: expensesList, isLoading } = useListExpenses(
    status !== "all" ? { status: status as ExpenseStatus } : undefined,
  );

  const getStatusColor = (status: string) => {
    switch (status) {
      case "approved":
        return "bg-success text-success-foreground";
      case "rejected":
        return "bg-destructive text-destructive-foreground";
      case "needs_correction":
        return "bg-warning text-warning-foreground";
      case "submitted":
        return "bg-info text-info-foreground";
      case "reimbursed":
        return "bg-primary text-primary-foreground";
      default:
        return "bg-secondary text-secondary-foreground";
    }
  };

  const formatStatus = (s: string) =>
    s === "needs_correction" ? "Needs Correction" : s;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Expenses</h1>
          <p className="text-muted-foreground mt-1">
            Manage and track staff expense claims.
          </p>
        </div>
        <Link href="/expenses/new">
          <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
            <Plus className="mr-2 h-4 w-4" />
            New Expense
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader className="pb-4 border-b">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="submitted">Submitted</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="needs_correction">Needs Correction</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="reimbursed">Reimbursed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {expensesList && <div className="text-sm text-muted-foreground">{expensesList.total} total expenses</div>}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : expensesList?.items && expensesList.items.length > 0 ? (
            <div className="divide-y">
              {expensesList.items.map((expense) => (
                <Link key={expense.id} href={`/expenses/${expense.id}`}>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 hover:bg-muted/50 transition-colors cursor-pointer group">
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2">
                        <span className="font-semibold text-foreground group-hover:text-primary transition-colors">
                          {expense.merchant}
                        </span>
                        <Badge className={getStatusColor(expense.status)} variant="outline">
                          {formatStatus(expense.status)}
                        </Badge>
                        {expense.potentialDuplicateIds && expense.potentialDuplicateIds.length > 0 && (
                          <Badge variant="outline" className="bg-warning/10 text-warning border-warning/40">
                            Possible Duplicate
                          </Badge>
                        )}
                        {(expense.categoryId == null || expense.categoryName === "Uncategorized") && (
                          <Badge
                            variant="outline"
                            className="bg-warning/10 text-warning border-warning/40"
                            data-testid={`badge-uncategorized-${expense.id}`}
                          >
                            Uncategorized
                          </Badge>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {expense.description || "No description"}
                      </div>
                      <div className="flex items-center space-x-2 text-xs text-muted-foreground">
                        <span>{expense.submittedBy}</span>
                        <span>•</span>
                        <span>{format(new Date(expense.expenseDate), "MMM d, yyyy")}</span>
                        {expense.programName && (
                          <>
                            <span>•</span>
                            <span>{expense.programName}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="mt-4 sm:mt-0 text-right">
                      <div className="text-lg font-bold">${expense.amount.toFixed(2)}</div>
                      <div className="text-xs text-muted-foreground uppercase">{expense.paymentMethod.replace('_', ' ')}</div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="p-12">
              <Empty
                icon={Receipt}
                title="No expenses found"
                description={status !== "all" ? `No expenses match the status "${status}".` : "There are no expenses recorded yet."}
                action={
                  <Link href="/expenses/new">
                    <Button variant="outline">Create your first expense</Button>
                  </Link>
                }
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
