import { useState } from "react";
import { useListReceipts, useGetMissingReceiptsReport } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { Upload, Search, FileBox, AlertTriangle, Link as LinkIcon } from "lucide-react";
import { Empty } from "@/components/ui/empty";
import { Badge } from "@/components/ui/badge";

export default function ReceiptsList() {
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("all");

  const { data: receiptsList, isLoading: receiptsLoading } = useListReceipts(
    search ? { search } : undefined
  );
  
  const { data: missingReceipts, isLoading: missingLoading } = useGetMissingReceiptsReport();

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Receipts</h1>
          <p className="text-muted-foreground mt-1">
            Manage uploaded receipts and identify missing documentation.
          </p>
        </div>
        <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
          <Upload className="mr-2 h-4 w-4" />
          Upload Receipt
        </Button>
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
                {receiptsList && <div className="text-sm text-muted-foreground">{receiptsList.total} total receipts</div>}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {receiptsLoading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 p-6">
                  {[1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} className="h-32 w-full" />)}
                </div>
              ) : receiptsList?.items && receiptsList.items.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 p-6">
                  {receiptsList.items.map((receipt) => (
                    <Card key={receipt.id} className="overflow-hidden hover:shadow-md transition-shadow">
                      <div className="h-32 bg-muted flex items-center justify-center border-b relative">
                        <FileBox className="h-10 w-10 text-muted-foreground/30" />
                        {(receipt.linkedExpenseId || receipt.linkedBillId) && (
                          <div className="absolute top-2 right-2 bg-background/80 backdrop-blur-sm p-1 rounded-md shadow-sm border" title="Linked to transaction">
                            <LinkIcon className="h-3 w-3 text-primary" />
                          </div>
                        )}
                      </div>
                      <CardContent className="p-4 space-y-2">
                        <div className="font-medium truncate" title={receipt.fileName}>{receipt.fileName}</div>
                        <div className="flex items-center justify-between text-sm text-muted-foreground">
                          <span>{receipt.receiptDate ? format(new Date(receipt.receiptDate), "MMM d, yyyy") : "No date"}</span>
                          {receipt.amount && <span className="font-semibold text-foreground">${receipt.amount.toFixed(2)}</span>}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2">
                          {receipt.vendorName && (
                            <Badge variant="secondary" className="text-[10px] font-normal truncate max-w-full">
                              {receipt.vendorName}
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
                    description={search ? `No receipts matching "${search}"` : "Upload receipts to keep them organized here."}
                    action={
                      <Button variant="outline">
                        <Upload className="mr-2 h-4 w-4" /> Upload Receipt
                      </Button>
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
                Expenses and bills that require a receipt to be uploaded before they can be fully processed.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {missingLoading ? (
                <div className="p-6 space-y-4">
                  {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
                </div>
              ) : missingReceipts && missingReceipts.length > 0 ? (
                <div className="divide-y">
                  {missingReceipts.map((item) => (
                    <div key={item.expenseId} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 hover:bg-muted/50 transition-colors">
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
                        <div className="text-lg font-bold">${item.amount.toFixed(2)}</div>
                        <Button variant="outline" size="sm">
                          <Upload className="mr-2 h-3 w-3" /> Attach
                        </Button>
                      </div>
                    </div>
                  ))}
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
    </div>
  );
}
