import { useEffect } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetBill,
  useUpdateBill,
  useListVendors,
  useListPrograms,
  getGetBillQueryKey,
  getListBillsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Save } from "lucide-react";

const formSchema = z.object({
  vendorId: z.coerce.number().min(1, "Vendor is required"),
  invoiceNumber: z.string().optional(),
  invoiceDate: z.string().optional(),
  dueDate: z.string().min(1, "Due date is required"),
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  description: z.string().optional(),
  programId: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export default function BillEdit() {
  const [, params] = useRoute("/bills/:id/edit");
  const id = params?.id ? parseInt(params.id) : 0;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: bill, isLoading } = useGetBill(id, {
    query: { enabled: !!id, queryKey: getGetBillQueryKey(id) },
  });
  const { data: vendors, isLoading: vendorsLoading } = useListVendors();
  const { data: programs, isLoading: programsLoading } = useListPrograms();
  const updateBill = useUpdateBill();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      vendorId: 0,
      invoiceNumber: "",
      invoiceDate: "",
      dueDate: "",
      amount: 0,
      description: "",
      programId: "none",
    },
  });

  useEffect(() => {
    if (!bill) return;
    form.reset({
      vendorId: bill.vendorId,
      invoiceNumber: bill.invoiceNumber ?? "",
      invoiceDate: bill.invoiceDate ?? "",
      dueDate: bill.dueDate,
      amount: bill.amount,
      description: bill.description ?? "",
      programId: bill.programId ? String(bill.programId) : "none",
    });
  }, [bill, form]);

  const handleSave = async (values: FormValues) => {
    try {
      await updateBill.mutateAsync({
        id,
        data: {
          vendorId: values.vendorId,
          invoiceNumber: values.invoiceNumber || undefined,
          invoiceDate: values.invoiceDate || undefined,
          dueDate: values.dueDate,
          amount: values.amount,
          description: values.description || undefined,
          programId:
            values.programId && values.programId !== "none"
              ? Number(values.programId)
              : undefined,
        },
      });
      toast({ title: "Bill updated" });
      queryClient.invalidateQueries({ queryKey: getGetBillQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
      setLocation(`/bills/${id}`);
    } catch (e) {
      toast({
        title: "Failed to update bill",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  if (isLoading || !bill) {
    return (
      <div className="space-y-6 max-w-3xl mx-auto">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const vendorList = Array.isArray(vendors)
    ? vendors
    : ((vendors as { items?: { id: number; name: string }[] } | undefined)
        ?.items ?? []);
  const programList = Array.isArray(programs)
    ? programs
    : ((programs as { items?: { id: number; name: string }[] } | undefined)
        ?.items ?? []);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center space-x-4">
        <Link href={`/bills/${id}`}>
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Edit Bill #{id}</h1>
          <p className="text-muted-foreground mt-1">
            Update the bill details, then return to the bill to resubmit it.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bill Details</CardTitle>
          <CardDescription>
            All details should match the physical or digital invoice.
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
                  name="vendorId"
                  render={({ field }) => (
                    <FormItem className="col-span-1 md:col-span-2">
                      <FormLabel>Vendor</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value ? field.value.toString() : ""}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a vendor" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {!vendorsLoading &&
                            vendorList.map((v) => (
                              <SelectItem key={v.id} value={v.id.toString()}>
                                {v.name}
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
                        <Input type="number" step="0.01" min="0" {...field} />
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
                  name="description"
                  render={({ field }) => (
                    <FormItem className="col-span-1 md:col-span-2">
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Additional notes or description"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t">
                <Link href={`/bills/${id}`}>
                  <Button variant="outline" type="button">
                    Cancel
                  </Button>
                </Link>
                <Button type="submit" disabled={updateBill.isPending}>
                  <Save className="mr-2 h-4 w-4" />
                  {updateBill.isPending ? "Saving…" : "Save Changes"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
