/**
 * Task #104 — Integrity Findings UI (read-only snapshot viewer).
 *
 * Renders a single sweep snapshot from `GET /api/admin/integrity/sweep`
 * (the locked, read-only contract added in Task #103). No write actions,
 * no history view, no fix buttons — just visibility on a single live
 * snapshot for pre-launch hardening.
 *
 * Behavior is locked by task-104.md:
 *   - Critical-hoist section pinned above the categorized sections.
 *   - Categorized sections render in this fixed order:
 *       structural → status_mismatch → missing_bridge → reversal →
 *       posted_line → remediation
 *   - Within each section: severity (critical → warning → info), then
 *     descending count, then name ascending.
 *   - Zero-count rows are hidden in the non-OK state.
 *   - All-OK payload renders only the success banner.
 *   - Sample IDs link by `kind` per the rules below; opaque kinds get a
 *     copy affordance only.
 *   - "Re-run" re-fetches the same endpoint; disabled while in flight.
 *   - CSV export emits one row per sample ref (or one empty-sample row
 *     when count > 0 with no refs). Visual truncation does NOT affect
 *     the CSV.
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import {
  INTEGRITY_CATEGORIES,
  type IntegrityCategory,
  type IntegrityCheckResult,
  type IntegritySampleRef,
  type IntegritySeverity,
  type IntegritySweepReport,
} from "@workspace/db/integrity-types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  downloadCsv,
  csvFilenameSlug,
  type CsvCell,
} from "@/lib/csv-export";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<IntegritySeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export const CATEGORY_LABELS: Record<IntegrityCategory, string> = {
  structural: "Structural",
  status_mismatch: "Status mismatch",
  missing_bridge: "Missing bridge",
  reversal: "Reversal",
  posted_line: "Posted line",
  remediation: "Remediation",
};

/**
 * Sort checks by severity (critical → warning → info), then descending
 * count, then ascending name. Pure; does not mutate the input.
 */
export function sortChecks(
  checks: IntegrityCheckResult[],
): IntegrityCheckResult[] {
  return [...checks].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sa !== 0) return sa;
    if (a.count !== b.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
}

export type GroupedFindings = {
  critical: IntegrityCheckResult[];
  categorized: Array<{
    category: IntegrityCategory;
    checks: IntegrityCheckResult[];
  }>;
};

/**
 * Hoist every critical check with count > 0 into its own section, then
 * group the remaining count > 0 checks by category in the fixed order.
 * Empty (count === 0) checks are dropped — the non-OK state never shows
 * zero-count rows per the spec.
 */
export function groupAndOrderChecks(
  report: IntegritySweepReport,
): GroupedFindings {
  const nonZero = report.checks.filter((c) => c.count > 0);
  const criticalSet = new Set<string>();
  const critical = sortChecks(
    nonZero.filter((c) => {
      if (c.severity !== "critical") return false;
      criticalSet.add(c.key);
      return true;
    }),
  );
  const categorized: GroupedFindings["categorized"] = [];
  for (const cat of INTEGRITY_CATEGORIES) {
    const checks = sortChecks(
      nonZero.filter((c) => c.category === cat && !criticalSet.has(c.key)),
    );
    if (checks.length > 0) categorized.push({ category: cat, checks });
  }
  return { critical, categorized };
}

/**
 * Resolve a sample ref to a route inside the finance portal. Returns
 * null for opaque kinds (`source_link`, `other`) — those render the raw
 * ID with a copy affordance only. The spec forbids guessing routes.
 */
export function linkForSampleRef(ref: IntegritySampleRef): string | null {
  switch (ref.kind) {
    case "expense":
      return `/expenses/${ref.id}`;
    case "bill":
      return `/bills/${ref.id}`;
    case "journal_entry":
      return `/accounting/journal-entries/${ref.id}`;
    case "draft":
      return `/accounting/journal-entry-drafts/${ref.id}`;
    case "source_link":
    case "other":
      return null;
  }
}

const CSV_HEADER: CsvCell[] = [
  "generatedAt",
  "checkKey",
  "checkName",
  "category",
  "severity",
  "count",
  "sampleKind",
  "sampleId",
];

/**
 * Build the CSV row matrix per the locked column order. Zero-count
 * checks are omitted entirely; checks with `count > 0` but no sample
 * refs emit one row with empty sampleKind/sampleId; checks with N
 * sample refs emit N rows. ALL returned sample refs are included even
 * if the UI truncated them.
 */
export function buildIntegrityCsvRows(
  report: IntegritySweepReport,
): CsvCell[][] {
  const rows: CsvCell[][] = [CSV_HEADER];
  for (const c of report.checks) {
    if (c.count <= 0) continue;
    if (c.sampleRefs.length === 0) {
      rows.push([
        report.generatedAt,
        c.key,
        c.name,
        c.category,
        c.severity,
        c.count,
        "",
        "",
      ]);
      continue;
    }
    for (const ref of c.sampleRefs) {
      rows.push([
        report.generatedAt,
        c.key,
        c.name,
        c.category,
        c.severity,
        c.count,
        ref.kind,
        ref.id,
      ]);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: IntegritySeverity }) {
  const cls =
    severity === "critical"
      ? "bg-red-100 text-red-800 hover:bg-red-100"
      : severity === "warning"
        ? "bg-amber-100 text-amber-800 hover:bg-amber-100"
        : "bg-blue-100 text-blue-800 hover:bg-blue-100";
  return (
    <Badge
      variant="secondary"
      className={cls}
      data-testid={`severity-badge-${severity}`}
    >
      {severity}
    </Badge>
  );
}

const VISIBLE_SAMPLE_CAP = 10;

function SampleRefItem({ refItem }: { refItem: IntegritySampleRef }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const href = linkForSampleRef(refItem);

  const onCopy = useCallback(async () => {
    setCopyError(null);
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(refItem.id);
      } else {
        throw new Error("Clipboard unavailable");
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setCopyError(e instanceof Error ? e.message : "Copy failed");
    }
  }, [refItem.id]);

  return (
    <li
      className="flex items-center gap-2 text-xs"
      data-testid={`sample-ref-${refItem.kind}-${refItem.id}`}
    >
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
        {refItem.kind}
      </span>
      {href ? (
        <Link
          href={href}
          className="font-mono text-blue-700 hover:underline"
          data-testid={`sample-link-${refItem.kind}-${refItem.id}`}
        >
          #{refItem.id}
        </Link>
      ) : (
        <span className="font-mono text-foreground">#{refItem.id}</span>
      )}
      <button
        type="button"
        onClick={onCopy}
        className="text-muted-foreground hover:text-foreground"
        title="Copy ID"
        aria-label={`Copy ${refItem.kind} id ${refItem.id}`}
        data-testid={`sample-copy-${refItem.kind}-${refItem.id}`}
      >
        {copied ? (
          <span className="text-emerald-700">Copied</span>
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
      {copyError && (
        <span
          role="alert"
          className="text-[11px] text-red-700"
          data-testid={`sample-copy-error-${refItem.kind}-${refItem.id}`}
        >
          {copyError}
        </span>
      )}
    </li>
  );
}

function CheckRow({ check }: { check: IntegrityCheckResult }) {
  const visible = check.sampleRefs.slice(0, VISIBLE_SAMPLE_CAP);
  const hidden = check.sampleRefs.length - visible.length;
  const cappedByServer =
    check.sampleRefs.length < check.count
      ? check.count - check.sampleRefs.length
      : 0;
  return (
    <li
      className="rounded border border-border/60 px-3 py-2"
      data-testid={`integrity-check-${check.key}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-medium">{check.name}</span>
          <SeverityBadge severity={check.severity} />
          <span className="text-xs text-muted-foreground">{check.key}</span>
        </div>
        <span
          className="font-mono text-sm"
          data-testid={`integrity-count-${check.key}`}
        >
          {check.count.toLocaleString()}
        </span>
      </div>
      {check.sampleRefs.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {visible.map((ref, i) => (
            <SampleRefItem key={`${ref.kind}-${ref.id}-${i}`} refItem={ref} />
          ))}
        </ul>
      )}
      {(hidden > 0 || cappedByServer > 0) && (
        <p
          className="mt-1 text-[11px] text-muted-foreground"
          data-testid={`integrity-trunc-${check.key}`}
        >
          showing {visible.length} of {check.count.toLocaleString()}
          {cappedByServer > 0
            ? ` (server caps samples at ${check.sampleRefs.length})`
            : ""}
        </p>
      )}
    </li>
  );
}

export function IntegrityReportView({
  report,
}: {
  report: IntegritySweepReport;
}) {
  const grouped = useMemo(() => groupAndOrderChecks(report), [report]);
  const generatedAt = useMemo(
    () => new Date(report.generatedAt).toLocaleString(),
    [report.generatedAt],
  );

  if (report.ok) {
    return (
      <Card
        className="border-emerald-300 bg-emerald-50"
        data-testid="integrity-all-ok"
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-emerald-800">
            <CheckCircle2 className="h-5 w-5" />
            All checks passed
          </CardTitle>
          <CardDescription className="text-emerald-900/80">
            Snapshot generated {generatedAt}.{" "}
            {report.totalChecks.toLocaleString()} check
            {report.totalChecks === 1 ? "" : "s"} run.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {grouped.critical.length > 0 && (
        <Card
          className="border-l-4 border-l-red-500"
          data-testid="integrity-critical-section"
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-700">
              <ShieldAlert className="h-5 w-5" />
              Critical findings
            </CardTitle>
            <CardDescription>
              Pinned above the categorized sections — every check below has
              severity <span className="font-semibold">critical</span> and at
              least one affected record.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {grouped.critical.map((c) => (
                <CheckRow key={c.key} check={c} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {grouped.categorized.map(({ category, checks }) => (
        <Card
          key={category}
          data-testid={`integrity-section-${category}`}
        >
          <CardHeader>
            <CardTitle className="text-base">
              {CATEGORY_LABELS[category]}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {checks.map((c) => (
                <CheckRow key={c.key} check={c} />
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SWEEP_QUERY_KEY = ["admin", "integrity", "sweep"] as const;

async function fetchSweep(): Promise<IntegritySweepReport> {
  return customFetch<IntegritySweepReport>("/api/admin/integrity/sweep", {
    responseType: "json",
  });
}

export default function AdminIntegrityPage() {
  const { toast } = useToast();
  const query = useQuery({
    queryKey: SWEEP_QUERY_KEY,
    queryFn: fetchSweep,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 0,
  });

  const report = query.data ?? null;
  const fetching = query.isFetching;
  const errorMessage = query.error
    ? query.error instanceof Error
      ? query.error.message
      : "Failed to load integrity sweep."
    : null;

  const onRerun = useCallback(() => {
    void query.refetch();
  }, [query]);

  const onExport = useCallback(() => {
    if (!report) return;
    try {
      const rows = buildIntegrityCsvRows(report);
      const stamp = csvFilenameSlug(
        report.generatedAt.replace(/[:.]/g, "-"),
      );
      downloadCsv(`integrity-sweep-${stamp || "snapshot"}.csv`, rows);
    } catch (e) {
      toast({
        title: "Could not export CSV",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  }, [report, toast]);

  return (
    <div className="space-y-6" data-testid="page-admin-integrity">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <ShieldAlert className="h-7 w-7 text-primary" />
            Integrity findings
          </h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Read-only snapshot of the database integrity sweep. Findings are
            grouped by category, with critical issues hoisted to the top.
            Re-run regenerates the snapshot — no fixes are applied here.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={onRerun}
            disabled={fetching}
            data-testid="integrity-rerun"
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${fetching ? "animate-spin" : ""}`}
            />
            {fetching ? "Running…" : "Re-run sweep"}
          </Button>
          <Button
            onClick={onExport}
            disabled={!report || fetching}
            data-testid="integrity-export"
          >
            <Download className="mr-2 h-4 w-4" />
            Download findings (CSV)
          </Button>
        </div>
      </div>

      {errorMessage ? (
        <Card
          className="border-destructive/40"
          data-testid="integrity-error"
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Could not load integrity sweep
            </CardTitle>
            <CardDescription>{errorMessage}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={onRerun}
              disabled={fetching}
              data-testid="integrity-retry"
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${fetching ? "animate-spin" : ""}`}
              />
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : !report ? (
        <Card data-testid="integrity-loading">
          <CardContent className="space-y-3 pt-6">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : (
        <>
          {!report.ok && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="integrity-meta"
            >
              Snapshot generated{" "}
              {new Date(report.generatedAt).toLocaleString()} ·{" "}
              {report.totalChecks.toLocaleString()} checks ·{" "}
              {report.failingChecks.toLocaleString()} failing
            </p>
          )}
          <IntegrityReportView report={report} />
        </>
      )}
    </div>
  );
}
