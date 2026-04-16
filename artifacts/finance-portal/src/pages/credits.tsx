import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { TrendingUp, Plus, Pencil, Trash2 } from "lucide-react";
import { apiJson } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Empty } from "@/components/ui/empty";
import { useListPrograms } from "@workspace/api-client-react";

export const CREDIT_STATUSES = [
  "pipeline",
  "received",
  "delayed",
  "write-off",
  "opportunity",
] as const;
export type CreditStatus = (typeof CREDIT_STATUSES)[number];

export const STATUS_LABEL: Record<CreditStatus, string> = {
  pipeline: "Pipeline",
  received: "Received",
  delayed: "Delayed",
  "write-off": "Write-off",
  opportunity: "Opportunity",
};

export const STATUS_COLOR: Record<CreditStatus, string> = {
  pipeline: "#4175f4",
  received: "#24b556",
  delayed: "#eab308",
  "write-off": "#ef4444",
  opportunity: "#9649e2",
};

export type Credit = {
  id: number;
  source: string;
  programId: number | null;
  programName: string | null;
  amount: number;
  expectedDate: string | null;
  receivedDate: string | null;
  status: CreditStatus;
  notes: string | null;
  submittedBy: string | null;
  createdAt: string;
};

export async function listCredits(status?: CreditStatus | "all"): Promise<Credit[]> {
  const qs = status && status !== "all" ? `?status=${status}` : "";
  const data = await apiJson<{ credits: Credit[] }>(`/credits${qs}`);
  return data.credits;
}

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);

export default function CreditsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [credits, setCredits] = useState<Credit[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<CreditStatus | "all">("all");
  const [editing, setEditing] = useState<Credit | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    try {
      setLoading(true);
      setCredits(await listCredits(statusFilter));
    } catch (e) {
      toast({
        title: "Could not load credits",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const handleDelete = async (c: Credit) => {
    if (!confirm(`Delete credit "${c.source}"? This cannot be undone.`)) return;
    try {
      await apiJson(`/credits/${c.id}`, { method: "DELETE" });
      toast({ title: "Credit deleted" });
      refresh();
    } catch (e) {
      toast({
        title: "Could not delete",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const total = credits.reduce((s, c) => s + c.amount, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <TrendingUp className="h-7 w-7 text-primary" /> Credits & Deposits
          </h1>
          <p className="text-muted-foreground mt-1">
            Track grants, donations, and incoming funds across the pipeline.
            Only items marked <strong>Received</strong> count toward realized
            income.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" /> New credit
        </Button>
      </div>

      <Card>
        <CardHeader className="border-b pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Label className="text-sm">Filter by status</Label>
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as CreditStatus | "all")}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {CREDIT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="text-sm text-muted-foreground">
              {credits.length} item{credits.length === 1 ? "" : "s"} ·{" "}
              <span className="font-semibold text-foreground">{fmtMoney(total)}</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-muted-foreground">Loading…</div>
          ) : credits.length === 0 ? (
            <div className="p-12">
              <Empty
                icon={TrendingUp}
                title="No credits recorded yet"
                description="Add a grant, donation, or other incoming fund to start tracking."
              />
            </div>
          ) : (
            <div className="divide-y">
              {credits.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 hover:bg-muted/30"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{c.source}</span>
                      <StatusBadge status={c.status} />
                      {c.programName && (
                        <Badge variant="outline">{c.programName}</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {c.expectedDate && <>Expected {c.expectedDate} · </>}
                      {c.receivedDate && <>Received {c.receivedDate} · </>}
                      {c.submittedBy && <>by {c.submittedBy}</>}
                    </div>
                    {c.notes && (
                      <div className="text-sm text-muted-foreground italic">
                        {c.notes}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-lg font-bold">{fmtMoney(c.amount)}</div>
                    <Button variant="outline" size="sm" onClick={() => setEditing(c)}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    {user?.role === "admin" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/40 hover:bg-destructive/10"
                        onClick={() => handleDelete(c)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {creating && (
        <CreditDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}
      {editing && (
        <CreditDialog
          credit={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: CreditStatus }) {
  return (
    <Badge
      style={{
        backgroundColor: STATUS_COLOR[status] + "33",
        color: STATUS_COLOR[status],
        borderColor: STATUS_COLOR[status],
      }}
      variant="outline"
    >
      {STATUS_LABEL[status]}
    </Badge>
  );
}

function CreditDialog({
  credit,
  onClose,
  onSaved,
}: {
  credit?: Credit;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const { data: programsList } = useListPrograms();
  const programs = (Array.isArray(programsList)
    ? programsList
    : ((programsList as any)?.items ?? [])) as Array<{ id: number; name: string }>;

  const [source, setSource] = useState(credit?.source ?? "");
  const [amount, setAmount] = useState<string>(credit ? String(credit.amount) : "");
  const [status, setStatus] = useState<CreditStatus>(credit?.status ?? "pipeline");
  const [programId, setProgramId] = useState<string>(
    credit?.programId ? String(credit.programId) : "none",
  );
  const [expectedDate, setExpectedDate] = useState(credit?.expectedDate ?? "");
  const [receivedDate, setReceivedDate] = useState(credit?.receivedDate ?? "");
  const [notes, setNotes] = useState(credit?.notes ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!source.trim() || !amount) {
      toast({ title: "Source and amount are required", variant: "destructive" });
      return;
    }
    const n = Number(amount);
    if (!Number.isFinite(n)) {
      toast({ title: "Amount must be a number", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const body = {
        source: source.trim(),
        amount: n,
        status,
        programId: programId === "none" ? null : Number(programId),
        expectedDate: expectedDate || null,
        receivedDate: receivedDate || null,
        notes: notes || null,
        submittedBy: credit?.submittedBy ?? (`${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim() || null),
      };
      if (credit) {
        await apiJson(`/credits/${credit.id}`, { method: "PUT", body });
        toast({ title: "Credit updated" });
      } else {
        await apiJson(`/credits`, { method: "POST", body });
        toast({ title: "Credit created" });
      }
      onSaved();
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{credit ? "Edit credit" : "New credit"}</DialogTitle>
          <DialogDescription>
            Record an incoming grant, donation, or other deposit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Source / description</Label>
            <Input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. State reentry grant"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Amount</Label>
              <Input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as CreditStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREDIT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Program / fund (optional)</Label>
            <Select value={programId} onValueChange={setProgramId}>
              <SelectTrigger>
                <SelectValue placeholder="Unallocated" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unallocated</SelectItem>
                {programs.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Expected date</Label>
              <Input
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Received date</Label>
              <Input
                type="date"
                value={receivedDate}
                onChange={(e) => setReceivedDate(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Saving…" : credit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
