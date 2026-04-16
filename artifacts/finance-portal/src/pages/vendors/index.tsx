import { useState } from "react";
import {
  useListVendors,
  useCreateVendor,
  useUpdateVendor,
  getListVendorsQueryKey,
} from "@workspace/api-client-react";
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
import {
  Building2,
  Plus,
  Search,
  Mail,
  Phone,
  MapPin,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Empty } from "@/components/ui/empty";
import { Badge } from "@/components/ui/badge";
import { ContactList } from "@/components/contact-list";
import { apiJson } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const formSchema = z.object({
  name: z.string().min(2, "Name is required"),
  contactName: z.string().optional(),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().optional(),
  address: z.string().optional(),
  category: z.string().optional(),
  taxId: z.string().optional(),
  paymentTerms: z.string().optional(),
});

export default function VendorsList() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [editingVendor, setEditingVendor] = useState<any | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const { user } = useAuth();
  const canManage = user?.role === "admin" || user?.role === "approver";

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  
  const { data: vendorsList, isLoading } = useListVendors(
    search ? { search } : undefined
  );

  const createVendor = useCreateVendor();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      contactName: "",
      email: "",
      phone: "",
      address: "",
      category: "",
      taxId: "",
      paymentTerms: "Net 30",
    },
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    try {
      await createVendor.mutateAsync({ data: values });
      toast({ title: "Vendor created successfully" });
      setOpen(false);
      form.reset();
      queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() });
    } catch (error) {
      toast({ title: "Failed to create vendor", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Vendors</h1>
          <p className="text-muted-foreground mt-1">
            Manage your vendor directory and track total spend.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Plus className="mr-2 h-4 w-4" />
              New Vendor
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Create Vendor</DialogTitle>
              <DialogDescription>
                Add a new vendor to the directory.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Acme Corp" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="contactName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contact Name</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. Jane Doe" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="category"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Category</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. Office Supplies" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input type="email" placeholder="jane@acme.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone</FormLabel>
                        <FormControl>
                          <Input placeholder="(555) 123-4567" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Address</FormLabel>
                      <FormControl>
                        <Input placeholder="123 Main St, City, ST 12345" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="taxId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tax ID (EIN)</FormLabel>
                        <FormControl>
                          <Input placeholder="XX-XXXXXXX" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="paymentTerms"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Payment Terms</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. Net 30" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createVendor.isPending}>
                    {createVendor.isPending ? "Creating..." : "Create Vendor"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {editingVendor && (
        <EditVendorDialog
          vendor={editingVendor}
          onClose={() => setEditingVendor(null)}
          onSaved={() => {
            setEditingVendor(null);
            queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() });
          }}
        />
      )}

      <Card>
        <CardHeader className="pb-4 border-b">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search vendors..."
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {vendorsList && <div className="text-sm text-muted-foreground">{(Array.isArray(vendorsList) ? vendorsList.length : (vendorsList as any)?.total ?? 0)} total vendors</div>}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24 w-full" />)}
            </div>
          ) : vendorsList && (Array.isArray(vendorsList) ? vendorsList : (vendorsList as any)?.items ?? []).length > 0 ? (
            <div className="divide-y">
              {(Array.isArray(vendorsList) ? vendorsList : (vendorsList as any)?.items ?? []).map((vendor: any) => {
                const isOpen = expanded.has(vendor.id);
                return (
                  <div key={vendor.id} className="hover:bg-muted/30 transition-colors">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between p-6 gap-4">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(vendor.id)}
                        className="flex items-start gap-3 text-left flex-1"
                      >
                        {isOpen ? <ChevronDown className="h-4 w-4 mt-1 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 mt-1 text-muted-foreground" />}
                        <div className="space-y-2 flex-1">
                          <div className="flex items-center flex-wrap gap-2">
                            <span className="font-semibold text-lg">{vendor.name}</span>
                            {!vendor.isActive && <Badge variant="secondary">Inactive</Badge>}
                            {vendor.category && <Badge variant="outline">{vendor.category}</Badge>}
                          </div>
                          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                            {vendor.contactName && (
                              <div className="flex items-center gap-1">
                                <Building2 className="h-3 w-3" /> {vendor.contactName}
                              </div>
                            )}
                            {vendor.email && (
                              <div className="flex items-center gap-1">
                                <Mail className="h-3 w-3" /> {vendor.email}
                              </div>
                            )}
                            {vendor.phone && (
                              <div className="flex items-center gap-1">
                                <Phone className="h-3 w-3" /> {vendor.phone}
                              </div>
                            )}
                            {vendor.address && (
                              <div className="flex items-center gap-1">
                                <MapPin className="h-3 w-3" /> {vendor.address}
                              </div>
                            )}
                          </div>
                        </div>
                      </button>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className="text-xs text-muted-foreground mb-0.5">Total Spend</div>
                          <div className="text-xl font-bold">
                            ${(vendor.totalSpend || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                        {canManage && (
                          <>
                            <Button variant="outline" size="sm" onClick={() => setEditingVendor(vendor)}>
                              <Pencil className="h-3 w-3" />
                            </Button>
                            {user?.role === "admin" && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-destructive border-destructive/40 hover:bg-destructive/10"
                                onClick={async () => {
                                  if (!confirm(`Delete vendor "${vendor.name}"?`)) return;
                                  try {
                                    await apiJson(`/vendors/${vendor.id}`, { method: "DELETE" });
                                    toast({ title: "Vendor deleted" });
                                    queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() });
                                  } catch (e) {
                                    toast({ title: "Could not delete", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
                                  }
                                }}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {isOpen && (
                      <div className="px-6 pb-6 border-t bg-muted/20">
                        <div className="pt-4">
                          <ContactList parentId={vendor.id} kind="vendor" />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-12">
              <Empty
                icon={Building2}
                title="No vendors found"
                description={search ? `No vendors matching "${search}"` : "Your vendor directory is empty."}
                action={
                  <Button variant="outline" onClick={() => setOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" /> Add Vendor
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

function EditVendorDialog({
  vendor,
  onClose,
  onSaved,
}: {
  vendor: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const updateVendor = useUpdateVendor();
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: vendor.name ?? "",
      contactName: vendor.contactName ?? "",
      email: vendor.email ?? "",
      phone: vendor.phone ?? "",
      address: vendor.address ?? "",
      category: vendor.category ?? "",
      taxId: vendor.taxId ?? "",
      paymentTerms: vendor.paymentTerms ?? "Net 30",
    },
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    try {
      await updateVendor.mutateAsync({ id: vendor.id, data: values });
      toast({ title: "Vendor updated" });
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
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Vendor</DialogTitle>
          <DialogDescription>Update vendor details.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Company Name</FormLabel>
                  <FormControl><Input {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="contactName" render={({ field }) => (
                <FormItem><FormLabel>Contact Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="category" render={({ field }) => (
                <FormItem><FormLabel>Category</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="phone" render={({ field }) => (
                <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <FormField control={form.control} name="address" render={({ field }) => (
              <FormItem><FormLabel>Address</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="taxId" render={({ field }) => (
                <FormItem><FormLabel>Tax ID</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="paymentTerms" render={({ field }) => (
                <FormItem><FormLabel>Payment Terms</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={updateVendor.isPending}>
                {updateVendor.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
