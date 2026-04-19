import { useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";
import { apiJson } from "@/lib/api";
import { useAuth } from "@/lib/auth";

type DraftRow = {
  id: number;
  entryDate: string | null;
  memo: string | null;
  status: "draft" | "submitted" | "approved" | "rejected" | "posted";
};

const OPEN_STATUSES = ["draft", "submitted", "approved"] as const;

export function PeriodDraftsBanner({
  fromDate,
  toDate,
  periodLabel,
}: {
  fromDate: string;
  toDate: string;
  periodLabel: string;
}) {
  const { user } = useAuth();
  const role = user?.role;
  const canSeeDrafts = role === "admin" || role === "approver";
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);

  useEffect(() => {
    if (!canSeeDrafts) {
      setDrafts(null);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      setDrafts(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      scope: "all",
      entryDateFrom: fromDate,
      entryDateTo: toDate,
      statuses: OPEN_STATUSES.join(","),
    });
    apiJson<{ drafts: DraftRow[] }>(
      `/accounting/journal-entry-drafts?${params.toString()}`,
    )
      .then((data) => {
        if (!cancelled) setDrafts(data.drafts);
      })
      .catch(() => {
        if (!cancelled) setDrafts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canSeeDrafts, fromDate, toDate]);

  if (!canSeeDrafts || !drafts || drafts.length === 0) return null;

  const count = drafts.length;
  return (
    <div
      data-testid="period-drafts-banner"
      className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
    >
      <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="font-medium text-foreground">
          {count} open draft journal {count === 1 ? "entry" : "entries"} for{" "}
          {periodLabel}
        </div>
        <div className="text-muted-foreground">
          These manual draft entries have an entry date inside this period and
          have not been posted yet. Post or discard them before closing so the
          ledger reflects the full period.
        </div>
      </div>
      <Link
        href="/accounting/journal-entries#drafts"
        className="shrink-0 text-sm font-medium text-primary hover:underline whitespace-nowrap"
      >
        Review drafts →
      </Link>
    </div>
  );
}
