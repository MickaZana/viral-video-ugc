import { describe, expect, it } from "vitest";
import { assertTestDatabaseConnectionString, resetTestTables, type IsolatedTestDatabase } from "./database.js";

describe("test database guard", () => {
  it("requires an exact test URL that names a dedicated vvugc test database", () => {
    const testUrl = "postgres://user:pass@localhost:5432/vvugc_test";
    expect(() => assertTestDatabaseConnectionString(testUrl, testUrl)).not.toThrow();
    expect(() => assertTestDatabaseConnectionString("postgres://user:pass@localhost:5432/postgres", "postgres://user:pass@localhost:5432/postgres")).toThrow(/vvugc_test/i);
    expect(() => assertTestDatabaseConnectionString(testUrl, "postgres://user:pass@localhost:5432/vvugc_test_other")).toThrow(/exact/i);
  });

  it("refuses a reset handle that was not created by the isolated test factory", async () => {
    const arbitrary = { pool: {} as IsolatedTestDatabase["pool"], schema: "vvugc_test_fake" } as IsolatedTestDatabase;
    await expect(resetTestTables(arbitrary, ["review_items"])).rejects.toThrow(/isolated test database/i);
  });
});
