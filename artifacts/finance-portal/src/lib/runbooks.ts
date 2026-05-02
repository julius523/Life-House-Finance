const rawModules = import.meta.glob("../../../../docs/runbooks/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

export type RunbookSlug =
  | "index"
  | "submit-expense"
  | "review-approve-expense"
  | "enter-bill-record-payment"
  | "post-manual-journal-entry"
  | "resolve-blocked-queue"
  | "month-end-close"
  | "reports-and-scheduled-exports"
  | "invite-manage-users";

export type Runbook = {
  slug: RunbookSlug;
  title: string;
  body: string;
};

const TITLES: Record<RunbookSlug, string> = {
  "index": "5-minute tour",
  "submit-expense": "Submit an expense",
  "review-approve-expense": "Review and approve an expense",
  "enter-bill-record-payment": "Enter a bill and record its payment",
  "post-manual-journal-entry": "Post a manual journal entry",
  "resolve-blocked-queue": "Resolve a blocked-queue item",
  "month-end-close": "Run a month-end close",
  "reports-and-scheduled-exports": "Generate and share a report",
  "invite-manage-users": "Invite and manage users",
};

const ORDER: RunbookSlug[] = [
  "index",
  "submit-expense",
  "review-approve-expense",
  "enter-bill-record-payment",
  "post-manual-journal-entry",
  "resolve-blocked-queue",
  "month-end-close",
  "reports-and-scheduled-exports",
  "invite-manage-users",
];

function loadRunbooks(): Record<RunbookSlug, Runbook> {
  const out = {} as Record<RunbookSlug, Runbook>;
  for (const [path, body] of Object.entries(rawModules)) {
    const file = path.split("/").pop() ?? "";
    const slug = file.replace(/\.md$/, "") as RunbookSlug;
    if (!(slug in TITLES)) continue;
    out[slug] = { slug, title: TITLES[slug], body };
  }
  return out;
}

const REGISTRY = loadRunbooks();

export function getRunbook(slug: RunbookSlug): Runbook | undefined {
  return REGISTRY[slug];
}

export function listRunbooks(): Runbook[] {
  return ORDER.map((slug) => REGISTRY[slug]).filter(
    (r): r is Runbook => Boolean(r),
  );
}

export const HELP_OPEN_EVENT = "lh:open-help";

export function openHelp(slug: RunbookSlug = "index") {
  window.dispatchEvent(
    new CustomEvent<RunbookSlug>(HELP_OPEN_EVENT, { detail: slug }),
  );
}
