import { useListTransactions } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Landmark } from "lucide-react";
import { format } from "date-fns";

type Props = {
  expenseId?: number;
  billId?: number;
};

export function LinkedTransactions({ expenseId, billId }: Props) {
  const params =
    expenseId !== undefined
      ? { matchedExpenseId: expenseId }
      : billId !== undefined
        ? { matchedBillId: billId }
        : undefined;
  const { data, isLoading } = useListTransactions(params, {
    query: { enabled: params !== undefined },
  });

  if (isLoading) return null;

  const items = data?.items ?? [];

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
                <Badge variant="secondary">{t.status}</Badge>
                <div
                  className={`text-sm font-semibold ${
                    t.type === "credit" ? "text-success" : ""
                  }`}
                >
                  {t.type === "credit" ? "+" : "-"}${t.amount.toFixed(2)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
