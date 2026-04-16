import { useState } from "react";
import {
  useListReceipts,
  useGetMissingReceiptsReport,
  useCreateReceipt,
  getListReceiptsQueryKey,
  getGetMissingReceiptsReportQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { Upload, Search, FileBox, AlertTriangle, Link as LinkIcon, CheckSquare, Loader2 } from "lucide-react";
import { Empty } from "@/components/ui/empty";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@workspace/object-storage-web";
import { BankStatementImport } from "@/components/bank-statement-import";
import { ReceiptViewer, type ReceiptViewerFile } from "@/components/receipt-viewer";

export default function ReceiptsList() {
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createReceipt = useCreateReceipt();
  const { uploadFile, isUploading } = useUpload();
  const [pendingExpenseId, setPendingExpenseId] = useState<number | null>(null);
  const [viewerFile, setViewerFile] = useState<ReceiptViewerFile | null>(null);

  const { data: receiptsList, isLoading: receiptsLoading } = useListReceipts(
    search ? { search } : undefined,
  );
  const { data: missingReceipts, isLoading: missingLoading } = useGetMissingReceiptsReport();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListReceiptsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetMissingReceiptsReportQueryKey() });
  };

  const handleStandaloneUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const uploaded = await uploadFile(file);
      if (uploaded) {
        await createReceipt.mutateAsync({
          data: {
            fileName: file.name,
            fileType: file.type || "application/octet-stream",
            fileUrl: uploaded.objectPath,
          },
        });
      }
    }
    toast({ title: `${files.length} receipt${files.length === 1 ? "" : "s"} uploaded` });
    refresh();
  };

  const handleAttachToExpense = async (
    expenseId: number,
    files: FileList | null,
    item: { merchant: string; amount: number; expenseDate: string },
  ) => {
    if (!files || files.length === 0) return;
    setPendingExpenseId(expenseId);
    try {
      for (const file of Array.from(files)) {
        const uploaded = await uploadFile(file);
        if (uploaded) {
          await createReceipt.mutateAsync({
            data: {
              fileName: file.name,
              fileType: file.type || "application/octet-stream",
              fileUrl: uploaded.objectPath,
              linkedExpenseId: expenseId,
              amount: item.amount,
              receiptDate: item.expenseDate,
            },
          });
        }
      }
      toast({ title: `Receipt attached to expense #${expenseId}` });
      refresh();
    } finally {
      setPendingExpenseId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Receipts</h1>
          <p className="text-muted-foreground mt-1">
            Manage uploaded receipts and identify missing documentation.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <BankStatementImport />
          <label className="inline-flex">
            <input
              type="file"
              multiple
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                handleStandaloneUpload(e.target.files);
                e.currentTarget.value = "";
              }}
            />
            <Button
              asChild
              className="bg-primary hover:bg-primary/90 text-primary-foreground cursor-pointer"
              disabled={isUploading}
            >
              <span>
                {isUploading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Upload Receipt
              </span>
            </Button>
          </label>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="all">All Receipts</TabsTrigger>
          <TabsTrigger value="missing" className="relative">
            Missing Receipts
            {missingReceipts && missingReceipts.length > 0 && (
              <span className="ml-2 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-[10px] text-destructive-foreground">
                {missingReceipts.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="space-y-4">
          <Card>
            <CardHeader className="pb-4 border-b">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="relative w-full sm:w-72">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search receipts..."
                    className="pl-9"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {receiptsList && (
                  <div className="text-sm text-muted-foreground">
                    {receiptsList.total} total receipts
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {receiptsLoading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 p-6">
                  {[1, 2, 3, 4, 5, 6].map((i) => (
                    <Skeleton key={i} className="h-32 w-full" />
                  ))}
                </div>
              ) : receiptsList?.items && receiptsList.items.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 p-6">
                  {receiptsList.items.map((receipt) => (
                    <Card key={receipt.id} className="overflow-hidden hover:shadow-md transition-shadow">
                      <button
                        type="button"
                        onClick={() =>
                          setViewerFile({
                            fileUrl: receipt.fileUrl,
                            fileName: receipt.fileName,
                            fileType: receipt.fileType,
                          })
                        }
                        className="block w-full text-left"
                      >
                        <div className="h-32 bg-muted flex items-center justify-center border-b relative overflow-hidden">
                          {receipt.fileType?.startsWith("image/") && receipt.fileUrl ? (
                            <img
                              src={`/api/storage/${receipt.fileUrl.replace(/^\/+/, "")}`}
                              alt={receipt.fileName}
                              className="object-cover w-full h-full"
                            />
                          ) : (
                            <FileBox className="h-10 w-10 text-muted-foreground/30" />
                          )}
                          {(receipt.linkedExpenseId || receipt.linkedBillId) && (
                            <div
                              className="absolute top-2 right-2 bg-background/80 backdrop-blur-sm p-1 rounded-md shadow-sm border"
                              title="Linked to transaction"
                            >
                              <LinkIcon className="h-3 w-3 text-primary" />
                            </div>
                          )}
                        </div>
                      </button>
                      <CardContent className="p-4 space-y-2">
                        <div className="font-medium truncate" title={receipt.fileName}>
                          {receipt.fileName}
                        </div>
                        <div className="flex items-center justify-between text-sm text-muted-foreground">
                          <span>
                            {receipt.receiptDate
                              ? format(new Date(receipt.receiptDate), "MMM d, yyyy")
                              : "No date"}
                          </span>
                          {receipt.amount !== undefined && receipt.amount !== null && (
                            <span className="font-semibold text-foreground">
                              ${receipt.amount.toFixed(2)}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2">
                          {receipt.vendorName && (
                            <Badge variant="secondary" className="text-[10px] font-normal truncate max-w-full">
                              {receipt.vendorName}
                            </Badge>
                          )}
                          {receipt.linkedExpenseId && (
                            <Badge variant="outline" className="text-[10px] font-normal">
                              Expense #{receipt.linkedExpenseId}
                            </Badge>
                          )}
                          {receipt.linkedBillId && (
                            <Badge variant="outline" className="text-[10px] font-normal">
                              Bill #{receipt.linkedBillId}
                            </Badge>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <div className="p-12">
                  <Empty
                    icon={FileBox}
                    title="No receipts found"
                    description={
                      search
                        ? `No receipts matching "${search}"`
                        : "Upload receipts to keep them organized here."
                    }
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="missing" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Missing Documentation Report</CardTitle>
              <CardDescription>
                Expenses that require a receipt before they can be fully processed
                (includes items sent back for correction).
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {missingLoading ? (
                <div className="p-6 space-y-4">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : missingReceipts && missingReceipts.length > 0 ? (
                <div className="divide-y">
                  {missingReceipts.map((item) => {
                    const inputId = `attach-${item.expenseId}`;
                    const isBusy = pendingExpenseId === item.expenseId;
                    return (
                      <div
                        key={item.expenseId}
                        className="flex flex-col sm:flex-row sm:items-center justify-between p-4 hover:bg-muted/50 transition-colors"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center space-x-2">
                            <AlertTriangle className="h-4 w-4 text-warning" />
                            <span className="font-semibold text-foreground">
                              {item.merchant}
                            </span>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            Expense #{item.expenseId} submitted by {item.submittedBy}
                          </div>
                          <div className="text-xs text-warning font-medium">
                            {item.daysSinceSubmission} days since submission
                          </div>
                        </div>
                        <div className="mt-4 sm:mt-0 flex items-center justify-between sm:justify-end w-full sm:w-auto space-x-4">
                          <div className="text-lg font-bold">
                            ${item.amount.toFixed(2)}
                          </div>
                          <input
                            id={inputId}
                            type="file"
                            accept="image/*,application/pdf"
                            className="hidden"
                            onChange={(e) =>
                              handleAttachToExpense(
                                item.expenseId,
                                e.target.files,
                                {
                                  merchant: item.merchant,
                                  amount: item.amount,
                                  expenseDate: item.expenseDate,
                                },
                              )
                            }
                          />
                          <label htmlFor={inputId}>
                            <Button
                              asChild
                              variant="outline"
                              size="sm"
                              disabled={isBusy}
                            >
                              <span className="cursor-pointer">
                                {isBusy ? (
                                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                                ) : (
                                  <Upload className="mr-2 h-3 w-3" />
                                )}
                                Attach
                              </span>
                            </Button>
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-12">
                  <Empty
                    icon={CheckSquare}
                    title="All caught up!"
                    description="There are no expenses missing documentation."
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

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
