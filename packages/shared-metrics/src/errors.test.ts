import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportError } from "./index.js";

describe("reportError", () => {
  let dir = "";
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("emits structured context and one durable NDJSON record", () => {
    dir = mkdtempSync(join(tmpdir(), "errors-"));
    const errorFile = join(dir, "nested", "errors.ndjson");
    const log = vi.fn();
    reportError(new Error("boom"), { requestId: "req-1" }, { service: "test", errorFile, log });
    const saved = JSON.parse(readFileSync(errorFile, "utf8").trim());
    expect(saved.service).toBe("test");
    expect(saved.requestId).toBe("req-1");
    expect(saved.error.message).toBe("boom");
    expect(log).toHaveBeenCalledOnce();
  });
});
