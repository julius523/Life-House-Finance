import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@workspace/object-storage-web";
import {
  useParseBankStatement,
  useListPrograms,
  getListExpensesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles, Upload, Loader2, FileText } from "lucide-react";

interface Props {
  trigger?: React.ReactNode;
}

export function BankStatementImport({ trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [paymentMethod, setPaymentMethod] = useState("credit_card");
  const [programId, setProgramId] = useState<string>("none");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { uploadFile, isUploading, progress } = useUpload();
  const parse = useParseBankStatement();
  const { data: programs } = useListPrograms();

  const programList = Array.isArray(programs)
    ? programs
    : ((programs as any)?.items ?? []);

  const handleSubmit = async () => {
    if (!file) {
      toast({ title: "Please select a file first", variant: "destructive" });
      return;
    }
    const uploaded = await uploadFile(file);
    if (!uploaded) return;

    try {
      const result = await parse.mutateAsync({
        data: {
          objectPath: uploaded.objectPath,
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          submittedBy: "Current User",
          defaultPaymentMethod: paymentMethod as
            | "cash"
            | "check"
            | "credit_card"
            | "debit_card"
            | "bank_transfer"
            | "other",
          defaultProgramId:
            programId !== "none" ? Number(programId) : undefined,
        },
      });
      toast({
        title: `Imported ${result.createdCount} draft expense${result.createdCount === 1 ? "" : "s"}`,
        description:
          result.skippedCount > 0
            ? `${result.skippedCount} non-debit lines were skipped.`
            : "Review the drafts and submit for approval.",
      });
      queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey() });
      setOpen(false);
      setFile(null);
    } catch (e) {
      toast({
        title: "Could not parse this statement",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const busy = isUploading || parse.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">
            <Sparkles className="mr-2 h-4 w-4" />
            Import bank statement
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            AI Bank Statement Import
          </DialogTitle>
          <DialogDescription>
            Upload a bank or credit-card statement (PDF, image, or CSV). Each debit
            line will be turned into a draft expense for review.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="bank-file">Statement file</Label>
            <label
              htmlFor="bank-file"
              className="flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed border-muted-foreground/30 bg-muted/30 p-6 text-center hover:bg-muted/50 transition-colors"
            >
              {file ? (
                <>
                  <FileText className="h-8 w-8 text-primary mb-2" />
                  <div className="font-medium">{file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {(file.size / 1024).toFixed(0)} KB · click to choose another
                  </div>
                </>
              ) : (
                <>
                  <Upload className="h-8 w-8 text-muted-foreground mb-2" />
                  <div className="font-medium">Click to choose a file</div>
                  <div className="text-xs text-muted-foreground">
                    PDF, image (JPG/PNG), CSV, or plain text
                  </div>
                </>
              )}
              <input
                id="bank-file"
                type="file"
                accept="application/pdf,image/*,text/csv,text/plain,.csv"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Default payment method</Label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="credit_card">Corporate Credit Card</SelectItem>
                  <SelectItem value="debit_card">Debit Card</SelectItem>
                  <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                  <SelectItem value="check">Check</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Allocate to program</Label>
              <Select value={programId} onValueChange={setProgramId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">General Fund (Unallocated)</SelectItem>
                  {programList.map((p: any) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!file || busy}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {isUploading ? `Uploading… ${progress}%` : "Reading statement…"}
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Extract Expenses
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
