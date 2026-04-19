import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";
import {
  useListJournalEntryDrafts,
  ListJournalEntryDraftsScope,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";

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
  const validRange =
    /^\d{4}-\d{2}-\d{2}$/.test(fromDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(toDate);

  const { data } = useListJournalEntryDrafts(
    {
      scope: ListJournalEntryDraftsScope.all,
      entryDateFrom: fromDate,
      entryDateTo: toDate,
      statuses: OPEN_STATUSES.join(","),
    },
    { query: { enabled: canSeeDrafts && validRange } },
  );

  const drafts = data?.drafts ?? [];
  if (!canSeeDrafts || !validRange || drafts.length === 0) return null;

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
