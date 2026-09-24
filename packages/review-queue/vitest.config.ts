import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every real-Postgres suite now receives a factory-created, unique schema,
    // so DDL cannot collide even when this package is run beside other workspace
    // tests with the same TEST_DATABASE_URL.
    fileParallelism: true
  }
});
