import { describe, it, expect } from "vitest";
import { isValidYmd, isValidRange, safeFormatDate } from "./safe-date";

describe("safe-date helpers", () => {
  describe("isValidYmd", () => {
    it("accepts a complete YYYY-MM-DD date", () => {
      expect(isValidYmd("2025-01-15")).toBe(true);
    });

    it("rejects partial dates a user might type mid-edit", () => {
      expect(isValidYmd("2025-01-1")).toBe(false);
      expect(isValidYmd("2025-01")).toBe(false);
      expect(isValidYmd("2025-")).toBe(false);
      expect(isValidYmd("2025")).toBe(false);
    });

    it("rejects empty/missing values", () => {
      expect(isValidYmd("")).toBe(false);
      expect(isValidYmd(null)).toBe(false);
      expect(isValidYmd(undefined)).toBe(false);
    });

    it("rejects calendar-impossible dates", () => {
      expect(isValidYmd("2025-02-30")).toBe(false);
      expect(isValidYmd("2025-13-01")).toBe(false);
    });
  });

  describe("isValidRange", () => {
    it("accepts a well-formed range", () => {
      expect(isValidRange("2025-01-01", "2025-01-31")).toBe(true);
    });

    it("rejects an inverted range (from > to)", () => {
      expect(isValidRange("2025-02-01", "2025-01-01")).toBe(false);
    });

    it("rejects partial input on either side", () => {
      expect(isValidRange("2025-01-1", "2025-01-31")).toBe(false);
      expect(isValidRange("2025-01-01", "")).toBe(false);
    });
  });

  describe("safeFormatDate", () => {
    it("formats a valid date string without throwing", () => {
      expect(safeFormatDate("2025-01-15", "yyyy-MM-dd")).toBe("2025-01-15");
    });

    it("returns the fallback for empty/partial/invalid input instead of throwing", () => {
      // The whole point of this helper: passing partial input must NOT
      // throw `RangeError: Invalid time value` the way bare date-fns
      // `format(new Date(...), ...)` does.
      expect(() => safeFormatDate("", "yyyy-MM-dd")).not.toThrow();
      expect(() => safeFormatDate("2025-01-1", "yyyy-MM-dd")).not.toThrow();
      expect(() => safeFormatDate("not-a-date", "yyyy-MM-dd")).not.toThrow();
      expect(() => safeFormatDate(null, "yyyy-MM-dd")).not.toThrow();
      expect(() => safeFormatDate(undefined, "yyyy-MM-dd")).not.toThrow();

      expect(safeFormatDate("", "yyyy-MM-dd")).toBe("—");
      expect(safeFormatDate("not-a-date", "yyyy-MM-dd", "n/a")).toBe("n/a");
      expect(safeFormatDate(null, "yyyy-MM-dd")).toBe("—");
    });
  });
});
