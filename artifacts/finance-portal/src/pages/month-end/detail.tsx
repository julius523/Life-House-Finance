import { useRoute, Link } from "wouter";
import { 
  useGetMonthEndChecklist, 
  useUpdateMonthEndChecklist,
  getGetMonthEndChecklistQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, CalendarCheck, CheckCircle2 } from "lucide-react";

export default function MonthEndDetail() {
  const [, params] = useRoute("/month-end/:id");
  const id = params?.id ? parseInt(params.id) : 0;
  
  const { data: checklist, isLoading } = useGetMonthEndChecklist(id, { 
    query: { enabled: !!id, queryKey: getGetMonthEndChecklistQueryKey(id) } 
  });

  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const updateChecklist = useUpdateMonthEndChecklist();

  const handleToggleItem = async (itemId: number, currentStatus: boolean) => {
    if (!checklist) return;

    try {
      const items = checklist.items.map(item => 
        item.id === itemId 
          ? { id: item.id, isCompleted: !currentStatus, completedBy: !currentStatus ? "Current User" : undefined }
          : { id: item.id, isCompleted: item.isCompleted, completedBy: item.completedBy, notes: item.notes }
      );

      // Check if all items are completed
      const allCompleted = items.every(item => item.isCompleted);
      const newStatus = allCompleted ? "completed" : "in_progress";

      await updateChecklist.mutateAsync({ 
        id, 
        data: { 
          items,
          status: newStatus
        } 
      });
      
      // We don't want a toast for every single checkbox click, it gets annoying.
      // But we invalidate queries to refresh the data
      queryClient.invalidateQueries({ queryKey: getGetMonthEndChecklistQueryKey(id) });
    } catch (e) {
      toast({ title: "Failed to update item", variant: "destructive" });
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-success text-success-foreground';
      case 'in_progress': return 'bg-info text-info-foreground';
      case 'open': return 'bg-secondary text-secondary-foreground';
      default: return 'bg-secondary text-secondary-foreground';
    }
  };

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>;
  }

  if (!checklist) {
    return <div>Checklist not found</div>;
  }

  const percentComplete = checklist.totalCount > 0 
    ? Math.round((checklist.completedCount / checklist.totalCount) * 100) 
    : 0;

  // Group items by category
  const groupedItems = checklist.items.reduce((acc, item) => {
    if (!acc[item.category]) {
      acc[item.category] = [];
    }
    acc[item.category].push(item);
    return acc;
  }, {} as Record<string, typeof checklist.items>);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Link href="/month-end">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold tracking-tight">Close: {checklist.month}</h1>
              <Badge className={getStatusColor(checklist.status)}>{checklist.status.replace('_', ' ').toUpperCase()}</Badge>
            </div>
            <p className="text-muted-foreground mt-1">
              FY {checklist.fiscalYear} • Owner: {checklist.owner || "Unassigned"}
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold flex items-center gap-2">
              <CalendarCheck className="h-5 w-5 text-primary" />
              Overall Progress
            </div>
            <div className="font-medium text-muted-foreground">
              {percentComplete}% ({checklist.completedCount}/{checklist.totalCount})
            </div>
          </div>
          <Progress value={percentComplete} className="h-3" />
        </CardContent>
      </Card>

      <div className="space-y-6">
        {Object.entries(groupedItems).map(([category, items]) => {
          const categoryCompleted = items.filter(i => i.isCompleted).length;
          const categoryTotal = items.length;
          
          return (
            <Card key={category}>
              <CardHeader className="pb-3 border-b bg-muted/20">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{category}</CardTitle>
                  <div className="text-sm font-medium text-muted-foreground">
                    {categoryCompleted} / {categoryTotal}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y">
                  {items.map(item => (
                    <div 
                      key={item.id} 
                      className={`flex items-start gap-4 p-4 transition-colors ${item.isCompleted ? 'bg-muted/10' : 'hover:bg-muted/30'}`}
                    >
                      <Checkbox 
                        id={`item-${item.id}`} 
                        checked={item.isCompleted} 
                        onCheckedChange={() => handleToggleItem(item.id, item.isCompleted)}
                        className="mt-1"
                      />
                      <div className="flex-1 space-y-1">
                        <label 
                          htmlFor={`item-${item.id}`} 
                          className={`font-medium cursor-pointer ${item.isCompleted ? 'line-through text-muted-foreground' : ''}`}
                        >
                          {item.label}
                        </label>
                        {item.isCompleted && item.completedBy && (
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3 text-success" />
                            Completed by {item.completedBy}
                          </div>
                        )}
                        {item.notes && (
                          <div className="text-sm text-muted-foreground mt-1">
                            {item.notes}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
