const API_BASE = "/api";

export class ApiError extends Error {
  status: number;
  code: string | null;
  body: Record<string, unknown> | null;
  constructor(
    message: string,
    status: number,
    code: string | null,
    body: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function apiJson<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    credentials: "include",
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      // Non-JSON response body (e.g. HTML error page from a proxy). Surface
      // raw text via the thrown ApiError below so callers still get the
      // status code; structured `code` will simply be null.
      data = { error: text.slice(0, 500) };
    }
  }
  if (!res.ok) {
    const obj =
      data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const msg =
      (obj && typeof obj["error"] === "string" ? (obj["error"] as string) : null) ??
      `Request failed (${res.status})`;
    const code =
      obj && typeof obj["code"] === "string" ? (obj["code"] as string) : null;
    throw new ApiError(msg, res.status, code, obj);
  }
  return data as T;
}
