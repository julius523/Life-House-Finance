/**
 * Task #49 — Admin UI for recurring CSV exports of journal entries.
 *
 * Lists all schedules, lets admins create/edit/delete/run-now, and shows
 * the most recent send-log entries for the selected schedule. Admin-only:
 * the wouter route guard already redirects non-admins, but every action
 * button stays hidden when role !== "admin".
 */

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  useListJournalEntryExportSchedules,
  useCreateJournalEntryExportSchedule,
  useUpdateJournalEntryExportSchedule,
  useDeleteJournalEntryExportSchedule,
  useRunJournalEntryExportScheduleNow,
  useGetJournalEntryExportScheduleLog,
  useListJournalEntryActors,
  getListJournalEntryExportSchedulesQueryKey,
  getGetJournalEntryExportScheduleLogQueryKey,
  type JournalEntryExportSchedule,
  type JournalEntryExportScheduleBody,
  type AuthUser,
  JournalEntryExportScheduleBodyCadence,
  JournalEntryExportScheduleBodyFilterStatus,
  JournalEntryExportScheduleBodyFilterSource,
} from "@workspace/api-client-react";
import { Plus, Pencil, Trash2, Play, ArrowLeft, AlertTriangle, Download } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type Cadence = "daily" | "weekly" | "monthly";
type FilterStatus = "all" | "posted" | "reversed";
type FilterSource = "all" | "copilot" | "manual" | "expense" | "bill";

interface FormState {
  id: number | null;
  name: string;
  enabled: boolean;
  cadence: Cadence;
  recipientsText: string;
  filterStatus: FilterStatus;
  filterSource: FilterSource;
  /** Task #71 — "any" or stringified user id, mirrors journal-entries-list. */
  postedByFilter: string;
  approverFilter: string;
  includeLines: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: "",
  enabled: true,
  cadence: "weekly",
  recipientsText: "",
  filterStatus: "all",
  filterSource: "all",
  postedByFilter: "any",
  approverFilter: "any",
  includeLines: false,
};

function actorName(a: {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}): string {
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ").trim();
  return name || a.email || `User #${a.id}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// Mirrors MAX_CONSECUTIVE_FAILURES in
// artifacts/api-server/src/lib/journalEntryExportScheduler.ts — kept in
// sync manually so the table can show "Failures: n/MAX" without an extra
// API field.
const MAX_CONSECUTIVE_FAILURES = 3;

function statusBadgeVariant(
  status: string | null | undefined,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "sent") return "default";
  if (status === "empty") return "secondary";
  if (status === "failed") return "destructive";
  return "outline";
}

export default function JournalExportSchedulesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<FormState | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<number | null>(
    null,
  );

  const { data, isLoading, error } = useListJournalEntryExportSchedules();
  // Task #71 — pickers for "Posted by" / "Approver" reuse the same actors
  // endpoint the journal-entries list uses, so the dropdown shows only
  // people who have actually touched a journal entry. Admin-only page, so
  // always enabled.
  const { data: actorsData } = useListJournalEntryActors({
    query: { enabled: isAdmin },
  });
  const posters = (actorsData?.posters ?? []) as AuthUser[];
  const approvers = (actorsData?.approvers ?? []) as AuthUser[];
  const schedules = useMemo<JournalEntryExportSchedule[]>(
    () => data?.schedules ?? [],
    [data],
  );
  // Task #68 — schedules the backend auto-paused after consecutive
  // SendGrid failures. Re-enabling resets the failure counter on the
  // server, so the banner clears as soon as the row is turned back on.
  const autoPaused = useMemo(
    () => schedules.filter((s) => s.autoPausedAt && !s.enabled),
    [schedules],
  );

  const logsQuery = useGetJournalEntryExportScheduleLog(
    selectedScheduleId ?? 0,
    undefined,
    { query: { enabled: selectedScheduleId !== null } },
  );

  const invalidateList = () =>
    queryClient.invalidateQueries({
      queryKey: getListJournalEntryExportSchedulesQueryKey(),
    });
  const invalidateLog = (id: number) =>
    queryClient.invalidateQueries({
      queryKey: getGetJournalEntryExportScheduleLogQueryKey(id),
    });

  const createMut = useCreateJournalEntryExportSchedule({
    mutation: {
      onSuccess: () => {
        invalidateList();
        toast({ title: "Schedule created" });
        setEditing(null);
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not create schedule",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });
  const updateMut = useUpdateJournalEntryExportSchedule({
    mutation: {
      onSuccess: () => {
        invalidateList();
        toast({ title: "Schedule updated" });
        setEditing(null);
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not update schedule",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });
  const deleteMut = useDeleteJournalEntryExportSchedule({
    mutation: {
      onSuccess: () => {
        invalidateList();
        toast({ title: "Schedule deleted" });
        setDeletingId(null);
        if (deletingId === selectedScheduleId) setSelectedScheduleId(null);
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not delete schedule",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });
  const runNowMut = useRunJournalEntryExportScheduleNow({
    mutation: {
      onSuccess: (resp, vars) => {
        invalidateList();
        invalidateLog(vars.id);
        const r = resp.result;
        const desc =
          r.status === "sent"
            ? `Sent ${r.rowCount} entr${r.rowCount === 1 ? "y" : "ies"} (${r.range.from} → ${r.range.to}).`
            : r.status === "empty"
              ? `No entries matched in ${r.range.from} → ${r.range.to}; empty CSV emailed.`
              : `Run failed: ${r.error ?? "unknown error"}`;
        toast({
          title: r.status === "failed" ? "Run failed" : "Export sent",
          description: desc,
          variant: r.status === "failed" ? "destructive" : "default",
        });
      },
      onError: (err: unknown) => {
        toast({
          title: "Run failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  function openCreate() {
    setEditing({ ...EMPTY_FORM });
  }
  function openEdit(s: JournalEntryExportSchedule) {
    setEditing({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      cadence: s.cadence as Cadence,
      recipientsText: (s.recipients ?? []).join(", "),
      filterStatus: (s.filterStatus ?? "all") as FilterStatus,
      filterSource: (s.filterSource ?? "all") as FilterSource,
      postedByFilter:
        s.filterPostedByUserId != null ? String(s.filterPostedByUserId) : "any",
      approverFilter:
        s.filterApproverUserId != null ? String(s.filterApproverUserId) : "any",
      includeLines: s.includeLines,
    });
  }

  function buildBody(form: FormState): JournalEntryExportScheduleBody | null {
    const recipients = form.recipientsText
      .split(/[,\n;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      toast({
        title: "Recipients required",
        description: "Add at least one email address.",
        variant: "destructive",
      });
      return null;
    }
    if (!form.name.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return null;
    }
    const postedByUserId =
      form.postedByFilter !== "any" && /^\d+$/.test(form.postedByFilter)
        ? Number(form.postedByFilter)
        : null;
    const approverUserId =
      form.approverFilter !== "any" && /^\d+$/.test(form.approverFilter)
        ? Number(form.approverFilter)
        : null;
    return {
      name: form.name.trim(),
      enabled: form.enabled,
      cadence: form.cadence as JournalEntryExportScheduleBodyCadence,
      recipients,
      filterStatus:
        form.filterStatus === "all"
          ? null
          : (form.filterStatus as JournalEntryExportScheduleBodyFilterStatus),
      filterSource:
        form.filterSource === "all"
          ? null
          : (form.filterSource as JournalEntryExportScheduleBodyFilterSource),
      filterPostedByUserId: postedByUserId,
      filterApproverUserId: approverUserId,
      includeLines: form.includeLines,
    };
  }

  // Task #69 — POSTs the in-flight form values to the preview endpoint
  // and downloads the returned CSV. Goes through the same buildScheduleCsv
  // helper the scheduler uses, so the file admins see here is the file
  // the next scheduled email would attach (no need to save first).
  async function previewCsv() {
    if (!editing) return;
    if (previewing) return;
    setPreviewing(true);
    try {
      const postedByUserId =
        editing.postedByFilter !== "any" && /^\d+$/.test(editing.postedByFilter)
          ? Number(editing.postedByFilter)
          : null;
      const approverUserId =
        editing.approverFilter !== "any" && /^\d+$/.test(editing.approverFilter)
          ? Number(editing.approverFilter)
          : null;
      const body = {
        cadence: editing.cadence,
        filterStatus:
          editing.filterStatus === "all" ? null : editing.filterStatus,
        filterSource:
          editing.filterSource === "all" ? null : editing.filterSource,
        filterPostedByUserId: postedByUserId,
        filterApproverUserId: approverUserId,
        includeLines: editing.includeLines,
      };
      const res = await fetch("/api/journal-entry-export-schedules/preview", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `Preview failed (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          // non-JSON body — keep default
        }
        throw new Error(msg);
      }
      const rowCountHeader = res.headers.get("X-Preview-Row-Count");
      const rangeFrom = res.headers.get("X-Preview-Range-From");
      const rangeTo = res.headers.get("X-Preview-Range-To");
      // Parse a sensible filename out of Content-Disposition; fall back to
      // a date-stamped default if the header is unavailable for any reason.
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(cd);
      const filename =
        match?.[1] ??
        `journal-entries-preview-${new Date().toISOString().slice(0, 10)}.csv`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const rowCount = rowCountHeader ? Number(rowCountHeader) : NaN;
      const desc =
        Number.isFinite(rowCount) && rangeFrom && rangeTo
          ? `${rowCount} entr${rowCount === 1 ? "y" : "ies"} for ${rangeFrom} → ${rangeTo}.`
          : "Downloaded the CSV the next run would send.";
      toast({ title: "Preview downloaded", description: desc });
    } catch (e) {
      toast({
        title: "Could not preview CSV",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setPreviewing(false);
    }
  }

  function submitForm() {
    if (!editing) return;
    const body = buildBody(editing);
    if (!body) return;
    if (editing.id === null) {
      createMut.mutate({ data: body });
    } else {
      updateMut.mutate({ id: editing.id, data: body });
    }
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/accounting/journal-entries">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to journal entries
          </Link>
        </Button>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            Scheduled CSV Exports
          </h1>
          <p className="text-sm text-muted-foreground">
            Email recurring CSV snapshots of journal entries to reviewers.
          </p>
        </div>
        {isAdmin ? (
          <Button onClick={openCreate} data-testid="button-new-schedule">
            <Plus className="h-4 w-4 mr-1" />
            New schedule
          </Button>
        ) : null}
      </div>

      {autoPaused.length > 0 ? (
        <Alert variant="destructive" data-testid="banner-auto-paused">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {autoPaused.length === 1
              ? "1 schedule was auto-paused after repeated email failures"
              : `${autoPaused.length} schedules were auto-paused after repeated email failures`}
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc pl-5 space-y-1">
              {autoPaused.map((s) => (
                <li key={s.id} data-testid={`auto-paused-${s.id}`}>
                  <span className="font-medium">{s.name}</span>
                  {s.autoPausedReason ? (
                    <> — last error: {s.autoPausedReason}</>
                  ) : null}
                  {s.autoPausedAt ? (
                    <span className="text-xs ml-2 opacity-80">
                      paused {formatDate(s.autoPausedAt)}
                    </span>
                  ) : null}
                  {isAdmin ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-2 h-7"
                      onClick={() =>
                        updateMut.mutate({
                          id: s.id,
                          data: { enabled: true },
                        })
                      }
                      disabled={updateMut.isPending}
                      data-testid={`button-reenable-${s.id}`}
                    >
                      Re-enable
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs">
              Re-enabling resets the failure counter. Fix the recipient list,
              attachment, or SendGrid quota first to avoid an immediate
              re-pause.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Schedules</CardTitle>
          <CardDescription>
            {isLoading
              ? "Loading…"
              : `${schedules.length} schedule${schedules.length === 1 ? "" : "s"}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <p className="text-sm text-destructive p-4">
              Could not load schedules: {String(error)}
            </p>
          ) : schedules.length === 0 && !isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">
              No schedules yet. {isAdmin ? "Click \"New schedule\" to add one." : ""}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted-foreground border-b">
                  <tr>
                    <th className="text-left p-3">Name</th>
                    <th className="text-left p-3">Cadence</th>
                    <th className="text-left p-3">Recipients</th>
                    <th className="text-left p-3">Filters</th>
                    <th className="text-left p-3">Next run</th>
                    <th className="text-left p-3">Last run</th>
                    <th className="text-left p-3">Failures</th>
                    <th className="text-left p-3">Enabled</th>
                    <th className="text-right p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => {
                    const failures = s.consecutiveFailureCount ?? 0;
                    // Highlight rows that are 1+ failures away from
                    // auto-pause. Auto-paused rows already get the
                    // destructive banner above and the "Off" badge below,
                    // so the row tint is reserved for the warning state
                    // (failures > 0 but still enabled / not yet paused).
                    const nearingPause =
                      s.enabled &&
                      failures > 0 &&
                      failures < MAX_CONSECUTIVE_FAILURES;
                    return (
                    <tr
                      key={s.id}
                      className={`border-b hover:bg-muted/50 cursor-pointer ${
                        selectedScheduleId === s.id ? "bg-muted/40" : ""
                      } ${
                        nearingPause
                          ? "bg-destructive/5 hover:bg-destructive/10"
                          : ""
                      }`}
                      onClick={() => setSelectedScheduleId(s.id)}
                      data-testid={`row-schedule-${s.id}`}
                    >
                      <td className="p-3 font-medium">{s.name}</td>
                      <td className="p-3 capitalize">{s.cadence}</td>
                      <td className="p-3 text-muted-foreground">
                        {(s.recipients ?? []).join(", ")}
                      </td>
                      <td className="p-3 text-muted-foreground">
                        <span className="mr-2">
                          {s.filterStatus ?? "any status"}
                        </span>
                        <span className="mr-2">
                          {s.filterSource ?? "any source"}
                        </span>
                        {s.filterPostedByUserId != null ? (
                          <Badge variant="outline" className="mr-1">
                            posted:{" "}
                            {(() => {
                              const u = posters.find(
                                (p) => p.id === s.filterPostedByUserId,
                              );
                              return u
                                ? actorName({
                                    id: u.id,
                                    firstName: u.firstName ?? null,
                                    lastName: u.lastName ?? null,
                                    email: u.email ?? null,
                                  })
                                : `#${s.filterPostedByUserId}`;
                            })()}
                          </Badge>
                        ) : null}
                        {s.filterApproverUserId != null ? (
                          <Badge variant="outline" className="mr-1">
                            approver:{" "}
                            {(() => {
                              const u = approvers.find(
                                (a) => a.id === s.filterApproverUserId,
                              );
                              return u
                                ? actorName({
                                    id: u.id,
                                    firstName: u.firstName ?? null,
                                    lastName: u.lastName ?? null,
                                    email: u.email ?? null,
                                  })
                                : `#${s.filterApproverUserId}`;
                            })()}
                          </Badge>
                        ) : null}
                        {s.includeLines ? (
                          <Badge variant="outline">+ lines</Badge>
                        ) : null}
                      </td>
                      <td className="p-3 text-muted-foreground">
                        {formatDate(s.nextRunAt)}
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          {s.lastRunStatus ? (
                            <Badge variant={statusBadgeVariant(s.lastRunStatus)}>
                              {s.lastRunStatus}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          <span className="text-muted-foreground text-xs">
                            {formatDate(s.lastRunAt)}
                          </span>
                        </div>
                      </td>
                      <td className="p-3">
                        {failures === 0 ? (
                          <span
                            className="text-muted-foreground"
                            data-testid={`failures-${s.id}`}
                          >
                            0/{MAX_CONSECUTIVE_FAILURES}
                          </span>
                        ) : failures >= MAX_CONSECUTIVE_FAILURES ? (
                          <Badge
                            variant="destructive"
                            data-testid={`failures-${s.id}`}
                            title="Schedule auto-paused after reaching the failure limit"
                          >
                            {failures}/{MAX_CONSECUTIVE_FAILURES}
                          </Badge>
                        ) : (
                          <Badge
                            variant="destructive"
                            className="bg-destructive/15 text-destructive hover:bg-destructive/20 border border-destructive/30"
                            data-testid={`failures-${s.id}`}
                            title={`${
                              MAX_CONSECUTIVE_FAILURES - failures
                            } more failure${
                              MAX_CONSECUTIVE_FAILURES - failures === 1
                                ? ""
                                : "s"
                            } until this schedule auto-pauses`}
                          >
                            <AlertTriangle className="h-3 w-3 mr-1" />
                            {failures}/{MAX_CONSECUTIVE_FAILURES}
                          </Badge>
                        )}
                      </td>
                      <td className="p-3">
                        {s.enabled ? (
                          <Badge>On</Badge>
                        ) : (
                          <Badge variant="outline">Off</Badge>
                        )}
                      </td>
                      <td
                        className="p-3 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isAdmin ? (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                runNowMut.mutate({ id: s.id })
                              }
                              disabled={runNowMut.isPending}
                              data-testid={`button-run-now-${s.id}`}
                              title="Run now"
                            >
                              <Play className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openEdit(s)}
                              data-testid={`button-edit-${s.id}`}
                              title="Edit"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeletingId(s.id)}
                              data-testid={`button-delete-${s.id}`}
                              title="Delete"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedScheduleId !== null ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Recent send log</CardTitle>
            <CardDescription>
              Most recent attempts for the selected schedule.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {logsQuery.isLoading ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : (logsQuery.data?.entries?.length ?? 0) === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No runs recorded yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase text-muted-foreground border-b">
                    <tr>
                      <th className="text-left p-3">Sent at</th>
                      <th className="text-left p-3">Status</th>
                      <th className="text-left p-3">Range</th>
                      <th className="text-left p-3">Rows</th>
                      <th className="text-left p-3">Recipients</th>
                      <th className="text-left p-3">Trigger</th>
                      <th className="text-left p-3">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(logsQuery.data?.entries ?? []).map((entry) => (
                      <tr
                        key={entry.id}
                        className="border-b"
                        data-testid={`row-log-${entry.id}`}
                      >
                        <td className="p-3">{formatDate(entry.sentAt)}</td>
                        <td className="p-3">
                          <Badge variant={statusBadgeVariant(entry.status)}>
                            {entry.status}
                          </Badge>
                        </td>
                        <td className="p-3 text-muted-foreground">
                          {entry.rangeFrom ?? "—"} → {entry.rangeTo ?? "—"}
                        </td>
                        <td className="p-3">{entry.rowCount}</td>
                        <td className="p-3 text-muted-foreground">
                          {(entry.recipients ?? []).join(", ")}
                        </td>
                        <td className="p-3">{entry.triggeredBy}</td>
                        <td className="p-3 text-destructive">
                          {entry.errorMessage ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Create / edit dialog */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing?.id === null ? "New schedule" : "Edit schedule"}
            </DialogTitle>
            <DialogDescription>
              The scheduler runs at 02:00 UTC each day; cadence determines the
              date range exported.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="schedule-name">Name</Label>
                <Input
                  id="schedule-name"
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                  placeholder="Weekly to controllers"
                  data-testid="input-name"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Cadence</Label>
                  <Select
                    value={editing.cadence}
                    onValueChange={(v) =>
                      setEditing({ ...editing, cadence: v as Cadence })
                    }
                  >
                    <SelectTrigger data-testid="select-cadence">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily (yesterday)</SelectItem>
                      <SelectItem value="weekly">Weekly (last 7 days)</SelectItem>
                      <SelectItem value="monthly">Monthly (prev month)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end gap-2 pb-2">
                  <Checkbox
                    id="schedule-enabled"
                    checked={editing.enabled}
                    onCheckedChange={(v) =>
                      setEditing({ ...editing, enabled: v === true })
                    }
                  />
                  <Label htmlFor="schedule-enabled">Enabled</Label>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="schedule-recipients">
                  Recipients (comma-, semicolon-, or newline-separated)
                </Label>
                <Textarea
                  id="schedule-recipients"
                  value={editing.recipientsText}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      recipientsText: e.target.value,
                    })
                  }
                  rows={3}
                  placeholder="alice@example.com, bob@example.com"
                  data-testid="input-recipients"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Status filter</Label>
                  <Select
                    value={editing.filterStatus}
                    onValueChange={(v) =>
                      setEditing({
                        ...editing,
                        filterStatus: v as FilterStatus,
                      })
                    }
                  >
                    <SelectTrigger data-testid="select-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="posted">Posted only</SelectItem>
                      <SelectItem value="reversed">Reversed only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Source filter</Label>
                  <Select
                    value={editing.filterSource}
                    onValueChange={(v) =>
                      setEditing({
                        ...editing,
                        filterSource: v as FilterSource,
                      })
                    }
                  >
                    <SelectTrigger data-testid="select-source">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All sources</SelectItem>
                      <SelectItem value="copilot">Copilot</SelectItem>
                      <SelectItem value="manual">Manual</SelectItem>
                      <SelectItem value="expense">From expenses</SelectItem>
                      <SelectItem value="bill">From bills</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Posted by</Label>
                  <Select
                    value={editing.postedByFilter}
                    onValueChange={(v) =>
                      setEditing({ ...editing, postedByFilter: v })
                    }
                  >
                    <SelectTrigger data-testid="select-posted-by">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Anyone</SelectItem>
                      {posters.map((u) => (
                        <SelectItem
                          key={u.id}
                          value={String(u.id)}
                          data-testid={`option-posted-by-${u.id}`}
                        >
                          {actorName({
                            id: u.id,
                            firstName: u.firstName ?? null,
                            lastName: u.lastName ?? null,
                            email: u.email ?? null,
                          })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Approver</Label>
                  <Select
                    value={editing.approverFilter}
                    onValueChange={(v) =>
                      setEditing({ ...editing, approverFilter: v })
                    }
                  >
                    <SelectTrigger data-testid="select-approver">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Anyone</SelectItem>
                      {approvers.length === 0 ? (
                        <SelectItem value="__none__" disabled>
                          No copilot approvals yet
                        </SelectItem>
                      ) : (
                        approvers.map((u) => (
                          <SelectItem
                            key={u.id}
                            value={String(u.id)}
                            data-testid={`option-approver-${u.id}`}
                          >
                            {actorName({
                              id: u.id,
                              firstName: u.firstName ?? null,
                              lastName: u.lastName ?? null,
                              email: u.email ?? null,
                            })}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="schedule-include-lines"
                  checked={editing.includeLines}
                  onCheckedChange={(v) =>
                    setEditing({ ...editing, includeLines: v === true })
                  }
                />
                <Label htmlFor="schedule-include-lines">
                  Include line-level rows (one row per debit/credit)
                </Label>
              </div>
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="outline"
              onClick={previewCsv}
              disabled={previewing}
              data-testid="button-preview-csv"
              title="Download the CSV the next scheduled run would send"
            >
              <Download className="h-4 w-4 mr-1" />
              {previewing ? "Preparing…" : "Preview CSV"}
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                onClick={submitForm}
                disabled={createMut.isPending || updateMut.isPending}
                data-testid="button-save"
              >
                {editing?.id === null ? "Create" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={deletingId !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete schedule?</DialogTitle>
            <DialogDescription>
              This stops future runs for this schedule and removes its send-log
              history. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeletingId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMut.isPending}
              onClick={() => {
                if (deletingId !== null)
                  deleteMut.mutate({ id: deletingId });
              }}
              data-testid="button-confirm-delete"
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
