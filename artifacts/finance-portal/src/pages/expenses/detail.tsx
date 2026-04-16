import { useState } from "react";
import { useRoute, Link } from "wouter";
import {
  useGetExpense,
  useApproveExpense,
  useRejectExpense,
  useUpdateExpense,
  useCreateReceipt,
  useListReceipts,
  getGetExpenseQueryKey,
  getListReceiptsQueryKey,
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
} from "lucide-react";
import { format } from "date-fns";
import { RejectDialog } from "@/components/reject-dialog";
import { ReceiptUploader, type PendingReceipt } from "@/components/receipt-uploader";
import { ReceiptViewer, type ReceiptViewerFile } from "@/components/receipt-viewer";
import { FileBox } from "lucide-react";

export default function ExpenseDetail() {
  const [, params] = useRoute("/expenses/:id");
  const id = params?.id ? parseInt(params.id) : 0;
  const [rejectOpen, setRejectOpen] = useState(false);
  const [resubmitReceipts, setResubmitReceipts] = useState<PendingReceipt[]>([]);
  const [viewerFile, setViewerFile] = useState<ReceiptViewerFile | null>(null);

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

      {linkedReceipts && linkedReceipts.items.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Attached Receipts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {linkedReceipts.items.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() =>
                    setViewerFile({
                      fileUrl: r.fileUrl,
                      fileName: r.fileName,
                      fileType: r.fileType,
                    })
                  }
                  className="group block text-left rounded-md border overflow-hidden hover:shadow-md transition-shadow"
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
              ))}
            </div>
          </CardContent>
        </Card>
      )}

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
