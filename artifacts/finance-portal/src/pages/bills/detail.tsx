import { useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import {
  useGetBill,
  useApproveBill,
  useResubmitBill,
  useListReceipts,
  useCreateReceipt,
  useListTransactions,
  getGetBillQueryKey,
  getListBillsQueryKey,
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
  Pencil,
  RotateCcw,
  BookOpen,
  RefreshCw,
  Ban,
} from "lucide-react";
import { format } from "date-fns";
import { ReceiptViewer, type ReceiptViewerFile } from "@/components/receipt-viewer";
import { LinkedTransactions } from "@/components/linked-transactions";
import { ReceiptUploader, type PendingReceipt } from "@/components/receipt-uploader";
import { useAuth } from "@/lib/auth";
import { apiJson } from "@/lib/api";

// Task #63 — accounting bridge dual-leg badges & block-reason copy.
// Mirrors the expense bridge but covers two distinct lifecycle legs
// (accrual on approval, payment on bank-link / convert-to-bill).
const ACCOUNTING_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  draft_created: "Draft created",
  posted: "Posted",
  blocked: "Blocked",
  not_applicable: "Not applicable",
};

function AccountingStatusBadge({
  status,
  testid,
}: {
  status?: string | null;
  testid?: string;
}) {
  const label = ACCOUNTING_STATUS_LABEL[status ?? ""] ?? "Pending";
  if (status === "posted")
    return <Badge data-testid={testid}>{label}</Badge>;
  if (status === "blocked")
    return (
      <Badge variant="destructive" data-testid={testid}>
        {label}
      </Badge>
    );
  if (status === "draft_created")
    return (
      <Badge variant="secondary" data-testid={testid}>
        {label}
      </Badge>
    );
  return (
    <Badge variant="outline" data-testid={testid}>
      {label}
    </Badge>
  );
}

const BLOCK_REASON_LABEL: Record<string, string> = {
  missing_category: "No expense category set on this bill.",
  missing_mapping:
    "The bill's category isn't mapped to a chart-of-accounts account.",
  archived_account: "The mapped expense account is archived.",
  non_postable_account: "The mapped account is not postable.",
  missing_ap_account:
    "Default Accounts Payable account is not set in Accounting Settings.",
  missing_cash_account:
    "Default cash account is not set in Accounting Settings.",
  other: "Blocked by an accounting rule.",
};

function humanizeBillBlockReason(reason?: string | null): string {
  if (!reason) return "Blocked by an accounting rule.";
  return BLOCK_REASON_LABEL[reason] ?? reason.replace(/_/g, " ");
}

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
  const resubmitBill = useResubmitBill();
  const createReceipt = useCreateReceipt();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetBillQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
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

  const handleResubmit = async () => {
    if (!bill) return;
    try {
      // Attach any newly uploaded invoices/receipts before flipping the bill
      // back to submitted, mirroring the expense resubmit flow.
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
      await resubmitBill.mutateAsync({ id });
      toast({ title: "Bill resubmitted for approval" });
      setPendingReceipts([]);
      refresh();
    } catch (e) {
      toast({
        title: "Failed to resubmit",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
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

  const handleRegenerateAccounting = async (
    eventType: "accrual" | "payment",
  ) => {
    try {
      await apiJson(`/bills/${id}/regenerate-accounting-draft`, {
        method: "POST",
        body: { eventType },
      });
      toast({ title: "Accounting draft regenerated" });
      refresh();
    } catch (e) {
      toast({
        title: "Could not regenerate",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const handleMarkNotApplicable = async (
    eventType: "accrual" | "payment",
  ) => {
    // Task #63 — the API requires a 3–500 char justification note. Use a
    // simple prompt() so we don't need to bolt on a Dialog component on
    // the bill detail page (the blocked-bills queue already has a richer
    // textarea-based dialog for bulk operations).
    const note = window.prompt(
      `Mark the ${eventType} entry as not applicable?\n\n` +
        `Add a short note (3–500 characters) explaining why. ` +
        `It will be recorded in the audit log.`,
      "",
    );
    if (note === null) return;
    const trimmed = note.trim();
    if (trimmed.length < 3 || trimmed.length > 500) {
      toast({
        title: "Note required",
        description: "Please provide a 3–500 character explanation.",
        variant: "destructive",
      });
      return;
    }
    try {
      await apiJson(`/bills/${id}/mark-accounting-not-applicable`, {
        method: "POST",
        body: { eventType, note: trimmed },
      });
      toast({ title: "Marked as not applicable" });
      refresh();
    } catch (e) {
      toast({
        title: "Could not update",
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
  const RECEIPT_DELETABLE_BILL_STATUSES = new Set([
    "draft",
    "submitted",
    "needs_correction",
  ]);
  const canDeleteReceipt = (uploadedBy?: number): boolean => {
    if (isAdmin) return true;
    if (!user || uploadedBy !== user.id) return false;
    return RECEIPT_DELETABLE_BILL_STATUSES.has(bill.status);
  };
  const submitterName = user ? `${user.firstName} ${user.lastName}` : "";
  // Match the backend: prefer the immutable email captured at submission
  // time, and only fall back to display-name matching for legacy bills
  // that were created before the email column existed.
  const isOwner = bill.submittedByEmail
    ? !!user?.email &&
      user.email.toLowerCase() === bill.submittedByEmail.toLowerCase()
    : !!bill.submittedBy && bill.submittedBy === submitterName;
  const isNeedsCorrection = bill.status === "needs_correction";
  const canResubmit = isNeedsCorrection && (isOwner || isAdmin);

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

        <div className="flex items-center gap-2 flex-wrap">
          {canResubmit && (
            <>
              <Link href={`/bills/${bill.id}/edit`}>
                <Button variant="outline">
                  <Pencil className="mr-2 h-4 w-4" /> Edit
                </Button>
              </Link>
              <Button
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                onClick={handleResubmit}
                disabled={resubmitBill.isPending || createReceipt.isPending}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                {resubmitBill.isPending || createReceipt.isPending
                  ? "Resubmitting…"
                  : "Resubmit for Approval"}
              </Button>
            </>
          )}
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
        <Card
          className={
            isNeedsCorrection
              ? "border-warning/40 bg-warning/10"
              : "border-destructive/40 bg-destructive/5"
          }
        >
          <CardContent className="py-4">
            <div
              className={
                isNeedsCorrection
                  ? "text-sm font-semibold text-warning"
                  : "text-sm font-semibold text-destructive"
              }
            >
              {isNeedsCorrection
                ? "Sent back for correction"
                : "Rejection reason"}
            </div>
            <div className="text-sm mt-1">{bill.rejectionReason}</div>
            {canResubmit && (
              <div className="mt-4 space-y-3">
                <div className="text-sm font-medium">
                  Add a fixed invoice or supporting document and resubmit
                </div>
                <ReceiptUploader
                  value={pendingReceipts}
                  onChange={setPendingReceipts}
                  label=""
                  hint="Optional — upload a corrected invoice or receipt before resubmitting."
                />
                <Button
                  onClick={handleResubmit}
                  disabled={resubmitBill.isPending || createReceipt.isPending}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {resubmitBill.isPending || createReceipt.isPending
                    ? "Resubmitting…"
                    : "Resubmit for Approval"}
                </Button>
              </div>
            )}
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

          {/*
            Task #63 — Accounting bridge card. Bills have two
            independent legs: an accrual entry on approval (Dr expense
            / Cr A/P) and a payment entry on bank-link or convert-to-
            bill (Dr A/P / Cr cash). Each has its own status, block
            reason, and admin actions.
          */}
          <Card data-testid="card-accounting-bridge">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-4 w-4" />
                Accounting Bridge
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5 text-sm">
              {(["accrual", "payment"] as const).map((leg) => {
                const status =
                  leg === "accrual"
                    ? bill.accountingStatus
                    : bill.accountingPaymentStatus;
                const reason =
                  leg === "accrual"
                    ? bill.accountingBlockReason
                    : bill.accountingPaymentBlockReason;
                const generatedAt =
                  leg === "accrual"
                    ? bill.accountingGeneratedAt
                    : bill.accountingPaymentGeneratedAt;
                const legLabel =
                  leg === "accrual"
                    ? "Accrual (Dr Expense / Cr A/P)"
                    : "Payment (Dr A/P / Cr Cash)";
                // Task #63 — admins *and* approvers may retry / mark a leg
                // not applicable; this matches the operator surface gating
                // used elsewhere in the bill detail page (canDecide).
                const canAct =
                  canDecide && status !== "posted" && status !== "not_applicable";
                return (
                  <div key={leg} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-muted-foreground">{legLabel}</div>
                      <AccountingStatusBadge
                        status={status}
                        testid={`badge-accounting-${leg}`}
                      />
                    </div>
                    {status === "blocked" && reason && (
                      <div
                        className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive"
                        data-testid={`text-accounting-${leg}-block-reason`}
                      >
                        {humanizeBillBlockReason(reason)}
                      </div>
                    )}
                    {generatedAt && (
                      <div className="text-xs text-muted-foreground">
                        Last attempted{" "}
                        {format(new Date(generatedAt), "MMM d, yyyy")}
                      </div>
                    )}
                    {/*
                      Task #63 — surface linked draft / posted JE per leg
                      so reviewers can deep-link without leaving the page.
                      `accountingBridge` is a passthrough field appended
                      by the bill detail endpoint and not declared in the
                      generated openapi types — we read it via cast.
                    */}
                    {(() => {
                      const bridge =
                        (bill as { accountingBridge?: Record<string, {
                          draftId: number | null;
                          draftStatus: string | null;
                          journalEntryId: number | null;
                          journalEntryStatus: string | null;
                        }> }).accountingBridge?.[leg];
                      if (!bridge) return null;
                      if (
                        bridge.journalEntryId == null &&
                        bridge.draftId == null
                      ) {
                        return null;
                      }
                      return (
                        <div
                          className="flex flex-wrap items-center gap-2 pt-1 text-xs"
                          data-testid={`bridge-links-${leg}`}
                        >
                          {bridge.journalEntryId != null && (
                            <Link
                              href={`/accounting/journal-entries/${bridge.journalEntryId}`}
                              className="rounded-md border bg-muted px-2 py-1 hover:underline"
                              data-testid={`link-bridge-je-${leg}`}
                            >
                              JE #{bridge.journalEntryId}
                              {bridge.journalEntryStatus
                                ? ` · ${bridge.journalEntryStatus}`
                                : ""}
                            </Link>
                          )}
                          {bridge.draftId != null &&
                            bridge.journalEntryId == null && (
                              <Link
                                href={`/accounting/journal-entry-drafts/${bridge.draftId}`}
                                className="rounded-md border bg-muted px-2 py-1 hover:underline"
                                data-testid={`link-bridge-draft-${leg}`}
                              >
                                Draft #{bridge.draftId}
                                {bridge.draftStatus
                                  ? ` · ${bridge.draftStatus}`
                                  : ""}
                              </Link>
                            )}
                        </div>
                      );
                    })()}
                    {canAct && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRegenerateAccounting(leg)}
                          data-testid={`button-regenerate-${leg}`}
                        >
                          <RefreshCw className="mr-1.5 h-3 w-3" />
                          Regenerate
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleMarkNotApplicable(leg)}
                          data-testid={`button-not-applicable-${leg}`}
                        >
                          <Ban className="mr-1.5 h-3 w-3" />
                          Mark not applicable
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
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
                    <div className="p-2 space-y-0.5">
                      <div className="text-xs truncate" title={r.fileName}>
                        {r.fileName}
                      </div>
                      <div
                        className="text-[10px] text-muted-foreground truncate"
                        title={`Uploaded by ${r.uploadedByName ?? "Unknown"} on ${format(new Date(r.createdAt), "MMM d, yyyy")}`}
                      >
                        By {r.uploadedByName ?? "Unknown"} ·{" "}
                        {format(new Date(r.createdAt), "MMM d, yyyy")}
                      </div>
                    </div>
                  </button>
                  {canDeleteReceipt(r.uploadedBy) && (
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
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No attachments yet.</p>
          )}

          {!canResubmit && (
            <>
              <Separator />

              <ReceiptUploader
                value={pendingReceipts}
                onChange={setPendingReceipts}
                label="Add invoice / supporting documents"
                hint="Attach an invoice PDF or photo of the bill."
              />
              {pendingReceipts.length > 0 && (
                <div className="flex justify-end">
                  <Button
                    onClick={handleUpload}
                    disabled={createReceipt.isPending}
                  >
                    {createReceipt.isPending
                      ? "Uploading…"
                      : `Attach ${pendingReceipts.length} file${pendingReceipts.length === 1 ? "" : "s"}`}
                  </Button>
                </div>
              )}
            </>
          )}
          {canResubmit && (
            <p className="text-xs text-muted-foreground">
              To add a new invoice or receipt, use the upload area in the
              "Sent back for correction" notice above. Your file will be
              attached when you resubmit.
            </p>
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
