const API_BASE = "/api";

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
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const msg =
      (data &&
        typeof data === "object" &&
        "error" in (data as Record<string, unknown>) &&
        typeof (data as Record<string, unknown>)["error"] === "string"
        ? ((data as Record<string, unknown>)["error"] as string)
        : null) ?? `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}
