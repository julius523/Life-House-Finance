export type CsvCell = string | number | null | undefined;

export function csvEscape(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function csvPercent(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  return (Math.round(n * 10) / 10).toFixed(1);
}

export function rowsToCsv(rows: CsvCell[][]): string {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, rows: CsvCell[][]): void {
  const csv = "\uFEFF" + rowsToCsv(rows) + "\r\n";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function csvSafeDateRange(from: string, to: string): string {
  return `${from}_to_${to}`;
}
