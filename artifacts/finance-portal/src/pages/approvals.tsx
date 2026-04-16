import { useState } from "react";
import { 
  useListApprovals, 
  useApproveExpense, 
  useRejectExpense, 
  useApproveBill,
  getListApprovalsQueryKey
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { Clock, Check, X, CheckSquare, Eye, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Empty } from "@/components/ui/empty";
import { useLocation } from "wouter";
import { apiJson } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function Approvals() {
  const { data: approvals, isLoading } = useListApprovals();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { user } = useAuth();

  const approveExpense = useApproveExpense();
  const rejectExpense = useRejectExpense();
  const approveBill = useApproveBill();

  const handleApprove = async (item: any) => {
    try {
      if (item.type === "expense") {
        await approveExpense.mutateAsync({ 
          id: item.referenceId, 
          data: { approvedBy: "Finance User", notes: "Approved from queue" } 
        });
      } else {
        await approveBill.mutateAsync({ 
          id: item.referenceId, 
          data: { approvedBy: "Finance User", notes: "Approved from queue" } 
        });
      }
      toast({ title: "Item approved", variant: "default" });
      queryClient.invalidateQueries({ queryKey: getListApprovalsQueryKey() });
    } catch (e) {
      toast({ title: "Failed to approve", variant: "destructive" });
    }
  };

  const handleReject = async (item: any) => {
    try {
      if (item.type === "expense") {
        await rejectExpense.mutateAsync({ 
          id: item.referenceId, 
          data: { rejectedBy: "Finance User", reason: "Rejected from queue" } 
        });
        toast({ title: "Item rejected", variant: "default" });
        queryClient.invalidateQueries({ queryKey: getListApprovalsQueryKey() });
      }
    } catch (e) {
      toast({ title: "Failed to reject", variant: "destructive" });
    }
  };

  const urgencyColors = {
    high: "bg-destructive text-destructive-foreground",
    medium: "bg-warning text-warning-foreground",
    low: "bg-secondary text-secondary-foreground"
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Approval Queue</h1>
        <p className="text-muted-foreground mt-1">
          Review and approve pending expenses and bills.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pending Items</CardTitle>
          <CardDescription>Items sorted by urgency and wait time.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map(i => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : approvals && approvals.length > 0 ? (
            <div className="space-y-4">
              {approvals.map(item => (
                <div key={item.id} className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors">
                  <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                      <Badge variant="outline" className="uppercase text-[10px] tracking-wider">
                        {item.type}
                      </Badge>
                      <span className="font-semibold">{item.description}</span>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Submitted by {item.submittedBy} on {format(new Date(item.submittedAt), "MMM d, yyyy")}
                    </div>
                    <div className="flex items-center space-x-2 text-xs">
                      <span className="font-medium text-foreground">${item.amount.toLocaleString()}</span>
                      {item.programName && (
                        <>
                          <span>•</span>
                          <span>{item.programName}</span>
                        </>
                      )}
                      <span>•</span>
                      <Badge className={urgencyColors[item.urgency as keyof typeof urgencyColors]}>
                        {item.urgency} urgency
                      </Badge>
                      <span>•</span>
                      <span className="flex items-center text-muted-foreground">
                        <Clock className="mr-1 h-3 w-3" />
                        {item.daysWaiting} days waiting
                      </span>
                    </div>
                  </div>
                  <div className="mt-4 sm:mt-0 flex items-center gap-2 w-full sm:w-auto flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        navigate(item.type === "expense"
                          ? `/expenses/${item.referenceId}`
                          : `/bills/${item.referenceId}`)
                      }
                      title="View / Edit"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    {user?.role === "admin" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/40 hover:bg-destructive/10"
                        onClick={async () => {
                          if (!confirm(`Delete this ${item.type}? This cannot be undone.`)) return;
                          try {
                            const path = item.type === "expense"
                              ? `/expenses/${item.referenceId}`
                              : `/bills/${item.referenceId}`;
                            await apiJson(path, { method: "DELETE" });
                            toast({ title: "Item deleted" });
                            queryClient.invalidateQueries({ queryKey: getListApprovalsQueryKey() });
                          } catch (e) {
                            toast({ title: "Could not delete", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                    {item.type === "expense" && (
                      <Button variant="outline" size="sm" className="text-destructive border-destructive hover:bg-destructive/10" onClick={() => handleReject(item)}>
                        <X className="mr-2 h-4 w-4" />
                        Reject
                      </Button>
                    )}
                    <Button variant="default" size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => handleApprove(item)}>
                      <Check className="mr-2 h-4 w-4" />
                      Approve
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              icon={CheckSquare}
              title="All caught up!"
              description="There are no pending items requiring your approval right now."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
