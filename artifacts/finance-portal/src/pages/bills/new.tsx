import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useCreateBill, useListVendors, useListPrograms, useCreateReceipt } from "@workspace/api-client-react";
import { ReceiptUploader, type PendingReceipt } from "@/components/receipt-uploader";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft } from "lucide-react";

const formSchema = z.object({
  vendorId: z.coerce.number().min(1, "Vendor is required"),
  invoiceNumber: z.string().optional(),
  invoiceDate: z.string().optional(),
  dueDate: z.string().min(1, "Due date is required"),
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  description: z.string().optional(),
  programId: z.string().optional(),
});

export default function BillNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createBill = useCreateBill();
  const createReceipt = useCreateReceipt();
  const { data: vendors, isLoading: vendorsLoading } = useListVendors();
  const { data: programs, isLoading: programsLoading } = useListPrograms();
  const [receipts, setReceipts] = useState<PendingReceipt[]>([]);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      vendorId: 0,
      invoiceNumber: "",
      invoiceDate: "",
      dueDate: new Date().toISOString().split('T')[0],
      amount: 0,
      description: "",
      programId: "",
    },
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    try {
      const billData = {
        ...values,
        programId: values.programId && values.programId !== "none" ? Number(values.programId) : undefined
      };
      
      const result = await createBill.mutateAsync({ data: billData });

      for (const r of receipts) {
        await createReceipt.mutateAsync({
          data: {
            fileName: r.file.name,
            fileType: r.contentType,
            fileUrl: r.objectPath,
            linkedBillId: result.id,
            amount: values.amount,
            receiptDate: values.invoiceDate || values.dueDate,
          },
        });
      }

      toast({
        title: "Bill created successfully",
        description: receipts.length > 0
          ? `${receipts.length} document${receipts.length === 1 ? "" : "s"} attached.`
          : undefined,
      });
      setLocation(`/bills/${result.id}`);
    } catch (error) {
      toast({ title: "Failed to create bill", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center space-x-4">
        <Link href="/bills">
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">New Vendor Bill</h1>
          <p className="text-muted-foreground mt-1">
            Enter a new invoice from a vendor for payment processing.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bill Details</CardTitle>
          <CardDescription>All details should match the physical or digital invoice.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="vendorId"
                  render={({ field }) => (
                    <FormItem className="col-span-1 md:col-span-2">
                      <FormLabel>Vendor</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ? field.value.toString() : ""}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a vendor" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {!vendorsLoading && (Array.isArray(vendors) ? vendors : (vendors as any)?.items ?? []).map((v: any) => (
                            <SelectItem key={v.id} value={v.id.toString()}>{v.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="invoiceNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Invoice Number</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. INV-1002" {...field} />
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
                  name="invoiceDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Invoice Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="dueDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Due Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
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
                      <Select onValueChange={field.onChange} value={field.value?.toString() || "none"}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select program to bill against (optional)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">General Fund (Unallocated)</SelectItem>
                          {!programsLoading && (Array.isArray(programs) ? programs : (programs as any)?.items ?? []).map((p: any) => (
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
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Input placeholder="Additional notes or description" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="pt-4 border-t">
                <ReceiptUploader
                  value={receipts}
                  onChange={setReceipts}
                  label="Invoice / Supporting Documents"
                  hint="Attach the invoice PDF or supporting receipts."
                />
              </div>

              <div className="flex justify-end gap-4 pt-4 border-t">
                <Link href="/bills">
                  <Button variant="outline" type="button">Cancel</Button>
                </Link>
                <Button type="submit" disabled={createBill.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90">
                  {createBill.isPending ? "Creating..." : "Create Bill"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
