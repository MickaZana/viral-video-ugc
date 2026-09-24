# @vvugc/review-queue

Stores the `ReviewItem`s the orchestrator produces and the review-dashboard approves/rejects. Two interchangeable backends behind the same function API (`insertReviewItem`, `listReviewItems`, `getReviewItem`, `setReviewItemStatus`, `setReviewItemsStatus`) — callers never know which one is active.

## Which backend, and when

| | JSON file (`json-store.ts`) | Postgres (`postgres-store.ts`) |
|---|---|---|
| Selected when | `DATABASE_URL` unset (default) | `DATABASE_URL` set |
| Safe for | Multiple processes **on one machine/filesystem** | Multiple processes **on any number of machines** |
| How writes are made safe | An exclusive lockfile serializes whole-file read-modify-write cycles | Real per-row `INSERT`/`UPDATE` transactions — Postgres handles concurrency itself |
| Setup cost | None — just a path on disk | A Postgres database (see below) |

**Use the default (JSON file)** for local development, `--dry-run`, and any single-machine deployment where the dashboard and orchestrator share a filesystem — e.g. the `docker-compose.yml` at the repo root, where both containers bind-mount the same `./runs` directory.

**Set `DATABASE_URL`** the moment the dashboard and orchestrator stop sharing a filesystem — the most common case is the dashboard deployed as a long-running hosted service while the orchestrator runs as a GitHub Actions job (`.github/workflows/weekly-run.yml`): two different machines, no shared disk, so the JSON file's lockfile guarantees don't apply at all. Without a real database in that setup, items the weekly job creates never reach the dashboard.

Getting a `DATABASE_URL`: any standard Postgres connection string works. A free tier from a managed host (e.g. Neon, Supabase, Railway) is the path of least cost/effort — no server to run yourself, reachable from both a hosted dashboard and a GitHub Actions runner.

## Schema and migrations

The Postgres backend's schema lives in `migrations.ts`, not inline in `postgres-store.ts` — an ordered `MIGRATIONS` array, each entry applied at most once and tracked in a shared `schema_migrations` table. The executor itself belongs to `@vvugc/shared-persistence`: it owns the advisory lock, transactions, and tracking table for all future domain migrations, so packages must register migrations with that one mechanism rather than create their own migration tables/runners. `postgres-store.ts` calls the review-queue wrapper lazily on first use (same "no separate step to remember" ergonomics as the old `CREATE TABLE IF NOT EXISTS` had), but the schema can now actually evolve: appending a new entry to `MIGRATIONS` is how you add a column/index/table later, instead of hand-editing the original `CREATE TABLE` (which would silently diverge from databases that already ran it, since `IF NOT EXISTS` is a no-op against an existing table).

Rules for adding a migration:
- Append to the **end** of the `MIGRATIONS` array in `migrations.ts` — never edit or reorder a migration that's already shipped.
- Give it a new, never-reused `id` (the existing convention is `NNNN_description`).
- Each migration runs inside its own transaction; if it throws partway through, the whole thing rolls back and is *not* recorded as applied, so the next call retries it rather than skipping it as done.

The full `ReviewItem` is stored as JSONB in `data`; `status`/`niche`/`platform`/`created_at` are denormalized into real columns so `listReviewItems` can filter/sort in SQL instead of loading every row into memory (which is exactly what the JSON-file backend has to do).

## Testing

- `db.test.ts` — the JSON-file backend, via the public `db.ts` API. Always runs.
- `postgres-store.test.ts` — the Postgres backend, direct against `postgres-store.ts`. Skips itself when `TEST_DATABASE_URL` is unset (e.g. a laptop without Postgres running); CI (`.github/workflows/ci.yml`) provisions a real `postgres:16-alpine` service container and sets it, so this suite runs for real on every push/PR, not just locally.
- `migrations.test.ts` — the migration runner itself: applies-on-fresh-database, idempotency, only-applies-what's-not-recorded, and rollback-without-recording on a deliberately broken migration. Same `TEST_DATABASE_URL` skip behavior as above.

Both real-Postgres suites run real DDL (`CREATE`/`DROP TABLE`) against the same database, so this package's `vitest.config.ts` disables file-level parallelism (`fileParallelism: false`) — otherwise one file's `DROP TABLE` can race another file's setup against that shared external resource. `db.test.ts` has no such shared state, so this only costs a little wall-clock time, not correctness.

To run the Postgres-backed suites locally: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vvugc_test postgres:16-alpine`, then `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/vvugc_test pnpm test`.
