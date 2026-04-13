import { useState } from "react";
import { useLocation } from "wouter";
import { useCreateExpense, useListPrograms } from "@workspace/api-client-react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";

const formSchema = z.object({
  submittedBy: z.string().min(2, "Name is required"),
  expenseDate: z.string().min(1, "Date is required"),
  merchant: z.string().min(2, "Merchant is required"),
  description: z.string().min(2, "Description is required"),
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  paymentMethod: z.enum(["cash", "check", "credit_card", "debit_card", "bank_transfer", "other"]),
  programId: z.coerce.number().optional().or(z.literal("")),
});

export default function ExpenseNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createExpense = useCreateExpense();
  const { data: programs, isLoading: programsLoading } = useListPrograms();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      submittedBy: "Current User", // In a real app, this would be the logged-in user
      expenseDate: new Date().toISOString().split('T')[0],
      merchant: "",
      description: "",
      amount: 0,
      paymentMethod: "credit_card",
      programId: "",
    },
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    try {
      const expenseData = {
        ...values,
        programId: values.programId ? Number(values.programId) : undefined
      };
      
      const result = await createExpense.mutateAsync({ data: expenseData });
      toast({ title: "Expense created successfully" });
      setLocation(`/expenses/${result.id}`);
    } catch (error) {
      toast({ title: "Failed to create expense", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center space-x-4">
        <Link href="/expenses">
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">New Expense Claim</h1>
          <p className="text-muted-foreground mt-1">
            Submit a new expense for reimbursement or corporate card reconciliation.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Expense Details</CardTitle>
          <CardDescription>Please provide accurate information for accounting purposes.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="merchant"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Merchant / Vendor</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Amazon, Home Depot" {...field} />
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
                        <Input type="number" step="0.01" min="0" placeholder="0.00" {...field} />
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
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a payment method" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="credit_card">Corporate Credit Card</SelectItem>
                          <SelectItem value="debit_card">Debit Card</SelectItem>
                          <SelectItem value="cash">Cash (Reimbursement)</SelectItem>
                          <SelectItem value="check">Check</SelectItem>
                          <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
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
                      <Select onValueChange={field.onChange} value={field.value?.toString() || ""}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select program to bill against (optional)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="">General Fund (Unallocated)</SelectItem>
                          {!programsLoading && programs?.items.map(p => (
                            <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
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
                        <Input placeholder="Brief description of the expense" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="flex justify-end gap-4 pt-4 border-t">
                <Link href="/expenses">
                  <Button variant="outline" type="button">Cancel</Button>
                </Link>
                <Button type="submit" disabled={createExpense.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90">
                  {createExpense.isPending ? "Submitting..." : "Submit Expense"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
