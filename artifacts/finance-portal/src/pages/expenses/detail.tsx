import { useRef, useState } from "react";
import { useUpload } from "@workspace/object-storage-web";
import { useRoute, Link } from "wouter";
import {
  useGetExpense,
  useApproveExpense,
  useRejectExpense,
  useUpdateExpense,
  useCreateReceipt,
  useListReceipts,
  useDeleteExpense,
  useDeleteReceipt,
  useDismissExpenseDuplicate,
  getGetExpenseQueryKey,
  getListReceiptsQueryKey,
  getListExpensesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Check,
  X,
  Building,
  Calendar,
  CreditCard,
  Tag,
  FileText,
  User,
  RotateCcw,
  Pencil,
  Send,
  AlertTriangle,
  Trash2,
  Replace,
  Plus,
} from "lucide-react";
import { format } from "date-fns";
import { RejectDialog } from "@/components/reject-dialog";
import { ReceiptUploader, type PendingReceipt } from "@/components/receipt-uploader";
import { ReceiptViewer, type ReceiptViewerFile } from "@/components/receipt-viewer";
import { LinkedTransactions } from "@/components/linked-transactions";
import { FileBox } from "lucide-react";
import { useAuth } from "@/lib/auth";

const RECEIPT_DELETABLE_EXPENSE_STATUSES = new Set([
  "draft",
  "submitted",
  "needs_correction",
]);

export default function ExpenseDetail() {
  const [, params] = useRoute("/expenses/:id");
  const id = params?.id ? parseInt(params.id) : 0;
  const [rejectOpen, setRejectOpen] = useState(false);
  const [resubmitReceipts, setResubmitReceipts] = useState<PendingReceipt[]>([]);
  const [viewerFile, setViewerFile] = useState<ReceiptViewerFile | null>(null);
  const { user } = useAuth();

  const { data: expense, isLoading } = useGetExpense(id, {
    query: { enabled: !!id, queryKey: getGetExpenseQueryKey(id) },
  });
  const { data: linkedReceipts } = useListReceipts(
    { linkedExpenseId: id },
    { query: { enabled: !!id, queryKey: getListReceiptsQueryKey({ linkedExpenseId: id }) } },
  );

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const approveExpense = useApproveExpense();
  const rejectExpense = useRejectExpense();
  const updateExpense = useUpdateExpense();
  const createReceipt = useCreateReceipt();
  const deleteExpense = useDeleteExpense();
  const deleteReceipt = useDeleteReceipt();
  const dismissDuplicate = useDismissExpenseDuplicate();
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const [replacingId, setReplacingId] = useState<number | null>(null);
  const { uploadFile } = useUpload({
    onError: (e) => toast({ title: e.message, variant: "destructive" }),
  });

  const invalidateReceipts = () => {
    queryClient.invalidateQueries({
      queryKey: getListReceiptsQueryKey({ linkedExpenseId: id }),
    });
    refetch();
  };

  const handleAddReceipt = async (file: File) => {
    if (!expense) return;
    const result = await uploadFile(file);
    if (!result) return;
    try {
      await createReceipt.mutateAsync({
        data: {
          fileName: file.name,
          fileType: file.type || "application/octet-stream",
          fileUrl: result.objectPath,
          linkedExpenseId: expense.id,
          amount: expense.amount,
          receiptDate: expense.expenseDate,
        },
      });
      toast({ title: "Receipt added" });
      invalidateReceipts();
    } catch {
      toast({ title: "Failed to add receipt", variant: "destructive" });
    }
  };

  const handleDeleteReceipt = async (receiptId: number) => {
    if (!confirm("Delete this receipt? This cannot be undone.")) return;
    try {
      await deleteReceipt.mutateAsync({ id: receiptId });
      toast({ title: "Receipt deleted" });
      invalidateReceipts();
    } catch {
      toast({ title: "Failed to delete receipt", variant: "destructive" });
    }
  };

  const handleReplaceClick = (receiptId: number) => {
    setReplacingId(receiptId);
    replaceInputRef.current?.click();
  };

  const handleReplaceFile = async (files: FileList | null) => {
    const file = files?.[0];
    const targetId = replacingId;
    if (replaceInputRef.current) replaceInputRef.current.value = "";
    setReplacingId(null);
    if (!file || !targetId || !expense) return;
    const result = await uploadFile(file);
    if (!result) return;
    try {
      // Create the new receipt first so the old one is only removed once the
      // replacement is safely persisted. Avoids losing the receipt if the
      // create call fails.
      await createReceipt.mutateAsync({
        data: {
          fileName: file.name,
          fileType: file.type || "application/octet-stream",
          fileUrl: result.objectPath,
          linkedExpenseId: expense.id,
          amount: expense.amount,
          receiptDate: expense.expenseDate,
        },
      });
      await deleteReceipt.mutateAsync({ id: targetId });
      toast({ title: "Receipt replaced" });
      invalidateReceipts();
    } catch {
      toast({ title: "Failed to replace receipt", variant: "destructive" });
      invalidateReceipts();
    }
  };

  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: getGetExpenseQueryKey(id) });

  const handleApprove = async () => {
    try {
      await approveExpense.mutateAsync({
        id,
        data: { approvedBy: "Finance Manager", notes: "Looks good" },
      });
      toast({ title: "Expense approved" });
      refetch();
    } catch {
      toast({ title: "Failed to approve", variant: "destructive" });
    }
  };

  const handleReject = async (data: {
    reason: string;
    action: "send_back" | "close";
  }) => {
    try {
      await rejectExpense.mutateAsync({
        id,
        data: { rejectedBy: "Finance Manager", ...data },
      });
      toast({
        title:
          data.action === "send_back"
            ? "Sent back to submitter"
            : "Expense rejected",
      });
      setRejectOpen(false);
      refetch();
    } catch {
      toast({ title: "Failed to reject", variant: "destructive" });
    }
  };

  const handleResubmit = async () => {
    if (!expense) return;
    try {
      // Attach any newly uploaded receipts.
      for (const r of resubmitReceipts) {
        await createReceipt.mutateAsync({
          data: {
            fileName: r.file.name,
            fileType: r.contentType,
            fileUrl: r.objectPath,
            linkedExpenseId: expense.id,
            amount: expense.amount,
            receiptDate: expense.expenseDate,
          },
        });
      }
      // Move back into the queue as 'submitted'.
      await updateExpense.mutateAsync({
        id: expense.id,
        data: { status: "submitted" },
      });
      toast({ title: "Resubmitted for approval" });
      setResubmitReceipts([]);
      refetch();
    } catch {
      toast({ title: "Failed to resubmit", variant: "destructive" });
    }
  };

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

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!expense) {
    return <div>Expense not found</div>;
  }

  const isNeedsCorrection = expense.status === "needs_correction";
  const isSubmitted = expense.status === "submitted";
  const isDraft = expense.status === "draft";
  const isAdmin = user?.role === "admin";
  const canDeleteReceipt = (uploadedBy?: number): boolean => {
    if (isAdmin) return true;
    if (!user || uploadedBy !== user.id) return false;
    return RECEIPT_DELETABLE_EXPENSE_STATUSES.has(expense.status);
  };

  const handleDismissDuplicate = async () => {
    try {
      await dismissDuplicate.mutateAsync({ id: expense.id });
      toast({ title: "Marked as not a duplicate" });
      refetch();
      queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey() });
    } catch {
      toast({ title: "Failed to dismiss", variant: "destructive" });
    }
  };

  const handleDeleteAsDuplicate = async () => {
    try {
      await deleteExpense.mutateAsync({ id: expense.id });
      toast({ title: "Duplicate expense deleted" });
      queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey() });
      window.location.href = `${import.meta.env.BASE_URL}expenses`;
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  };

  const handleSubmitDraft = async () => {
    try {
      await updateExpense.mutateAsync({
        id: expense.id,
        data: { status: "submitted" },
      });
      toast({ title: "Expense submitted for approval" });
      refetch();
    } catch {
      toast({ title: "Failed to submit expense", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Link href="/expenses">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold tracking-tight">
                Expense #{expense.id}
              </h1>
              <Badge className={getStatusColor(expense.status)}>
                {expense.status.replace("_", " ").toUpperCase()}
              </Badge>
              {(expense.categoryId == null || expense.categoryName === "Uncategorized") && (
                <Badge
                  variant="outline"
                  className="bg-warning/10 text-warning border-warning/40"
                  data-testid="badge-uncategorized"
                >
                  Uncategorized
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-1">
              Submitted on {format(new Date(expense.createdAt), "MMMM d, yyyy")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Link href={`/expenses/${expense.id}/edit`}>
            <Button variant="outline">
              <Pencil className="mr-2 h-4 w-4" /> Edit
            </Button>
          </Link>
          {isDraft && (
            <Button
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
              onClick={handleSubmitDraft}
              disabled={updateExpense.isPending}
            >
              <Send className="mr-2 h-4 w-4" />
              {updateExpense.isPending ? "Submitting…" : "Submit for Approval"}
            </Button>
          )}
          {isSubmitted && (
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
              >
                <Check className="mr-2 h-4 w-4" /> Approve
              </Button>
            </>
          )}
        </div>
      </div>

      {expense.potentialDuplicateIds && expense.potentialDuplicateIds.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
            <div className="flex-1 space-y-2">
              <div className="font-semibold text-warning">
                Potential duplicate detected
              </div>
              <div className="text-sm">
                This expense has the same date and amount as{" "}
                {expense.potentialDuplicateIds.length === 1 ? "another expense" : "other expenses"}:
                {" "}
                {expense.potentialDuplicateIds.map((dupId, i) => (
                  <span key={dupId}>
                    {i > 0 && ", "}
                    <Link href={`/expenses/${dupId}`} className="font-medium underline">
                      Expense #{dupId}
                    </Link>
                  </span>
                ))}
                . Please confirm whether this is a duplicate.
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDismissDuplicate}
                  disabled={dismissDuplicate.isPending}
                >
                  Not a duplicate
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive border-destructive hover:bg-destructive/10"
                  onClick={handleDeleteAsDuplicate}
                  disabled={deleteExpense.isPending}
                >
                  <Trash2 className="mr-2 h-3 w-3" />
                  Delete this expense
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Expense Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Building className="h-4 w-4" /> Merchant
                </div>
                <div className="font-semibold text-lg">{expense.merchant}</div>
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Calendar className="h-4 w-4" /> Date
                </div>
                <div className="font-semibold text-lg">
                  {format(new Date(expense.expenseDate), "MMM d, yyyy")}
                </div>
              </div>
            </div>

            <Separator />

            <div className="space-y-1">
              <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <FileText className="h-4 w-4" /> Description
              </div>
              <div>{expense.description}</div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Tag className="h-4 w-4" /> Program
                </div>
                <div>{expense.programName || "General Fund"}</div>
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <CreditCard className="h-4 w-4" /> Payment Method
                </div>
                <div className="capitalize">
                  {expense.paymentMethod.replace("_", " ")}
                </div>
              </div>
            </div>

            {expense.rejectionReason && (
              <>
                <Separator />
                <div
                  className={`p-4 rounded-md ${
                    isNeedsCorrection
                      ? "bg-warning/10 border border-warning/30"
                      : "bg-destructive/10"
                  }`}
                >
                  <div
                    className={`font-semibold mb-1 ${
                      isNeedsCorrection ? "text-warning" : "text-destructive"
                    }`}
                  >
                    {isNeedsCorrection
                      ? "Sent back for correction"
                      : "Rejection Reason"}
                  </div>
                  <div className="text-sm">{expense.rejectionReason}</div>
                </div>
              </>
            )}

            {isNeedsCorrection && (
              <>
                <Separator />
                <div className="space-y-3">
                  <div className="text-sm font-medium">
                    Add a missing receipt and resubmit
                  </div>
                  <ReceiptUploader
                    value={resubmitReceipts}
                    onChange={setResubmitReceipts}
                    label=""
                    hint="Optional — upload a clearer or replacement receipt before resubmitting."
                  />
                  <Button
                    onClick={handleResubmit}
                    disabled={updateExpense.isPending}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    {updateExpense.isPending ? "Resubmitting…" : "Resubmit for Approval"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle>Amount</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold">
                ${expense.amount.toFixed(2)}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle>Submitter</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <div className="bg-muted p-2 rounded-full">
                  <User className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <div className="font-medium">{expense.submittedBy}</div>
                  {expense.submittedByEmail && (
                    <div className="text-sm text-muted-foreground">
                      {expense.submittedByEmail}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <LinkedTransactions expenseId={id} />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Attached Receipts</CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addInputRef.current?.click()}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Receipt
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <input
            ref={addInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (e.target) e.target.value = "";
              if (file) await handleAddReceipt(file);
            }}
          />
          <input
            ref={replaceInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => handleReplaceFile(e.target.files)}
          />
          {linkedReceipts && linkedReceipts.items.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {linkedReceipts.items.map((r) => (
                <div
                  key={r.id}
                  className="group rounded-md border overflow-hidden hover:shadow-md transition-shadow flex flex-col"
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
                    className="block text-left"
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
                    <div className="border-t flex">
                      <button
                        type="button"
                        onClick={() => handleReplaceClick(r.id)}
                        className="flex-1 px-2 py-1.5 text-xs hover:bg-muted flex items-center justify-center gap-1"
                      >
                        <Replace className="h-3 w-3" />
                        Replace
                      </button>
                      <div className="w-px bg-border" />
                      <button
                        type="button"
                        onClick={() => handleDeleteReceipt(r.id)}
                        className="flex-1 px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 flex items-center justify-center gap-1"
                      >
                        <Trash2 className="h-3 w-3" />
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No receipts attached. Use "Add Receipt" above to upload one.
            </div>
          )}
        </CardContent>
      </Card>

      <ReceiptViewer
        file={viewerFile}
        open={viewerFile !== null}
        onOpenChange={(o) => {
          if (!o) setViewerFile(null);
        }}
      />

      <RejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        onConfirm={handleReject}
        isSubmitting={rejectExpense.isPending}
      />
    </div>
  );
}
