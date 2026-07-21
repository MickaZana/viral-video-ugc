import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/review-queue/package.json", import.meta.url));
const pg = require("pg");

const entries = new Map(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((entry) => entry && !entry.trimStart().startsWith("#") && entry.includes("="))
    .map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
    })
);
const connectionString = entries.get("DATABASE_URL") || entries.get("SUPABASE_DATABASE_URL");

if (!connectionString) {
  console.error("connected=false reason=DATABASE_URL_or_SUPABASE_DATABASE_URL_missing");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 1
});

try {
  if (process.argv.includes("--migrate")) {
    const { runMigrations } = await import("../packages/review-queue/dist/migrations.js");
    await runMigrations(pool);
  }
  const { rows } = await pool.query(`
    SELECT
      current_setting('server_version') AS version,
      has_database_privilege(current_user, current_database(), 'CREATE') AS can_create
  `);
  console.log(`connected=true version=${rows[0].version} createPrivilege=${rows[0].can_create} migrated=${process.argv.includes("--migrate")}`);
} catch (error) {
  console.error(`connected=false code=${error.code ?? "unknown"} reason=${String(error.message).replace(/postgres(?:ql)?:\/\/\\S+/gi, "[redacted]")}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
