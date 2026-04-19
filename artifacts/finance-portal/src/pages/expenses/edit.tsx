import { useEffect, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetExpense,
  useUpdateExpense,
  useDeleteExpense,
  useListPrograms,
  getGetExpenseQueryKey,
  getListExpensesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useListExpenseCategories } from "@workspace/api-client-react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Trash2, Save, Send } from "lucide-react";

const formSchema = z.object({
  expenseDate: z.string().min(1, "Date is required"),
  merchant: z.string().min(2, "Merchant is required"),
  description: z.string().min(2, "Description is required"),
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  paymentMethod: z.enum([
    "cash",
    "check",
    "credit_card",
    "debit_card",
    "bank_transfer",
    "other",
  ]),
  programId: z.string().optional(),
  categoryId: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

interface ExpenseCategoryOption {
  id: number;
  name: string;
  isActive: boolean;
  hasCompleteMapping: boolean;
}

export default function ExpenseEdit() {
  const [, params] = useRoute("/expenses/:id/edit");
  const id = params?.id ? parseInt(params.id) : 0;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const { data: expense, isLoading } = useGetExpense(id, {
    query: { enabled: !!id, queryKey: getGetExpenseQueryKey(id) },
  });
  const { data: programs, isLoading: programsLoading } = useListPrograms();
  // Task #51 — load categories so submitters/admins can change classification.
  const categoriesQuery = useListExpenseCategories();
  const categories = categoriesQuery.data?.categories ?? [];
  const updateExpense = useUpdateExpense();
  const deleteExpense = useDeleteExpense();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      expenseDate: "",
      merchant: "",
      description: "",
      amount: 0,
      paymentMethod: "credit_card",
      programId: "none",
      categoryId: "none",
    },
  });

  // Hydrate form once the expense loads.
  useEffect(() => {
    if (!expense) return;
    form.reset({
      expenseDate: expense.expenseDate,
      merchant: expense.merchant,
      description: expense.description ?? "",
      amount: expense.amount,
      paymentMethod: expense.paymentMethod,
      programId: expense.programId ? String(expense.programId) : "none",
      categoryId: (expense as { categoryId?: number | null }).categoryId
        ? String((expense as { categoryId?: number | null }).categoryId)
        : "none",
    });
  }, [expense, form]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetExpenseQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey() });
  };

  const buildPayload = (values: FormValues) => ({
    merchant: values.merchant,
    description: values.description,
    amount: values.amount,
    expenseDate: values.expenseDate,
    paymentMethod: values.paymentMethod,
    programId:
      values.programId && values.programId !== "none"
        ? Number(values.programId)
        : undefined,
    categoryId:
      values.categoryId && values.categoryId !== "none"
        ? Number(values.categoryId)
        : null,
  });

  const handleSave = async (values: FormValues) => {
    try {
      await updateExpense.mutateAsync({ id, data: buildPayload(values) });
      toast({ title: "Expense updated" });
      invalidate();
      setLocation(`/expenses/${id}`);
    } catch {
      toast({ title: "Failed to update expense", variant: "destructive" });
    }
  };

  const handleSaveAndSubmit = async () => {
    const valid = await form.trigger();
    if (!valid) return;
    const values = form.getValues();
    try {
      await updateExpense.mutateAsync({
        id,
        data: { ...buildPayload(values), status: "submitted" },
      });
      toast({ title: "Expense submitted for approval" });
      invalidate();
      setLocation(`/expenses/${id}`);
    } catch {
      toast({ title: "Failed to submit expense", variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteExpense.mutateAsync({ id });
      toast({ title: "Expense deleted" });
      queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey() });
      setLocation("/expenses");
    } catch {
      toast({ title: "Failed to delete expense", variant: "destructive" });
    }
  };

  if (isLoading || !expense) {
    return (
      <div className="space-y-6 max-w-3xl mx-auto">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const isDraft = expense.status === "draft";
  const programList = Array.isArray(programs)
    ? programs
    : ((programs as { items?: { id: number; name: string }[] } | undefined)
        ?.items ?? []);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center space-x-4">
        <Link href={`/expenses/${id}`}>
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Edit Expense #{id}
          </h1>
          <p className="text-muted-foreground mt-1">
            {isDraft
              ? "This expense is a draft. Review the details and submit it for approval."
              : "Update the expense details below."}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Expense Details</CardTitle>
          <CardDescription>
            Changes are saved immediately when you click Save.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSave)}
              className="space-y-6"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="merchant"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Merchant / Vendor</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="expenseDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date of Expense</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount ($)</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" min="0" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="paymentMethod"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Payment Method</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="credit_card">
                            Corporate Credit Card
                          </SelectItem>
                          <SelectItem value="debit_card">Debit Card</SelectItem>
                          <SelectItem value="cash">
                            Cash (Reimbursement)
                          </SelectItem>
                          <SelectItem value="check">Check</SelectItem>
                          <SelectItem value="bank_transfer">
                            Bank Transfer
                          </SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="programId"
                  render={({ field }) => (
                    <FormItem className="col-span-1 md:col-span-2">
                      <FormLabel>Program / Grant Allocation</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || "none"}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">
                            General Fund (Unallocated)
                          </SelectItem>
                          {!programsLoading &&
                            programList.map((p) => (
                              <SelectItem key={p.id} value={p.id.toString()}>
                                {p.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="categoryId"
                  render={({ field }) => (
                    <FormItem className="col-span-1 md:col-span-2">
                      <FormLabel>Expense Category</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || "none"}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-expense-category">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">Uncategorized</SelectItem>
                          {categories
                            .filter((c) => c.isActive)
                            .map((c) => (
                              <SelectItem key={c.id} value={String(c.id)}>
                                {c.name}
                                {!c.hasCompleteMapping
                                  ? " ⚠ (mapping incomplete)"
                                  : ""}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem className="col-span-1 md:col-span-2">
                      <FormLabel>Description / Business Purpose</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="flex flex-col-reverse sm:flex-row sm:justify-between sm:items-center gap-3 pt-4 border-t">
                <Button
                  type="button"
                  variant="outline"
                  className="text-destructive border-destructive hover:bg-destructive/10"
                  onClick={() => setConfirmDeleteOpen(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Expense
                </Button>
                <div className="flex flex-col-reverse sm:flex-row gap-3">
                  <Link href={`/expenses/${id}`}>
                    <Button variant="outline" type="button">
                      Cancel
                    </Button>
                  </Link>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={updateExpense.isPending}
                  >
                    <Save className="mr-2 h-4 w-4" />
                    {updateExpense.isPending ? "Saving…" : "Save Changes"}
                  </Button>
                  {isDraft && (
                    <Button
                      type="button"
                      onClick={handleSaveAndSubmit}
                      disabled={updateExpense.isPending}
                      className="bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      <Send className="mr-2 h-4 w-4" />
                      Save & Submit
                    </Button>
                  )}
                </div>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this expense?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove expense #{id} from the system. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
