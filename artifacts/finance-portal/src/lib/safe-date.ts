// Task #60 — defensive date helpers used by reporting surfaces.
//
// Why these exist:
// The Reports page uses native <input type="date"> controls that emit ""
// while the user is mid-edit (or after they clear the field). Passing ""
// (or any non-ISO string) into `new Date(...)` yields an Invalid Date,
// and date-fns `format()` throws RangeError on Invalid Date — which
// previously bubbled up and white-screened the entire page.
//
// These helpers let callers (a) gate query hooks on a valid range and
// (b) format dates without crashing on partial or empty input.

import { format } from "date-fns";

/** True iff `s` is a complete YYYY-MM-DD string for a real calendar date. */
export function isValidYmd(s: string | null | undefined): boolean {
  if (!s || typeof s !== "string") return false;
  // Strict YYYY-MM-DD shape — disallow partial input like "2025-01-1".
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Reject 2025-02-30 (round-trips to 2025-03-02, etc.).
  return d.toISOString().slice(0, 10) === s;
}

/** True iff both bounds are valid YMD strings AND from <= to. */
export function isValidRange(from: string, to: string): boolean {
  return isValidYmd(from) && isValidYmd(to) && from <= to;
}

/**
 * Format a date string with date-fns without throwing on invalid input.
 * Returns `fallback` (default "—") when the input is missing or unparsable.
 */
export function safeFormatDate(
  value: string | Date | null | undefined,
  fmt: string,
  fallback = "—",
): string {
  if (value === null || value === undefined || value === "") return fallback;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  try {
    return format(d, fmt);
  } catch {
    return fallback;
  }
}
