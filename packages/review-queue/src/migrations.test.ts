import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, runMigrations, type Migration } from "./migrations.js";

// Same real-Postgres-or-skip pattern as postgres-store.test.ts — see that file's
// comment for why this isn't a hard failure when TEST_DATABASE_URL is unset.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("runMigrations", () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });

  beforeEach(async () => {
    // Full reset, not TRUNCATE — these tests need to observe migrations actually
    // (re-)running from a clean slate, including the tracking table itself. Also
    // drops the incidental tables individual tests create (this_will_fail,
    // flaky_table) — leaving those behind after a failed/interrupted run would
    // make a later run fail with a stale "already exists" unrelated to what
    // that run is actually testing.
    await pool.query("DROP TABLE IF EXISTS review_items, schema_migrations, this_will_fail, flaky_table CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies every migration to a fresh database and records each as applied", async () => {
    await runMigrations(pool);

    const { rows } = await pool.query("SELECT id FROM schema_migrations ORDER BY applied_at");
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));

    // The real effect of 0001_create_review_items — not just the tracking row.
    const tableCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'review_items' ORDER BY column_name"
    );
    expect(tableCheck.rows.map((r) => r.column_name).sort()).toEqual(
      ["created_at", "data", "id", "niche", "platform", "status"].sort()
    );
  });

  it("is idempotent — running it again against an already-migrated database is a no-op", async () => {
    await runMigrations(pool);
    await runMigrations(pool); // must not throw (e.g. re-running CREATE TABLE) or duplicate tracking rows

    const { rows } = await pool.query("SELECT id FROM schema_migrations");
    expect(rows).toHaveLength(MIGRATIONS.length);
  });

  it("only applies migrations not yet recorded — a pre-seeded tracking row is treated as already done", async () => {
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [MIGRATIONS[0].id]);

    // review_items was never actually created, but the tracking table claims it was —
    // runMigrations should trust that record and not attempt 0001 again.
    await runMigrations(pool);

    const tableExists = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'review_items')"
    );
    expect(tableExists.rows[0].exists).toBe(false);
  });

  it("rolls back and does not record a migration as applied if it fails partway through", async () => {
    const brokenMigration: Migration = {
      id: "9999_broken_on_purpose",
      sql: "CREATE TABLE this_will_fail (id TEXT PRIMARY KEY); THIS IS NOT VALID SQL;"
    };

    await expect(runMigrations(pool, [brokenMigration])).rejects.toThrow();

    const recorded = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE id = $1",
      [brokenMigration.id]
    );
    expect(recorded.rows).toHaveLength(0);
    // The valid part of the broken migration (the CREATE TABLE before the invalid
    // statement) must not have survived either — the whole transaction rolled back.
    const partialTableExists = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'this_will_fail')"
    );
    expect(partialTableExists.rows[0].exists).toBe(false);
  });

  it("retries a previously-failed migration on the next call instead of skipping it forever", async () => {
    const flakyId = "9998_flaky";
    const brokenSql = "THIS IS NOT VALID SQL;";
    const fixedSql = "CREATE TABLE flaky_table (id TEXT PRIMARY KEY);";

    await expect(runMigrations(pool, [{ id: flakyId, sql: brokenSql }])).rejects.toThrow();
    // Same id, now with valid SQL — simulates fixing the migration and redeploying.
    await runMigrations(pool, [{ id: flakyId, sql: fixedSql }]);

    const recorded = await pool.query("SELECT 1 FROM schema_migrations WHERE id = $1", [flakyId]);
    expect(recorded.rows).toHaveLength(1);
    const tableExists = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'flaky_table')"
    );
    expect(tableExists.rows[0].exists).toBe(true);
  });
});
