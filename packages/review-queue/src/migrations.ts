import type { Pool as PgPool } from "pg";

export interface Migration {
  id: string;
  sql: string;
}

/**
 * Ordered, one-way schema migrations — each `id` is applied at most once,
 * tracked in `schema_migrations`. Before this file existed, the Postgres store's
 * schema was a single hardcoded `CREATE TABLE IF NOT EXISTS`, with no way to
 * evolve it later without either editing that statement in place (silently
 * diverging from what's already deployed, since `IF NOT EXISTS` no-ops on an
 * existing table) or hand-writing a one-off ALTER TABLE someone has to remember
 * to run.
 *
 * Append new migrations to the END of this array; never edit or reorder one
 * that's already shipped — a database that already applied it won't re-run it,
 * so an in-place edit would silently diverge from what's actually deployed.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: "0001_create_review_items",
    sql: `
      CREATE TABLE IF NOT EXISTS review_items (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        niche TEXT NOT NULL,
        platform TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS review_items_created_at_idx ON review_items (created_at DESC);
      CREATE INDEX IF NOT EXISTS review_items_status_idx ON review_items (status);
    `
  }
];

const TRACKING_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * Applies every migration in `migrations` (defaults to the real `MIGRATIONS` list —
 * overriding it is for tests exercising this function's own error handling, not a
 * normal call site) not yet recorded in `schema_migrations`, in order, each inside
 * its own transaction — a failure partway through a migration rolls back instead of
 * leaving it half-applied-but-marked-done, so the next call retries it rather than
 * skipping it as already-done. Safe to call on every process startup: a
 * fully-migrated database just checks and returns.
 */
export async function runMigrations(pool: PgPool, migrations: Migration[] = MIGRATIONS): Promise<void> {
  await pool.query(TRACKING_TABLE_SQL);
  const { rows } = await pool.query("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.id as string));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
