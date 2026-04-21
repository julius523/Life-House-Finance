/**
 * Task #103 — shared output contract for the Integrity Sweep detection
 * layer. Pure type definitions with frozen enums; no runtime deps so
 * both the api-server route and any future UI client can import the
 * same names without dragging in Drizzle.
 *
 * The shape returned by the sweep service is locked: see task-103.md.
 */

export const INTEGRITY_CATEGORIES = [
  "structural",
  "status_mismatch",
  "missing_bridge",
  "reversal",
  "posted_line",
  "remediation",
] as const;
export type IntegrityCategory = (typeof INTEGRITY_CATEGORIES)[number];

export const INTEGRITY_SEVERITIES = ["info", "warning", "critical"] as const;
export type IntegritySeverity = (typeof INTEGRITY_SEVERITIES)[number];

export const INTEGRITY_SAMPLE_KINDS = [
  "expense",
  "bill",
  "journal_entry",
  "draft",
  "source_link",
  "other",
] as const;
export type IntegritySampleKind = (typeof INTEGRITY_SAMPLE_KINDS)[number];

/**
 * Cap on `sampleRefs[].length` per check. The full affected count is
 * always reported on `IntegrityCheckResult.count` regardless of cap.
 */
export const INTEGRITY_SAMPLE_CAP = 25;

export type IntegritySampleRef = {
  kind: IntegritySampleKind;
  /** Numeric IDs serialized as strings to preserve precision over the wire. */
  id: string;
};

export type IntegrityCheckResult = {
  /** Stable machine identifier; matches the sweep.sql check name 1:1. */
  key: string;
  /** Human label for operator-facing summaries. */
  name: string;
  category: IntegrityCategory;
  severity: IntegritySeverity;
  /** Full affected count (NOT capped). */
  count: number;
  /** Up to {@link INTEGRITY_SAMPLE_CAP} affected entity references. */
  sampleRefs: IntegritySampleRef[];
};

export type IntegritySweepReport = {
  generatedAt: string;
  ok: boolean;
  totalChecks: number;
  failingChecks: number;
  checks: IntegrityCheckResult[];
};
