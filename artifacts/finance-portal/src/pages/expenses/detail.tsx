import { useRoute, Link } from "wouter";
import { 
  useGetExpense, 
  useApproveExpense, 
  useRejectExpense,
  getGetExpenseQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Check, X, Building, Calendar, CreditCard, Tag, FileText, User } from "lucide-react";
import { format } from "date-fns";

export default function ExpenseDetail() {
  const [, params] = useRoute("/expenses/:id");
  const id = params?.id ? parseInt(params.id) : 0;
  
  const { data: expense, isLoading } = useGetExpense(id, { 
    query: { enabled: !!id, queryKey: getGetExpenseQueryKey(id) } 
  });

  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const approveExpense = useApproveExpense();
  const rejectExpense = useRejectExpense();

  const handleApprove = async () => {
    try {
      await approveExpense.mutateAsync({ 
        id, 
        data: { approvedBy: "Finance Manager", notes: "Looks good" } 
      });
      toast({ title: "Expense approved" });
      queryClient.invalidateQueries({ queryKey: getGetExpenseQueryKey(id) });
    } catch (e) {
      toast({ title: "Failed to approve", variant: "destructive" });
    }
  };

  const handleReject = async () => {
    try {
      await rejectExpense.mutateAsync({ 
        id, 
        data: { rejectedBy: "Finance Manager", reason: "Missing receipt or inadequate description" } 
      });
      toast({ title: "Expense rejected" });
      queryClient.invalidateQueries({ queryKey: getGetExpenseQueryKey(id) });
    } catch (e) {
      toast({ title: "Failed to reject", variant: "destructive" });
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'approved': return 'bg-success text-success-foreground';
      case 'rejected': return 'bg-destructive text-destructive-foreground';
      case 'submitted': return 'bg-info text-info-foreground';
      case 'reimbursed': return 'bg-primary text-primary-foreground';
      default: return 'bg-secondary text-secondary-foreground';
    }
  };

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>;
  }

  if (!expense) {
    return <div>Expense not found</div>;
  }

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
              <h1 className="text-3xl font-bold tracking-tight">Expense #{expense.id}</h1>
              <Badge className={getStatusColor(expense.status)}>{expense.status.toUpperCase()}</Badge>
            </div>
            <p className="text-muted-foreground mt-1">
              Submitted on {format(new Date(expense.createdAt), "MMMM d, yyyy")}
            </p>
          </div>
        </div>
        
        {expense.status === "submitted" && (
          <div className="flex items-center gap-2">
            <Button variant="outline" className="text-destructive border-destructive hover:bg-destructive/10" onClick={handleReject}>
              <X className="mr-2 h-4 w-4" /> Reject
            </Button>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={handleApprove}>
              <Check className="mr-2 h-4 w-4" /> Approve
            </Button>
          </div>
        )}
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
                <div className="font-semibold text-lg">{format(new Date(expense.expenseDate), "MMM d, yyyy")}</div>
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
                <div className="capitalize">{expense.paymentMethod.replace('_', ' ')}</div>
              </div>
            </div>

            {expense.rejectionReason && (
              <>
                <Separator />
                <div className="bg-destructive/10 p-4 rounded-md">
                  <div className="font-semibold text-destructive mb-1">Rejection Reason</div>
                  <div className="text-sm">{expense.rejectionReason}</div>
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
              <div className="text-4xl font-bold">${expense.amount.toFixed(2)}</div>
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
                    <div className="text-sm text-muted-foreground">{expense.submittedByEmail}</div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
