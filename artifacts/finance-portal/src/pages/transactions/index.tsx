import { useState } from "react";
import {
  useListTransactions,
  useGetReconciliationSummary,
  useUpdateTransaction,
  useConvertTransactionToExpense,
  useConvertTransactionToBill,
  useLinkTransactionToProgram,
  useListPrograms,
  useListVendors,
  getListTransactionsQueryKey,
  getGetReconciliationSummaryQueryKey,
  type Transaction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import {
  Landmark,
  ArrowUpRight,
  ArrowDownRight,
  Filter,
  CheckCircle2,
  Receipt,
  FileText,
  PiggyBank,
} from "lucide-react";
import { Empty } from "@/components/ui/empty";
import { useToast } from "@/hooks/use-toast";
import { BankStatementImport } from "@/components/bank-statement-import";
import { Link } from "wouter";

export default function TransactionsList() {
  const [status, setStatus] = useState<string>("all");
  const currentMonth = new Date().toISOString().substring(0, 7);

  const { data: transactionsList, isLoading } = useListTransactions(
    status !== "all" ? { status: status as any } : undefined
  );
  const { data: summary, isLoading: summaryLoading } =
    useGetReconciliationSummary({ month: currentMonth });
  const updateTransaction = useUpdateTransaction();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [convertExpenseFor, setConvertExpenseFor] = useState<Transaction | null>(null);
  const [convertBillFor, setConvertBillFor] = useState<Transaction | null>(null);
  const [linkProgramFor, setLinkProgramFor] = useState<Transaction | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetReconciliationSummaryQueryKey({ month: currentMonth }),
    });
  };

  const handleReconcile = async (id: number) => {
    try {
      await updateTransaction.mutateAsync({ id, data: { status: "reconciled" } });
      toast({ title: "Transaction reconciled" });
      invalidate();
    } catch {
      toast({ title: "Failed to reconcile", variant: "destructive" });
    }
  };

  const getStatusColor = (s: string) => {
    switch (s) {
      case "reconciled":
        return "bg-success text-success-foreground";
      case "matched":
        return "bg-info text-info-foreground";
      case "unmatched":
        return "bg-warning text-warning-foreground";
      default:
        return "bg-secondary text-secondary-foreground";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Bank Transactions</h1>
          <p className="text-muted-foreground mt-1">
            Every imported debit and credit, with one-click conversion to expenses, bills, or program income.
          </p>
        </div>
        <BankStatementImport />
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {summaryLoading ? (
          [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-28 w-full" />)
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
                <div className="text-sm font-medium text-muted-foreground">Net cash flow (MTD)</div>
                <div
                  className={`text-3xl font-bold mt-2 ${
                    summary.netCashFlow >= 0 ? "text-success" : "text-destructive"
                  }`}
                >
                  ${Math.abs(summary.netCashFlow).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                  {summary.netCashFlow < 0 && " out"}
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
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All transactions</SelectItem>
                  <SelectItem value="unmatched">Unmatched</SelectItem>
                  <SelectItem value="matched">Matched</SelectItem>
                  <SelectItem value="reconciled">Reconciled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {transactionsList && (
              <div className="text-sm text-muted-foreground">
                {transactionsList.total} total transactions
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : transactionsList?.items && transactionsList.items.length > 0 ? (
            <div className="divide-y">
              {transactionsList.items.map((t) => (
                <div
                  key={t.id}
                  className="flex flex-col lg:flex-row lg:items-center justify-between p-4 gap-4 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-start gap-4 flex-1 min-w-0">
                    <div
                      className={`mt-1 p-2 rounded-full shrink-0 ${
                        t.type === "credit" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {t.type === "credit" ? (
                        <ArrowUpRight className="h-4 w-4" />
                      ) : (
                        <ArrowDownRight className="h-4 w-4" />
                      )}
                    </div>
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center flex-wrap gap-2">
                        <span className="font-semibold text-foreground truncate">
                          {t.description}
                        </span>
                        <Badge className={getStatusColor(t.status)} variant="outline">
                          {t.status}
                        </Badge>
                        {t.matchedExpenseId && (
                          <Link href={`/expenses/${t.matchedExpenseId}`}>
                            <Badge variant="secondary" className="cursor-pointer hover-elevate">
                              Expense #{t.matchedExpenseId}
                            </Badge>
                          </Link>
                        )}
                        {t.matchedBillId && (
                          <Link href={`/bills/${t.matchedBillId}`}>
                            <Badge variant="secondary" className="cursor-pointer hover-elevate">
                              Bill #{t.matchedBillId}
                            </Badge>
                          </Link>
                        )}
                        {t.matchedProgramName && (
                          <Badge variant="secondary">{t.matchedProgramName}</Badge>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                        <span>{format(new Date(t.transactionDate), "MMM d, yyyy")}</span>
                        {t.bankAccountName && (
                          <>
                            <span>•</span>
                            <span className="truncate">{t.bankAccountName}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between lg:justify-end w-full lg:w-auto gap-3 flex-wrap">
                    <div
                      className={`text-lg font-bold whitespace-nowrap ${
                        t.type === "credit" ? "text-success" : ""
                      }`}
                    >
                      {t.type === "credit" ? "+" : "-"}${t.amount.toFixed(2)}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {t.status === "unmatched" && t.type === "debit" && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setConvertExpenseFor(t)}
                          >
                            <Receipt className="mr-2 h-3 w-3" /> Add as expense
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setConvertBillFor(t)}
                          >
                            <FileText className="mr-2 h-3 w-3" /> Add as bill
                          </Button>
                        </>
                      )}
                      {t.status === "unmatched" && t.type === "credit" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setLinkProgramFor(t)}
                        >
                          <PiggyBank className="mr-2 h-3 w-3" /> Link to program
                        </Button>
                      )}
                      {t.status === "matched" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleReconcile(t.id)}
                          disabled={updateTransaction.isPending}
                        >
                          <CheckCircle2 className="mr-2 h-3 w-3" /> Reconcile
                        </Button>
                      )}
                      {t.status === "reconciled" && (
                        <Button variant="ghost" size="sm" disabled className="text-success">
                          <CheckCircle2 className="mr-2 h-3 w-3" /> Reconciled
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-12">
              <Empty
                icon={Landmark}
                title="No transactions found"
                description={
                  status !== "all"
                    ? `No transactions match the status "${status}".`
                    : "Import a bank statement above to populate transactions."
                }
              />
            </div>
          )}
        </CardContent>
      </Card>

      {convertExpenseFor && (
        <ConvertToExpenseDialog
          transaction={convertExpenseFor}
          onClose={() => setConvertExpenseFor(null)}
          onSuccess={() => {
            invalidate();
            setConvertExpenseFor(null);
          }}
        />
      )}
      {convertBillFor && (
        <ConvertToBillDialog
          transaction={convertBillFor}
          onClose={() => setConvertBillFor(null)}
          onSuccess={() => {
            invalidate();
            setConvertBillFor(null);
          }}
        />
      )}
      {linkProgramFor && (
        <LinkProgramDialog
          transaction={linkProgramFor}
          onClose={() => setLinkProgramFor(null)}
          onSuccess={() => {
            invalidate();
            setLinkProgramFor(null);
          }}
        />
      )}
    </div>
  );
}

function ConvertToExpenseDialog({
  transaction,
  onClose,
  onSuccess,
}: {
  transaction: Transaction;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { data: programs } = useListPrograms();
  const convert = useConvertTransactionToExpense();
  const { toast } = useToast();
  const [programId, setProgramId] = useState<string>("none");
  const [paymentMethod, setPaymentMethod] = useState<string>("credit_card");

  const handleSubmit = async () => {
    try {
      await convert.mutateAsync({
        id: transaction.id,
        data: {
          programId: programId === "none" ? undefined : Number(programId),
          paymentMethod: paymentMethod as any,
          submittedBy: "Bank Import",
        },
      });
      toast({ title: "Draft expense created from transaction" });
      onSuccess();
    } catch {
      toast({ title: "Could not create expense", variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add as expense</DialogTitle>
          <DialogDescription>
            Create a draft expense for{" "}
            <span className="font-semibold">${transaction.amount.toFixed(2)}</span> ·{" "}
            {transaction.description}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Program / Grant (optional)</Label>
            <Select value={programId} onValueChange={setProgramId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {programs?.items.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Payment method</Label>
            <Select value={paymentMethod} onValueChange={setPaymentMethod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="credit_card">Credit card</SelectItem>
                <SelectItem value="debit_card">Debit card</SelectItem>
                <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                <SelectItem value="check">Check</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={convert.isPending}>
            {convert.isPending ? "Creating…" : "Create expense"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConvertToBillDialog({
  transaction,
  onClose,
  onSuccess,
}: {
  transaction: Transaction;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { data: vendors } = useListVendors();
  const { data: programs } = useListPrograms();
  const convert = useConvertTransactionToBill();
  const { toast } = useToast();
  const [vendorId, setVendorId] = useState<string>("");
  const [programId, setProgramId] = useState<string>("none");

  const handleSubmit = async () => {
    if (!vendorId) {
      toast({ title: "Pick a vendor", variant: "destructive" });
      return;
    }
    try {
      await convert.mutateAsync({
        id: transaction.id,
        data: {
          vendorId: Number(vendorId),
          programId: programId === "none" ? undefined : Number(programId),
        },
      });
      toast({ title: "Bill recorded from transaction" });
      onSuccess();
    } catch {
      toast({ title: "Could not record bill", variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add as bill</DialogTitle>
          <DialogDescription>
            Record a paid bill for{" "}
            <span className="font-semibold">${transaction.amount.toFixed(2)}</span> ·{" "}
            {transaction.description}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Vendor</Label>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a vendor…" />
              </SelectTrigger>
              <SelectContent>
                {vendors?.items.length === 0 && (
                  <div className="p-2 text-sm text-muted-foreground">
                    No vendors yet — add one from the Vendors page.
                  </div>
                )}
                {vendors?.items.map((v) => (
                  <SelectItem key={v.id} value={String(v.id)}>
                    {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Program / Grant (optional)</Label>
            <Select value={programId} onValueChange={setProgramId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {programs?.items.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={convert.isPending}>
            {convert.isPending ? "Recording…" : "Record bill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkProgramDialog({
  transaction,
  onClose,
  onSuccess,
}: {
  transaction: Transaction;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { data: programs } = useListPrograms();
  const link = useLinkTransactionToProgram();
  const { toast } = useToast();
  const [programId, setProgramId] = useState<string>("");

  const handleSubmit = async () => {
    if (!programId) {
      toast({ title: "Pick a program", variant: "destructive" });
      return;
    }
    try {
      await link.mutateAsync({
        id: transaction.id,
        data: { programId: Number(programId) },
      });
      toast({ title: "Linked to program" });
      onSuccess();
    } catch {
      toast({ title: "Could not link", variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link credit to a program</DialogTitle>
          <DialogDescription>
            Attribute the deposit of{" "}
            <span className="font-semibold">${transaction.amount.toFixed(2)}</span> ·{" "}
            {transaction.description} to a program or grant account.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Program / Grant</Label>
            <Select value={programId} onValueChange={setProgramId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a program…" />
              </SelectTrigger>
              <SelectContent>
                {programs?.items.length === 0 && (
                  <div className="p-2 text-sm text-muted-foreground">
                    No programs yet — add one from the Programs page.
                  </div>
                )}
                {programs?.items.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={link.isPending}>
            {link.isPending ? "Linking…" : "Link program"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
