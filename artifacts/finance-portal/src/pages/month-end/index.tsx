import { useState } from "react";
import { Link } from "wouter";
import { useListMonthEndChecklists, useCreateMonthEndChecklist, getListMonthEndChecklistsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { CalendarCheck, Plus, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Empty } from "@/components/ui/empty";
import { Badge } from "@/components/ui/badge";

const formSchema = z.object({
  month: z.string().min(7, "Month is required (YYYY-MM)"),
  fiscalYear: z.string().min(4, "Fiscal year is required"),
  owner: z.string().optional(),
});

export default function MonthEndList() {
  const [open, setOpen] = useState(false);
  
  const { data: checklists, isLoading } = useListMonthEndChecklists();

  const createChecklist = useCreateMonthEndChecklist();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().toISOString().slice(0, 7);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      month: currentMonth,
      fiscalYear: currentYear.toString(),
      owner: "Finance Team",
    },
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    try {
      await createChecklist.mutateAsync({ data: values });
      toast({ title: "Checklist created successfully" });
      setOpen(false);
      form.reset();
      queryClient.invalidateQueries({ queryKey: getListMonthEndChecklistsQueryKey() });
    } catch (error) {
      toast({ title: "Failed to create checklist", variant: "destructive" });
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Month-End Close</h1>
          <p className="text-muted-foreground mt-1">
            Track and manage monthly accounting close procedures.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Plus className="mr-2 h-4 w-4" />
              New Checklist
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create Close Checklist</DialogTitle>
              <DialogDescription>
                Start a new month-end close process.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="month"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Month</FormLabel>
                      <FormControl>
                        <Input type="month" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="fiscalYear"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Fiscal Year</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="owner"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Owner</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createChecklist.isPending}>
                    {createChecklist.isPending ? "Creating..." : "Create"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full" />)}
            </div>
          ) : checklists && checklists.length > 0 ? (
            <div className="divide-y">
              {checklists.map((checklist) => {
                const percentComplete = checklist.totalCount > 0 
                  ? Math.round((checklist.completedCount / checklist.totalCount) * 100) 
                  : 0;
                  
                return (
                  <Link key={checklist.id} href={`/month-end/${checklist.id}`}>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between p-6 hover:bg-muted/50 transition-colors cursor-pointer group">
                      <div className="flex items-start gap-4">
                        <div className="p-3 bg-muted rounded-lg group-hover:bg-primary/10 transition-colors">
                          <CalendarCheck className="h-6 w-6 text-muted-foreground group-hover:text-primary transition-colors" />
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center space-x-2">
                            <span className="font-semibold text-lg">Close: {checklist.month}</span>
                            <Badge className={getStatusColor(checklist.status)} variant="outline">
                              {checklist.status.replace('_', ' ')}
                            </Badge>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            FY {checklist.fiscalYear} • {checklist.owner || 'Unassigned'}
                          </div>
                        </div>
                      </div>
                      <div className="mt-4 sm:mt-0 flex items-center justify-between sm:justify-end w-full sm:w-1/3 space-x-6">
                        <div className="flex-1 max-w-[200px] space-y-2">
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>Progress</span>
                            <span>{checklist.completedCount} / {checklist.totalCount}</span>
                          </div>
                          <Progress value={percentComplete} className="h-2" />
                        </div>
                        <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-foreground transition-colors" />
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="p-12">
              <Empty
                icon={CalendarCheck}
                title="No checklists found"
                description="Create a month-end close checklist to get started."
                action={
                  <Button variant="outline" onClick={() => setOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" /> Create Checklist
                  </Button>
                }
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
