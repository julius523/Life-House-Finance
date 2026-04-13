import { useState } from "react";
import { Link } from "wouter";
import { useListBills } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { Plus, FileText, Filter, Calendar } from "lucide-react";
import { Empty } from "@/components/ui/empty";

export default function BillsList() {
  const [status, setStatus] = useState<string>("all");
  
  const { data: billsList, isLoading } = useListBills(
    status !== "all" ? { status: status as any } : undefined
  );

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'approved': return 'bg-info text-info-foreground';
      case 'paid': return 'bg-success text-success-foreground';
      case 'overdue': return 'bg-destructive text-destructive-foreground';
      case 'submitted': return 'bg-primary text-primary-foreground';
      default: return 'bg-secondary text-secondary-foreground';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Vendor Bills</h1>
          <p className="text-muted-foreground mt-1">
            Manage incoming invoices and accounts payable.
          </p>
        </div>
        <Link href="/bills/new">
          <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
            <Plus className="mr-2 h-4 w-4" />
            New Bill
          </Button>
        </Link>
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
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="submitted">Submitted</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="overdue">Overdue</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {billsList && <div className="text-sm text-muted-foreground">{billsList.total} total bills</div>}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : billsList && (Array.isArray(billsList) ? billsList : (billsList as any)?.items ?? []).length > 0 ? (
            <div className="divide-y">
              {(Array.isArray(billsList) ? billsList : (billsList as any)?.items ?? []).map((bill: any) => (
                <Link key={bill.id} href={`/bills/${bill.id}`}>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 hover:bg-muted/50 transition-colors cursor-pointer group">
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2">
                        <span className="font-semibold text-foreground group-hover:text-primary transition-colors">
                          {bill.vendorName}
                        </span>
                        <Badge className={getStatusColor(bill.status)} variant="outline">
                          {bill.status}
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground flex items-center gap-2">
                        <span>Invoice {bill.invoiceNumber || "N/A"}</span>
                        <span>•</span>
                        <span className="flex items-center">
                           <Calendar className="h-3 w-3 mr-1" /> Due {format(new Date(bill.dueDate), "MMM d, yyyy")}
                        </span>
                      </div>
                      {bill.programName && (
                        <div className="text-xs text-muted-foreground">
                          Program: {bill.programName}
                        </div>
                      )}
                    </div>
                    <div className="mt-4 sm:mt-0 text-right">
                      <div className="text-lg font-bold">${bill.amount.toFixed(2)}</div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="p-12">
              <Empty
                icon={FileText}
                title="No bills found"
                description={status !== "all" ? `No bills match the status "${status}".` : "There are no vendor bills recorded yet."}
                action={
                  <Link href="/bills/new">
                    <Button variant="outline">Create your first bill</Button>
                  </Link>
                }
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
