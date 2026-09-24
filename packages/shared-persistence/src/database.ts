import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

/** A one-way, ordered database change. IDs are global to one database. */
export interface Migration { readonly id: string; readonly sql: string; }
export type SqlMigration = Readonly<Migration>;

export function defineMigration(id: string, sql: string): SqlMigration {
  if (!/^\d{4}_[a-z0-9_]+$/.test(id)) throw new Error(`Migration id must use the NNNN_description format: ${id}`);
  if (!sql.trim()) throw new Error(`Migration ${id} must contain SQL.`);
  return Object.freeze({ id, sql });
}

const TRACKING_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

function validateMigrations(migrations: readonly SqlMigration[]): void {
  const ids = new Set<string>();
  let previous = "";
  for (const migration of migrations) {
    defineMigration(migration.id, migration.sql);
    if (ids.has(migration.id)) throw new Error(`Duplicate migration id: ${migration.id}`);
    if (previous && migration.id <= previous) throw new Error(`Migrations must be strictly ordered: ${migration.id} follows ${previous}`);
    ids.add(migration.id);
    previous = migration.id;
  }
}

/** The workspace's sole migration executor, serialized across instances by an advisory lock. */
export async function runMigrations(pool: Pool, migrations: readonly SqlMigration[]): Promise<void> {
  validateMigrations(migrations);
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('vvugc_schema_migrations'))");
    locked = true;
    await client.query(TRACKING_TABLE_SQL);
    const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await withTransaction(client, async (transaction) => {
        await transaction.query(migration.sql);
        await transaction.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
      });
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('vvugc_schema_migrations'))").catch(() => undefined);
    client.release();
  }
}

export async function withTransaction<T>(client: Pool | PoolClient, operation: (transaction: PoolClient) => Promise<T>): Promise<T> {
  const ownsClient = client instanceof Pool;
  const transaction: PoolClient = ownsClient ? await client.connect() : client;
  try {
    await transaction.query("BEGIN");
    const result = await operation(transaction);
    await transaction.query("COMMIT");
    return result;
  } catch (error) {
    await transaction.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (ownsClient) transaction.release();
  }
}

export interface PostgresDatabase {
  readonly pool: Pool;
  migrate(migrations: readonly SqlMigration[]): Promise<void>;
  transaction<T>(operation: (transaction: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Owns one raw pg Pool and provides explicit shutdown for process lifecycle hooks. */
export function createPostgresDatabase(config: PoolConfig): PostgresDatabase {
  const pool = new Pool(config);
  return { pool, migrate: (migrations) => runMigrations(pool, migrations), transaction: <T>(operation: (transaction: PoolClient) => Promise<T>) => withTransaction(pool, operation), close: () => pool.end() };
}

const TEST_SCHEMA_PREFIX = "vvugc_test_";
const isolatedTestPools = new WeakMap<Pool, string>();

function quoteIdentifier(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"`; }

/** Rejects connection strings that are not explicitly aimed at a vvugc test database. */
export function assertTestDatabaseConnectionString(connectionString: string, expectedTestUrl = process.env.TEST_DATABASE_URL): void {
  if (!expectedTestUrl || connectionString !== expectedTestUrl) {
    throw new Error("An isolated test database must use the exact TEST_DATABASE_URL connection string.");
  }
  const databaseName = decodeURIComponent(new URL(connectionString).pathname).replace(/^\//, "");
  if (!/^vvugc_test(?:[_-][a-z0-9_-]+)?$/i.test(databaseName)) {
    throw new Error("TEST_DATABASE_URL must target a database named vvugc_test or vvugc_test_<suffix>.");
  }
}

export interface IsolatedTestDatabase {
  readonly pool: Pool;
  readonly schema: string;
  resetTables(tableNames: readonly string[]): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Creates a unique schema for one Postgres suite. The returned handle is the
 * only value accepted by resetTestTables, preventing accidental production-pool
 * DDL even when a process happens to have TEST_DATABASE_URL in its environment.
 */
export async function createIsolatedTestDatabase(connectionString = process.env.TEST_DATABASE_URL): Promise<IsolatedTestDatabase> {
  if (!connectionString) throw new Error("createIsolatedTestDatabase requires TEST_DATABASE_URL.");
  assertTestDatabaseConnectionString(connectionString);
  const schema = `${TEST_SCHEMA_PREFIX}${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    const { rows } = await admin.query<{ database: string }>("SELECT current_database() AS database");
    const databaseName = decodeURIComponent(new URL(connectionString).pathname).replace(/^\//, "");
    if (rows[0]?.database !== databaseName) throw new Error("TEST_DATABASE_URL resolved to an unexpected database.");
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const verification = await pool.query<{ schema: string | null }>("SELECT current_schema() AS schema");
    if (verification.rows[0]?.schema !== schema) throw new Error("Isolated test schema was not selected by the pool.");
    isolatedTestPools.set(pool, schema);
  } catch (error) {
    await pool.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw error;
  }
  let disposed = false;
  return {
    pool,
    schema,
    resetTables: (tableNames) => resetTestTables({ pool, schema } as IsolatedTestDatabase, tableNames),
    async dispose() {
      if (disposed) return;
      disposed = true;
      isolatedTestPools.delete(pool);
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  };
}

/** Test-only destructive reset for a handle created by createIsolatedTestDatabase. */
export async function resetTestTables(testDatabase: IsolatedTestDatabase, tableNames: readonly string[]): Promise<void> {
  const registeredSchema = isolatedTestPools.get(testDatabase.pool);
  if (!registeredSchema || registeredSchema !== testDatabase.schema || !testDatabase.schema.startsWith(TEST_SCHEMA_PREFIX)) {
    throw new Error("resetTestTables requires an isolated test database created by createIsolatedTestDatabase.");
  }
  if (tableNames.length === 0) return;
  for (const table of tableNames) if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Unsafe test table name: ${table}`);
  const { rows } = await testDatabase.pool.query<{ schema: string | null }>("SELECT current_schema() AS schema");
  if (rows[0]?.schema !== registeredSchema) throw new Error("Refusing to reset tables outside the isolated test schema.");
  await testDatabase.pool.query(`DROP TABLE IF EXISTS ${tableNames.join(", ")} CASCADE`);
}

export type QueryRow = QueryResultRow;
