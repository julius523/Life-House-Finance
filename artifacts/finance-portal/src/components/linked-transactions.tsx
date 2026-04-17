import {
  useListTransactions,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Landmark, CheckCircle2 } from "lucide-react";
import { format } from "date-fns";
import { useState } from "react";
import { apiJson } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

type Props = {
  expenseId?: number;
  billId?: number;
  enableReconcile?: boolean;
};

export function LinkedTransactions({ expenseId, billId, enableReconcile }: Props) {
  const params =
    expenseId !== undefined
      ? { matchedExpenseId: expenseId }
      : billId !== undefined
        ? { matchedBillId: billId }
        : undefined;
  const { data, isLoading } = useListTransactions(params, {
    query: { enabled: params !== undefined },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);

  if (isLoading) return null;

  const items = data?.items ?? [];

  const reconcile = async (txId: number) => {
    setBusyId(txId);
    try {
      await apiJson(`/transactions/${txId}`, {
        method: "PUT",
        body: { status: "reconciled" },
      });
      toast({ title: "Transaction reconciled" });
      if (params)
        queryClient.invalidateQueries({
          queryKey: getListTransactionsQueryKey(params),
        });
    } catch (e) {
      toast({
        title: "Could not reconcile",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Landmark className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Bank transaction</h3>
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <Badge variant="outline">No matching bank transaction</Badge>
          <span>
            This will be flagged at month end until a bank transaction is matched.
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between gap-3 rounded-md bg-background p-3 border"
            >
              <div className="min-w-0">
                <div className="font-medium truncate">{t.description}</div>
                <div className="text-xs text-muted-foreground">
                  {format(new Date(t.transactionDate), "MMM d, yyyy")}
                  {t.bankAccountName ? ` • ${t.bankAccountName}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge
                  className={
                    t.status === "reconciled"
                      ? "bg-success text-success-foreground"
                      : t.status === "matched"
                        ? "bg-info text-info-foreground"
                        : "bg-secondary text-secondary-foreground"
                  }
                >
                  {t.status === "reconciled" ? "Reconciled" : t.status}
                </Badge>
                <div
                  className={`text-sm font-semibold ${
                    t.type === "credit" ? "text-success" : ""
                  }`}
                >
                  {t.type === "credit" ? "+" : "-"}${t.amount.toFixed(2)}
                </div>
                {enableReconcile && t.status !== "reconciled" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === t.id}
                    onClick={() => reconcile(t.id)}
                  >
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                    {busyId === t.id ? "Reconciling…" : "Reconcile"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
