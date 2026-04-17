import { useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import {
  useGetBill,
  useApproveBill,
  useListReceipts,
  useCreateReceipt,
  useListTransactions,
  getGetBillQueryKey,
  getListReceiptsQueryKey,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RejectDialog } from "@/components/reject-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Check,
  Building2,
  Calendar,
  FileText,
  Tag,
  FileBox,
  Trash2,
  X,
  Link2,
} from "lucide-react";
import { format } from "date-fns";
import { ReceiptViewer, type ReceiptViewerFile } from "@/components/receipt-viewer";
import { LinkedTransactions } from "@/components/linked-transactions";
import { ReceiptUploader, type PendingReceipt } from "@/components/receipt-uploader";
import { useAuth } from "@/lib/auth";
import { apiJson } from "@/lib/api";

export default function BillDetail() {
  const [, params] = useRoute("/bills/:id");
  const id = params?.id ? parseInt(params.id) : 0;
  const [, navigate] = useLocation();
  const { user } = useAuth();

  const [viewerFile, setViewerFile] = useState<ReceiptViewerFile | null>(null);
  const [pendingReceipts, setPendingReceipts] = useState<PendingReceipt[]>([]);
  const [selectedTxId, setSelectedTxId] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectBusy, setRejectBusy] = useState(false);

  const { data: bill, isLoading } = useGetBill(id, {
    query: { enabled: !!id, queryKey: getGetBillQueryKey(id) },
  });
  const { data: linkedReceipts } = useListReceipts(
    { linkedBillId: id },
    { query: { enabled: !!id, queryKey: getListReceiptsQueryKey({ linkedBillId: id }) } },
  );
  const { data: unmatchedTxs } = useListTransactions(
    { status: "unmatched" },
    { query: { enabled: !!id } },
  );

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const approveBill = useApproveBill();
  const createReceipt = useCreateReceipt();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetBillQueryKey(id) });
    queryClient.invalidateQueries({
      queryKey: getListReceiptsQueryKey({ linkedBillId: id }),
    });
    queryClient.invalidateQueries({
      queryKey: getListTransactionsQueryKey({ matchedBillId: id }),
    });
    queryClient.invalidateQueries({
      queryKey: getListTransactionsQueryKey({ status: "unmatched" }),
    });
  };

  const handleApprove = async () => {
    try {
      await approveBill.mutateAsync({
        id,
        data: { approvedBy: "Finance Manager", notes: "Approved for payment" },
      });
      toast({ title: "Bill approved" });
      refresh();
    } catch (e) {
      toast({ title: "Failed to approve", variant: "destructive" });
    }
  };

  const handleReject = async (data: {
    reason: string;
    action: "send_back" | "close";
  }) => {
    setRejectBusy(true);
    try {
      await apiJson(`/bills/${id}/reject`, {
        method: "POST",
        body: data,
      });
      toast({
        title:
          data.action === "send_back"
            ? "Bill sent back for correction"
            : "Bill rejected",
      });
      setRejectOpen(false);
      refresh();
    } catch (e) {
      toast({
        title: "Failed to reject",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setRejectBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this bill? This cannot be undone.")) return;
    try {
      await apiJson(`/bills/${id}`, { method: "DELETE" });
      toast({ title: "Bill deleted" });
      navigate("/bills");
    } catch (e) {
      toast({
        title: "Could not delete",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const handleUpload = async () => {
    if (pendingReceipts.length === 0 || !bill) return;
    try {
      for (const r of pendingReceipts) {
        await createReceipt.mutateAsync({
          data: {
            fileName: r.file.name,
            fileType: r.contentType,
            fileUrl: r.objectPath,
            linkedBillId: id,
            amount: bill.amount,
            receiptDate: bill.invoiceDate || bill.dueDate,
          },
        });
      }
      toast({
        title: `${pendingReceipts.length} document${pendingReceipts.length === 1 ? "" : "s"} attached`,
      });
      setPendingReceipts([]);
      refresh();
    } catch (e) {
      toast({
        title: "Could not upload",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const handleDeleteReceipt = async (receiptId: number) => {
    if (!confirm("Remove this attachment?")) return;
    try {
      await apiJson(`/receipts/${receiptId}`, { method: "DELETE" });
      toast({ title: "Attachment removed" });
      refresh();
    } catch (e) {
      toast({
        title: "Could not remove",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const handleLinkTransaction = async () => {
    if (!selectedTxId) return;
    setLinkBusy(true);
    try {
      await apiJson(`/transactions/${selectedTxId}/link-bill`, {
        method: "POST",
        body: { billId: id },
      });
      toast({ title: "Transaction linked to bill" });
      setSelectedTxId(null);
      refresh();
    } catch (e) {
      toast({
        title: "Could not link",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setLinkBusy(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "approved":
        return "bg-info text-info-foreground";
      case "paid":
        return "bg-success text-success-foreground";
      case "overdue":
      case "rejected":
        return "bg-destructive text-destructive-foreground";
      case "needs_correction":
        return "bg-warning text-warning-foreground";
      case "submitted":
        return "bg-primary text-primary-foreground";
      default:
        return "bg-secondary text-secondary-foreground";
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!bill) {
    return <div>Bill not found</div>;
  }

  const isAdmin = user?.role === "admin";
  const canDecide = isAdmin || user?.role === "approver";

  // Only debit transactions are eligible to be linked to a bill (a bill is
  // money going out). The user can search/filter by date, amount, or
  // description in the picker below.
  const candidateTxs = (unmatchedTxs?.items ?? []).filter(
    (t) => t.type === "debit",
  );
  const selectedTx = candidateTxs.find((t) => t.id === selectedTxId);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Link href="/bills">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold tracking-tight">Bill #{bill.id}</h1>
              <Badge className={getStatusColor(bill.status)}>
                {bill.status.toUpperCase()}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1">
              Created on {format(new Date(bill.createdAt), "MMMM d, yyyy")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {bill.status === "submitted" && canDecide && (
            <>
              <Button
                variant="outline"
                className="text-destructive border-destructive hover:bg-destructive/10"
                onClick={() => setRejectOpen(true)}
              >
                <X className="mr-2 h-4 w-4" /> Reject
              </Button>
              <Button
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                onClick={handleApprove}
                disabled={approveBill.isPending}
              >
                <Check className="mr-2 h-4 w-4" />
                {approveBill.isPending ? "Approving..." : "Approve Bill"}
              </Button>
            </>
          )}
          {isAdmin && (
            <Button
              variant="outline"
              className="text-destructive border-destructive/40 hover:bg-destructive/10"
              onClick={handleDelete}
            >
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </Button>
          )}
        </div>
      </div>

      {bill.rejectionReason && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-4">
            <div className="text-sm font-semibold text-destructive">Rejection reason</div>
            <div className="text-sm mt-1">{bill.rejectionReason}</div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Bill Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Building2 className="h-4 w-4" /> Vendor
                </div>
                <div className="font-semibold text-lg">{bill.vendorName}</div>
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <FileText className="h-4 w-4" /> Invoice Number
                </div>
                <div className="font-semibold text-lg">
                  {bill.invoiceNumber || "N/A"}
                </div>
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Calendar className="h-4 w-4" /> Invoice Date
                </div>
                <div>
                  {bill.invoiceDate
                    ? format(new Date(bill.invoiceDate), "MMM d, yyyy")
                    : "N/A"}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-destructive" /> Due Date
                </div>
                <div className="font-medium text-destructive">
                  {format(new Date(bill.dueDate), "MMM d, yyyy")}
                </div>
              </div>
            </div>

            <Separator />

            <div className="space-y-1">
              <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <FileText className="h-4 w-4" /> Description
              </div>
              <div>{bill.description || "No description provided."}</div>
            </div>

            <Separator />

            <div className="space-y-1">
              <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Tag className="h-4 w-4" /> Program Allocation
              </div>
              <div>{bill.programName || "General Fund"}</div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle>Amount Due</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold">${bill.amount.toFixed(2)}</div>
            </CardContent>
          </Card>

          {bill.approvedBy && (
            <Card>
              <CardHeader className="pb-4">
                <CardTitle>Approval</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm text-muted-foreground mb-1">Approved By</div>
                <div className="font-medium">{bill.approvedBy}</div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <LinkedTransactions billId={id} enableReconcile={canDecide} />

      {canDecide && (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Link2 className="h-4 w-4" /> Link a bank transaction
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row gap-3">
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={pickerOpen}
                className="flex-1 justify-between font-normal"
              >
                {selectedTx ? (
                  <span className="truncate">
                    {format(new Date(selectedTx.transactionDate), "MMM d")} · $
                    {selectedTx.amount.toFixed(2)} · {selectedTx.description}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Search unmatched transactions by date, amount, or description…
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
              <Command
                filter={(value, search) => {
                  if (!search) return 1;
                  return value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
                }}
              >
                <CommandInput placeholder="Type a date (MMM d), amount, or description…" />
                <CommandList>
                  <CommandEmpty>
                    {candidateTxs.length === 0
                      ? "No unmatched debit transactions."
                      : "No transactions match your search."}
                  </CommandEmpty>
                  <CommandGroup>
                    {candidateTxs.map((t) => {
                      const label = `${format(new Date(t.transactionDate), "MMM d, yyyy")} $${t.amount.toFixed(2)} ${t.description}`;
                      return (
                        <CommandItem
                          key={t.id}
                          value={label}
                          onSelect={() => {
                            setSelectedTxId(t.id);
                            setPickerOpen(false);
                          }}
                        >
                          <div className="flex w-full items-center justify-between gap-2">
                            <div className="flex-1 truncate">{t.description}</div>
                            <div className="text-xs text-muted-foreground whitespace-nowrap">
                              {format(new Date(t.transactionDate), "MMM d")} · $
                              {t.amount.toFixed(2)}
                            </div>
                          </div>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Button
            onClick={handleLinkTransaction}
            disabled={!selectedTxId || linkBusy}
          >
            {linkBusy ? "Linking…" : "Link"}
          </Button>
        </CardContent>
      </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Attached Documents</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {linkedReceipts && linkedReceipts.items.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {linkedReceipts.items.map((r) => (
                <div
                  key={r.id}
                  className="rounded-md border overflow-hidden hover:shadow-md transition-shadow relative group"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setViewerFile({
                        fileUrl: r.fileUrl,
                        fileName: r.fileName,
                        fileType: r.fileType,
                      })
                    }
                    className="block w-full text-left"
                  >
                    <div className="h-28 bg-muted flex items-center justify-center overflow-hidden">
                      {r.fileType?.startsWith("image/") && r.fileUrl ? (
                        <img
                          src={`/api/storage/${r.fileUrl.replace(/^\/+/, "")}`}
                          alt={r.fileName}
                          className="object-cover w-full h-full"
                        />
                      ) : (
                        <FileBox className="h-8 w-8 text-muted-foreground/40" />
                      )}
                    </div>
                    <div className="p-2 text-xs truncate" title={r.fileName}>
                      {r.fileName}
                    </div>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDeleteReceipt(r.id)}
                    className="h-7 w-7 absolute top-1 right-1 bg-background/80 backdrop-blur opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
                    title="Remove attachment"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No attachments yet.</p>
          )}

          <Separator />

          <ReceiptUploader
            value={pendingReceipts}
            onChange={setPendingReceipts}
            label="Add invoice / supporting documents"
            hint="Attach an invoice PDF or photo of the bill."
          />
          {pendingReceipts.length > 0 && (
            <div className="flex justify-end">
              <Button onClick={handleUpload} disabled={createReceipt.isPending}>
                {createReceipt.isPending
                  ? "Uploading…"
                  : `Attach ${pendingReceipts.length} file${pendingReceipts.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <RejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        onConfirm={handleReject}
        isSubmitting={rejectBusy}
      />

      <ReceiptViewer
        file={viewerFile}
        open={viewerFile !== null}
        onOpenChange={(o) => {
          if (!o) setViewerFile(null);
        }}
      />
    </div>
  );
}
