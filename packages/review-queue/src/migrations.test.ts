import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@vvugc/shared-persistence";
import { MIGRATIONS, runMigrations, type Migration } from "./migrations.js";

// Same real-Postgres-or-skip pattern as postgres-store.test.ts — see that file's
// comment for why this isn't a hard failure when TEST_DATABASE_URL is unset.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("runMigrations", () => {
  let testDatabase: IsolatedTestDatabase;

  beforeEach(async () => {
    if (!testDatabase) testDatabase = await createIsolatedTestDatabase();

    // Full reset, not TRUNCATE — these tests need to observe migrations actually
    // (re-)running from a clean slate, including the tracking table itself. Also
    // drops the incidental tables individual tests create (this_will_fail,
    // flaky_table) — leaving those behind after a failed/interrupted run would
    // make a later run fail with a stale "already exists" unrelated to what
    // that run is actually testing.
    await testDatabase.resetTables(["review_items", "pipeline_jobs", "schema_migrations", "this_will_fail", "flaky_table"]);
  });

  afterAll(async () => {
    await testDatabase?.dispose();
  });

  it("applies every migration to a fresh database and records each as applied", async () => {
    await runMigrations(testDatabase.pool);

    const { rows } = await testDatabase.pool.query("SELECT id FROM schema_migrations ORDER BY applied_at");
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));

    // The real effect of 0001_create_review_items + 0002_add_tenant_scope — not
    // just the tracking row. Keep this column list in sync with MIGRATIONS.
    // information_schema.columns spans every schema in the database, not just
    // this pool's own — under real file-parallel execution (fileParallelism:
    // true, see this repo's other Postgres suites concurrently creating their
    // own same-named review_items table in their own isolated schema) an
    // unscoped query here picks up columns from those sibling schemas too.
    // current_schema() is exactly this pool's isolated schema (set via its
    // search_path in createIsolatedTestDatabase), so scoping to it is what
    // actually makes this test schema-isolated, not just schema-labeled.
    const tableCheck = await testDatabase.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'review_items' ORDER BY column_name"
    );
    expect(tableCheck.rows.map((r) => r.column_name).sort()).toEqual(
      ["client_id", "created_at", "data", "id", "niche", "org_id", "platform", "status"].sort()
    );
  });

  it("is idempotent — running it again against an already-migrated database is a no-op", async () => {
    await runMigrations(testDatabase.pool);
    await runMigrations(testDatabase.pool); // must not throw (e.g. re-running CREATE TABLE) or duplicate tracking rows

    const { rows } = await testDatabase.pool.query("SELECT id FROM schema_migrations");
    expect(rows).toHaveLength(MIGRATIONS.length);
  });

  it("only applies migrations not yet recorded — a pre-seeded tracking row is treated as already done", async () => {
    await testDatabase.pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    // Seed EVERY migration id — later migrations depend on tables earlier ones
    // create (0002 ALTERs review_items, 0003 creates pipeline_jobs), so seeding
    // only the first would make a real later migration fail against a missing
    // table instead of testing the skip behavior this test is about.
    for (const m of MIGRATIONS) {
      await testDatabase.pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
    }

    // None of the real tables were ever created, but the tracking table claims
    // every migration ran — runMigrations must trust that record and re-run nothing.
    await runMigrations(testDatabase.pool);

    const { rows } = await testDatabase.pool.query("SELECT id FROM schema_migrations");
    expect(rows).toHaveLength(MIGRATIONS.length);

    for (const table of ["review_items", "pipeline_jobs"]) {
      // Same cross-schema leak as the column-list check above: unscoped, this
      // sees other suites' concurrently-created same-named tables in their
      // own isolated schema and reports a false positive.
      const tableExists = await testDatabase.pool.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1)",
        [table]
      );
      expect(tableExists.rows[0].exists).toBe(false);
    }
  });

  it("rolls back and does not record a migration as applied if it fails partway through", async () => {
    const brokenMigration: Migration = {
      id: "9999_broken_on_purpose",
      sql: "CREATE TABLE this_will_fail (id TEXT PRIMARY KEY); THIS IS NOT VALID SQL;"
    };

    await expect(runMigrations(testDatabase.pool, [brokenMigration])).rejects.toThrow();

    const recorded = await testDatabase.pool.query(
      "SELECT 1 FROM schema_migrations WHERE id = $1",
      [brokenMigration.id]
    );
    expect(recorded.rows).toHaveLength(0);
    // The valid part of the broken migration (the CREATE TABLE before the invalid
    // statement) must not have survived either — the whole transaction rolled back.
    const partialTableExists = await testDatabase.pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'this_will_fail')"
    );
    expect(partialTableExists.rows[0].exists).toBe(false);
  });

  it("retries a previously-failed migration on the next call instead of skipping it forever", async () => {
    const flakyId = "9998_flaky";
    const brokenSql = "THIS IS NOT VALID SQL;";
    const fixedSql = "CREATE TABLE flaky_table (id TEXT PRIMARY KEY);";

    await expect(runMigrations(testDatabase.pool, [{ id: flakyId, sql: brokenSql }])).rejects.toThrow();
    // Same id, now with valid SQL — simulates fixing the migration and redeploying.
    await runMigrations(testDatabase.pool, [{ id: flakyId, sql: fixedSql }]);

    const recorded = await testDatabase.pool.query("SELECT 1 FROM schema_migrations WHERE id = $1", [flakyId]);
    expect(recorded.rows).toHaveLength(1);
    const tableExists = await testDatabase.pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'flaky_table')"
    );
    expect(tableExists.rows[0].exists).toBe(true);
  });
});
