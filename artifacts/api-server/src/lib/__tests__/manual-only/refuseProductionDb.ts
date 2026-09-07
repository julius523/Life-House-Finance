// Shared guard for every test in this directory. These suites disable the
// posted-entry immutability triggers with `ALTER TABLE ... DISABLE TRIGGER`
// and only re-enable them in a `finally` — safe only against a real,
// dedicated test database. No such database has been provisioned yet for
// this project (needs a human with Neon account access to create a
// separate branch), and until it exists, DATABASE_URL is the same
// connection string production uses. Confirmed live 2026-09-07: these
// suites had been running — and disabling those triggers — against the
// real production database on every single deploy, since the test runner's
// glob used to include this directory. Moving them to manual-only/ stops
// that; this guard is the hard floor under someone running one by hand.
export function refuseIfProductionDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (url.includes("ep-noisy-breeze-artb115q")) {
    throw new Error(
      "This suite refuses to run against the production database (DATABASE_URL " +
      "points at the known production Neon endpoint). It disables immutability " +
      "triggers mid-test — it must only ever run against a dedicated test database. " +
      "Point DATABASE_URL at a separate Neon branch before running it.",
    );
  }
}
