import { useState } from "react";
import { useListPrograms, useCreateProgram, useUpdateProgram, getListProgramsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { FolderTree, Plus, Pencil, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Empty } from "@/components/ui/empty";
import { Badge } from "@/components/ui/badge";
import { ContactList } from "@/components/contact-list";
import { apiJson } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const formSchema = z.object({
  name: z.string().min(2, "Name is required"),
  type: z.enum(["program", "grant", "fund", "site", "department"]),
  code: z.string().optional(),
  description: z.string().optional(),
  budgetAmount: z.coerce.number().min(0).optional(),
  fiscalYear: z.string().optional(),
});

export default function ProgramsList() {
  const [open, setOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [editing, setEditing] = useState<any | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const { user } = useAuth();
  const canManage = user?.role === "admin" || user?.role === "approver";

  const toggleExpanded = (id: number) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  
  const { data: programsList, isLoading } = useListPrograms(
    typeFilter !== "all" ? { type: typeFilter as any } : undefined
  );

  const createProgram = useCreateProgram();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      type: "program",
      code: "",
      description: "",
      budgetAmount: 0,
      fiscalYear: new Date().getFullYear().toString(),
    },
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    try {
      await createProgram.mutateAsync({ data: values });
      toast({ title: "Program created successfully" });
      setOpen(false);
      form.reset();
      queryClient.invalidateQueries({ queryKey: getListProgramsQueryKey() });
    } catch (error) {
      toast({ title: "Failed to create program", variant: "destructive" });
    }
  };

  const getProgressColor = (percent: number) => {
    if (percent < 50) return "bg-success";
    if (percent < 85) return "bg-info";
    if (percent < 100) return "bg-warning";
    return "bg-destructive";
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Programs & Grants</h1>
          <p className="text-muted-foreground mt-1">
            Manage funding sources, grants, and program allocations.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Plus className="mr-2 h-4 w-4" />
              New Program
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create Program</DialogTitle>
              <DialogDescription>
                Add a new program, grant, or fund to track expenses against.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Reentry Housing Grant" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Type</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="program">Program</SelectItem>
                            <SelectItem value="grant">Grant</SelectItem>
                            <SelectItem value="fund">Fund</SelectItem>
                            <SelectItem value="site">Site</SelectItem>
                            <SelectItem value="department">Department</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Code (Optional)</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. RHG-2024" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="budgetAmount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Budget Amount ($)</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.01" min="0" placeholder="0.00" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="fiscalYear"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Fiscal Year</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. 2024" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Input placeholder="Brief description" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createProgram.isPending}>
                    {createProgram.isPending ? "Creating..." : "Create"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex items-center space-x-2">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="program">Programs</SelectItem>
            <SelectItem value="grant">Grants</SelectItem>
            <SelectItem value="fund">Funds</SelectItem>
            <SelectItem value="site">Sites</SelectItem>
            <SelectItem value="department">Departments</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {isLoading ? (
          [1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} className="h-48 w-full" />)
        ) : programsList && (Array.isArray(programsList) ? programsList : programsList?.items ?? []).length > 0 ? (
          (Array.isArray(programsList) ? programsList : (programsList as any)?.items ?? []).map((program: any) => {
            const percentUsed = program.percentUsed || 0;
            const isOverBudget = percentUsed > 100;
            
            const isOpen = expanded.has(program.id);
            return (
              <Card key={program.id} className="overflow-hidden hover:border-primary/50 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start gap-2">
                    <CardTitle className="text-lg line-clamp-1 flex-1" title={program.name}>{program.name}</CardTitle>
                    <Badge variant="outline" className="capitalize">{program.type}</Badge>
                  </div>
                  {program.code && <CardDescription>{program.code}</CardDescription>}
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Spend</span>
                      <span className="font-medium">${(program.totalSpend || 0).toLocaleString()}</span>
                    </div>
                    {program.budgetAmount ? (
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Budget</span>
                          <span className="font-medium">${program.budgetAmount.toLocaleString()}</span>
                        </div>
                        <Progress
                          value={Math.min(percentUsed, 100)}
                          className="h-2"
                          indicatorClassName={getProgressColor(percentUsed)}
                        />
                        <div className={`text-xs text-right ${isOverBudget ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                          {percentUsed.toFixed(1)}% used
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground italic">No budget set</div>
                    )}
                    <div className="flex gap-1 pt-2 border-t">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="flex-1"
                        onClick={() => toggleExpanded(program.id)}
                      >
                        {isOpen ? <ChevronDown className="h-3 w-3 mr-1" /> : <ChevronRight className="h-3 w-3 mr-1" />}
                        Contacts
                      </Button>
                      {canManage && (
                        <Button size="sm" variant="ghost" onClick={() => setEditing(program)}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                      )}
                      {user?.role === "admin" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={async () => {
                            if (!confirm(`Delete program "${program.name}"?`)) return;
                            try {
                              await apiJson(`/programs/${program.id}`, { method: "DELETE" });
                              toast({ title: "Program deleted" });
                              queryClient.invalidateQueries({ queryKey: getListProgramsQueryKey() });
                            } catch (e) {
                              toast({ title: "Could not delete", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
                            }
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                    {isOpen && (
                      <div className="pt-2 border-t">
                        <ContactList parentId={program.id} kind="program" />
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        ) : (
          <div className="col-span-full p-12">
            <Empty
              icon={FolderTree}
              title="No programs found"
              description={typeFilter !== "all" ? `No programs match the type "${typeFilter}".` : "Get started by creating your first program or grant."}
            />
          </div>
        )}
      </div>

      {editing && (
        <EditProgramDialog
          program={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: getListProgramsQueryKey() });
          }}
        />
      )}
    </div>
  );
}

function EditProgramDialog({
  program,
  onClose,
  onSaved,
}: {
  program: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const updateProgram = useUpdateProgram();
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: program.name ?? "",
      type: program.type ?? "program",
      code: program.code ?? "",
      description: program.description ?? "",
      budgetAmount: program.budgetAmount ?? 0,
      fiscalYear: program.fiscalYear ?? "",
    },
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    try {
      await updateProgram.mutateAsync({ id: program.id, data: values });
      toast({ title: "Program updated" });
      onSaved();
    } catch (e) {
      toast({
        title: "Update failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Edit Program</DialogTitle>
          <DialogDescription>Update program details.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="type" render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="program">Program</SelectItem>
                      <SelectItem value="grant">Grant</SelectItem>
                      <SelectItem value="fund">Fund</SelectItem>
                      <SelectItem value="site">Site</SelectItem>
                      <SelectItem value="department">Department</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="code" render={({ field }) => (
                <FormItem><FormLabel>Code</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="budgetAmount" render={({ field }) => (
                <FormItem><FormLabel>Budget ($)</FormLabel><FormControl><Input type="number" step="0.01" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="fiscalYear" render={({ field }) => (
                <FormItem><FormLabel>Fiscal Year</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem><FormLabel>Description</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={updateProgram.isPending}>
                {updateProgram.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
