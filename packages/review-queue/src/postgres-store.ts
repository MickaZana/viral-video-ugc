import type { Pool as PgPool } from "pg";
import type { ReviewItem } from "@vvugc/shared-schema";
import { runMigrations } from "./migrations.js";
import type { ReviewQueueStore } from "./store.js";

/**
 * Postgres-backed store — used when DATABASE_URL is set (see db.ts). Safe across
 * any number of machines/processes: each write is a single-row transaction
 * handled by Postgres itself, not a whole-file read-modify-write behind a
 * hand-rolled lock (compare json-store.ts). Required once the dashboard and
 * orchestrator no longer share a filesystem — e.g. dashboard as a long-running
 * hosted service, orchestrator as a GitHub Actions job. See
 * packages/review-queue/README.md.
 *
 * The whole ReviewItem is stored as JSONB in `data`; `status`/`niche`/`platform`/
 * `created_at` are denormalized into real columns so listReviewItems can filter/sort
 * in SQL instead of loading every row. Table shape lives in migrations.ts, not
 * inline here — see that file for how to evolve the schema later.
 */
function rowToItem(row: { data: ReviewItem }): ReviewItem {
  return row.data;
}

export function createPostgresStore(pool: PgPool): ReviewQueueStore {
  let schemaReady: Promise<void> | undefined;
  function ensureSchema(): Promise<void> {
    if (!schemaReady) {
      // Clear the memoized promise on failure (e.g. a transient connection drop
      // during startup) so the next call retries the migration run instead of
      // replaying the same rejection forever.
      schemaReady = runMigrations(pool).then(
        () => undefined,
        (err) => {
          schemaReady = undefined;
          throw err;
        }
      );
    }
    return schemaReady;
  }

  return {
    async insertReviewItem(item) {
      await ensureSchema();
      await pool.query(
        `INSERT INTO review_items (id, status, niche, platform, created_at, data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [item.id, item.status, item.niche, item.platform, item.createdAt, JSON.stringify(item)]
      );
    },

    async listReviewItems(filter) {
      await ensureSchema();
      const conditions: string[] = [];
      const params: string[] = [];
      if (filter?.status) {
        params.push(filter.status);
        conditions.push(`status = $${params.length}`);
      }
      if (filter?.niche) {
        params.push(filter.niche);
        conditions.push(`niche = $${params.length}`);
      }
      if (filter?.platform) {
        params.push(filter.platform);
        conditions.push(`platform = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const { rows } = await pool.query(`SELECT data FROM review_items ${where} ORDER BY created_at DESC`, params);
      return rows.map(rowToItem);
    },

    async getReviewItem(id) {
      await ensureSchema();
      const { rows } = await pool.query(`SELECT data FROM review_items WHERE id = $1`, [id]);
      return rows[0] ? rowToItem(rows[0]) : undefined;
    },

    async setReviewItemStatus(id, status) {
      await ensureSchema();
      await pool.query(
        `UPDATE review_items SET status = $2, data = jsonb_set(data, '{status}', to_jsonb($2::text)) WHERE id = $1`,
        [id, status]
      );
    },

    async setReviewItemsStatus(ids, status) {
      await ensureSchema();
      if (ids.length === 0) return [];
      const { rows } = await pool.query(
        `UPDATE review_items SET status = $1, data = jsonb_set(data, '{status}', to_jsonb($1::text))
         WHERE id = ANY($2::text[]) RETURNING id`,
        [status, ids]
      );
      return rows.map((r) => r.id as string);
    }
  };
}
