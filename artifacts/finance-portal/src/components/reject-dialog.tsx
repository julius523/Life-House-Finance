import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

interface RejectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (data: {
    reason: string;
    action: "send_back" | "close";
  }) => Promise<void> | void;
  isSubmitting?: boolean;
}

export function RejectDialog({
  open,
  onOpenChange,
  onConfirm,
  isSubmitting,
}: RejectDialogProps) {
  const [reason, setReason] = useState("");
  const [action, setAction] = useState<"send_back" | "close">("send_back");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (reason.trim().length < 3) {
      setError("Please provide a reason (at least a few words).");
      return;
    }
    setError(null);
    await onConfirm({ reason: reason.trim(), action });
    setReason("");
    setAction("send_back");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reject this expense</DialogTitle>
          <DialogDescription>
            Tell the submitter what is wrong, then choose whether to send it back
            for correction or close it permanently.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="rejection-reason">Reason for rejection</Label>
            <Textarea
              id="rejection-reason"
              placeholder="e.g. Receipt is unreadable. Please reupload a clearer photo."
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <RadioGroup
            value={action}
            onValueChange={(v) => setAction(v as "send_back" | "close")}
            className="space-y-2"
          >
            <div className="flex items-start space-x-3 rounded-md border p-3">
              <RadioGroupItem value="send_back" id="send_back" className="mt-0.5" />
              <Label htmlFor="send_back" className="flex-1 cursor-pointer font-normal">
                <div className="font-medium">Send back for correction</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  The submitter can fix the issues and resubmit.
                </div>
              </Label>
            </div>
            <div className="flex items-start space-x-3 rounded-md border p-3">
              <RadioGroupItem value="close" id="close" className="mt-0.5" />
              <Label htmlFor="close" className="flex-1 cursor-pointer font-normal">
                <div className="font-medium">Close (permanently rejected)</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Use this when the expense is not eligible at all.
                </div>
              </Label>
            </div>
          </RadioGroup>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting
              ? "Submitting…"
              : action === "send_back"
                ? "Send Back for Correction"
                : "Close as Rejected"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
