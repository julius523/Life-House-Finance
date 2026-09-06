// Dependency-free .env -> safe shell `export` line converter, for deploy
// scripts that need real env vars in the *current* shell (not just a
// child process). Treats everything after the first `=` on each
// KEY=value line as a literal string -- no shell interpretation of
// &, #, $, etc. Needed because:
//   - plain `source .env` breaks on real values containing an unquoted
//     `&` (bash reads it as a background-job separator) -- confirmed
//     live against this app's real DATABASE_URL, 2026-09-06.
//   - `-r dotenv/config` isn't reliably resolvable from arbitrary
//     working directories in this pnpm workspace, and the api-server
//     bundle's own `import "dotenv/config"` gets tree-shaken out by
//     esbuild as an apparently-unused side-effect import -- confirmed
//     live: the built dist/index.mjs contains zero references to
//     "dotenv" despite the source importing it first-line.
//
// Usage: node scripts/env-to-exports.cjs <path-to-.env> > /tmp/x.sh && source /tmp/x.sh
const fs = require('fs');
const path = process.argv[2];
const lines = fs.readFileSync(path, 'utf8').split('\n');
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  const escaped = value.split("'").join("'\"'\"'");
  console.log(`export ${key}='${escaped}'`);
}
