import app from "./app";
import { logger } from "./lib/logger";
import { seedUsers } from "./lib/seedUsers";
import { ensureTodaySnapshot } from "./lib/dailySnapshot";
import { seedChartOfAccountsAndSettings } from "./lib/seedChartOfAccounts";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

seedUsers()
  .catch((err) => {
    logger.error({ err }, "Failed to seed users");
  })
  .then(() => seedChartOfAccountsAndSettings())
  .then((r) => {
    logger.info(
      {
        accountsInserted: r?.accountsInserted ?? 0,
        settingsInserted: r?.settingsInserted ?? false,
        backfilledLines: r?.backfilledLines ?? 0,
        unmappedAccountCount: r?.unmappedAccounts.length ?? 0,
      },
      "Step 9: chart of accounts seed/backfill complete",
    );
  })
  .catch((err) => {
    logger.error({ err }, "Failed to seed chart of accounts / settings");
  })
  .then(() => ensureTodaySnapshot())
  .catch((err) => {
    logger.error({ err }, "Failed to capture daily snapshot at boot");
  });

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
