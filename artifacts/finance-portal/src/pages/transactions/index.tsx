import { useState } from "react";
import { useListTransactions, useGetReconciliationSummary, useUpdateTransaction, getListTransactionsQueryKey, getGetReconciliationSummaryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { Landmark, ArrowUpRight, ArrowDownRight, Link as LinkIcon, Filter, CheckCircle2 } from "lucide-react";
import { Empty } from "@/components/ui/empty";
import { useToast } from "@/hooks/use-toast";

export default function TransactionsList() {
  const [status, setStatus] = useState<string>("all");
  const currentMonth = new Date().toISOString().substring(0, 7); // YYYY-MM
  
  const { data: transactionsList, isLoading } = useListTransactions(
    status !== "all" ? { status: status as any } : undefined
  );
  
  const { data: summary, isLoading: summaryLoading } = useGetReconciliationSummary({ month: currentMonth });
  const updateTransaction = useUpdateTransaction();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleMatch = async (id: number) => {
    try {
      await updateTransaction.mutateAsync({
        id,
        data: { status: "matched" }
      });
      toast({ title: "Transaction matched successfully" });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetReconciliationSummaryQueryKey({ month: currentMonth }) });
    } catch (e) {
      toast({ title: "Failed to match transaction", variant: "destructive" });
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'reconciled': return 'bg-success text-success-foreground';
      case 'matched': return 'bg-info text-info-foreground';
      case 'unmatched': return 'bg-warning text-warning-foreground';
      default: return 'bg-secondary text-secondary-foreground';
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Bank Transactions</h1>
        <p className="text-muted-foreground mt-1">
          Review, match, and reconcile bank feed data.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {summaryLoading ? (
          [1, 2, 3, 4].map(i => <Skeleton key={i} className="h-28 w-full" />)
        ) : summary ? (
          <>
            <Card>
              <CardContent className="p-6">
                <div className="text-sm font-medium text-muted-foreground">Unmatched</div>
                <div className="text-3xl font-bold text-warning mt-2">{summary.unmatched}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <div className="text-sm font-medium text-muted-foreground">Matched</div>
                <div className="text-3xl font-bold text-info mt-2">{summary.matched}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <div className="text-sm font-medium text-muted-foreground">Reconciled</div>
                <div className="text-3xl font-bold text-success mt-2">{summary.reconciled}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <div className="text-sm font-medium text-muted-foreground">Net Cash Flow</div>
                <div className={`text-3xl font-bold mt-2 ${summary.netCashFlow >= 0 ? "text-success" : "text-destructive"}`}>
                  ${Math.abs(summary.netCashFlow).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  {summary.netCashFlow < 0 && "-"}
                </div>
              </CardContent>
            </Card>
          </>
        ) : null}
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
                  <SelectItem value="unmatched">Unmatched</SelectItem>
                  <SelectItem value="matched">Matched</SelectItem>
                  <SelectItem value="reconciled">Reconciled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {transactionsList && <div className="text-sm text-muted-foreground">{transactionsList.total} total transactions</div>}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : transactionsList?.items && transactionsList.items.length > 0 ? (
            <div className="divide-y">
              {transactionsList.items.map((transaction) => (
                <div key={transaction.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 hover:bg-muted/50 transition-colors">
                  <div className="flex items-start gap-4">
                    <div className={`mt-1 p-2 rounded-full ${transaction.type === 'credit' ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}>
                      {transaction.type === 'credit' ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2">
                        <span className="font-semibold text-foreground">
                          {transaction.description}
                        </span>
                        <Badge className={getStatusColor(transaction.status)} variant="outline">
                          {transaction.status}
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground flex items-center gap-2">
                        <span>{format(new Date(transaction.transactionDate), "MMM d, yyyy")}</span>
                        {transaction.bankAccountName && (
                          <>
                            <span>•</span>
                            <span>{transaction.bankAccountName}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 sm:mt-0 flex items-center justify-between sm:justify-end w-full sm:w-auto space-x-4 ml-12 sm:ml-0">
                    <div className={`text-lg font-bold ${transaction.type === 'credit' ? 'text-success' : ''}`}>
                      {transaction.type === 'credit' ? '+' : '-'}${transaction.amount.toFixed(2)}
                    </div>
                    {transaction.status === 'unmatched' ? (
                      <Button variant="outline" size="sm" onClick={() => handleMatch(transaction.id)} disabled={updateTransaction.isPending}>
                        <LinkIcon className="mr-2 h-3 w-3" /> Match
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" disabled className="text-success">
                        <CheckCircle2 className="mr-2 h-3 w-3" /> {transaction.status}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-12">
              <Empty
                icon={Landmark}
                title="No transactions found"
                description={status !== "all" ? `No transactions match the status "${status}".` : "No bank transactions have been imported yet."}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
