import { useRoute, Link } from "wouter";
import { 
  useGetBill, 
  useApproveBill,
  getGetBillQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Check, Building2, Calendar, FileText, Tag } from "lucide-react";
import { format } from "date-fns";

export default function BillDetail() {
  const [, params] = useRoute("/bills/:id");
  const id = params?.id ? parseInt(params.id) : 0;
  
  const { data: bill, isLoading } = useGetBill(id, { 
    query: { enabled: !!id, queryKey: getGetBillQueryKey(id) } 
  });

  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const approveBill = useApproveBill();

  const handleApprove = async () => {
    try {
      await approveBill.mutateAsync({ 
        id, 
        data: { approvedBy: "Finance Manager", notes: "Approved for payment" } 
      });
      toast({ title: "Bill approved" });
      queryClient.invalidateQueries({ queryKey: getGetBillQueryKey(id) });
    } catch (e) {
      toast({ title: "Failed to approve", variant: "destructive" });
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'approved': return 'bg-info text-info-foreground';
      case 'paid': return 'bg-success text-success-foreground';
      case 'overdue': return 'bg-destructive text-destructive-foreground';
      case 'submitted': return 'bg-primary text-primary-foreground';
      default: return 'bg-secondary text-secondary-foreground';
    }
  };

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>;
  }

  if (!bill) {
    return <div>Bill not found</div>;
  }

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
              <Badge className={getStatusColor(bill.status)}>{bill.status.toUpperCase()}</Badge>
            </div>
            <p className="text-muted-foreground mt-1">
              Created on {format(new Date(bill.createdAt), "MMMM d, yyyy")}
            </p>
          </div>
        </div>
        
        {bill.status === "submitted" && (
          <div className="flex items-center gap-2">
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={handleApprove} disabled={approveBill.isPending}>
              <Check className="mr-2 h-4 w-4" /> {approveBill.isPending ? "Approving..." : "Approve Bill"}
            </Button>
          </div>
        )}
      </div>

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
                <div className="font-semibold text-lg">{bill.invoiceNumber || "N/A"}</div>
              </div>
            </div>
            
            <Separator />

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Calendar className="h-4 w-4" /> Invoice Date
                </div>
                <div>{bill.invoiceDate ? format(new Date(bill.invoiceDate), "MMM d, yyyy") : "N/A"}</div>
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-destructive" /> Due Date
                </div>
                <div className="font-medium text-destructive">{format(new Date(bill.dueDate), "MMM d, yyyy")}</div>
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
    </div>
  );
}
