import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // postgres-store.test.ts and migrations.test.ts both run real DDL (CREATE/DROP
    // TABLE) against the same live TEST_DATABASE_URL — Vitest's default parallel
    // file execution let one file's DROP TABLE race another file's CREATE TABLE
    // against that shared external database. db.test.ts (the JSON-store suite) has
    // no such shared external state, so this only costs a little wall-clock time,
    // not correctness elsewhere.
    fileParallelism: false
  }
});
