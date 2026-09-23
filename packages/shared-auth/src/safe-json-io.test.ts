import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeReadJson, safeWriteJson } from "./safe-json-io.js";

describe("safeReadJson", () => {
  let dir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function freshPath(name = "data.json"): string {
    dir = mkdtempSync(join(tmpdir(), "safe-json-"));
    return join(dir, name);
  }

  it("returns the fallback when the file does not exist", () => {
    const path = freshPath();
    const fallback = [{ id: 1 }];
    expect(safeReadJson(path, fallback)).toBe(fallback);
  });

  it("returns the fallback for an empty file", () => {
    const path = freshPath();
    writeFileSync(path, "");
    expect(safeReadJson(path, { ok: false })).toEqual({ ok: false });
  });

  it("returns the fallback for a whitespace-only file", () => {
    const path = freshPath();
    writeFileSync(path, "  \n\t ");
    expect(safeReadJson(path, { ok: false })).toEqual({ ok: false });
  });

  it("parses valid JSON", () => {
    const path = freshPath();
    writeFileSync(path, JSON.stringify({ count: 3, names: ["a", "b"] }));
    expect(safeReadJson(path, { count: 0, names: [] as string[] })).toEqual({ count: 3, names: ["a", "b"] });
  });

  it("quarantines a corrupted file, logs critically, and returns the fallback instead of throwing", () => {
    const path = freshPath();
    writeFileSync(path, '{"broken": ');
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const fallback = { safe: true };
    const result = safeReadJson(path, fallback);

    expect(result).toBe(fallback);
    expect(existsSync(path)).toBe(false);
    const quarantined = readdirSync(dir).filter((f) => f.startsWith("data.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dir, quarantined[0]), "utf-8")).toBe('{"broken": ');
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = String(errSpy.mock.calls[0][0]);
    expect(logged).toContain("[CRITICAL]");
    expect(logged).toContain("quarantined");
  });
});

describe("safeWriteJson", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function freshPath(name = "data.json"): string {
    dir = mkdtempSync(join(tmpdir(), "safe-json-w-"));
    return join(dir, name);
  }

  it("creates missing parent directories and writes parseable JSON", () => {
    freshPath(); // initializes dir
    const path = join(dir, "nested", "deep", "data.json");
    safeWriteJson(path, { hello: "world" });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ hello: "world" });
  });

  it("leaves no temp files behind (write-then-rename completes atomically)", () => {
    const path = freshPath();
    safeWriteJson(path, [1, 2, 3]);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(safeReadJson(path, [])).toEqual([1, 2, 3]);
  });

  it("overwrites existing content entirely", () => {
    const path = freshPath();
    safeWriteJson(path, { version: 1, payload: "old" });
    safeWriteJson(path, { version: 2 });
    expect(safeReadJson(path, { version: 0 })).toEqual({ version: 2 });
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("round-trips with safeReadJson", () => {
    const path = freshPath("roundtrip.json");
    const data = { items: [{ id: "a" }, { id: "b" }], total: 2 };
    safeWriteJson(path, data);
    expect(safeReadJson(path, { items: [], total: 0 })).toEqual(data);
  });
});
