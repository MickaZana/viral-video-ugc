import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordWaitlistSubmission, waitlistPath } from "./waitlist.js";

let testDir: string;

describe("recordWaitlistSubmission", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-waitlist-test-"));
    process.env.VVUGC_RUNS_DIR = testDir;
    delete process.env.WAITLIST_WEBHOOK_URL;
  });

  afterEach(() => {
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.WAITLIST_WEBHOOK_URL;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("rejects an invalid email without writing anything", async () => {
    const result = await recordWaitlistSubmission("not-an-email");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("valid email") });
    expect(existsSync(waitlistPath())).toBe(false);
  });

  it("rejects a missing/non-string email", async () => {
    expect((await recordWaitlistSubmission(undefined)).ok).toBe(false);
    expect((await recordWaitlistSubmission(42)).ok).toBe(false);
  });

  it("persists a valid email as a JSON line, creating the runs dir if needed", async () => {
    const result = await recordWaitlistSubmission("person@example.com");
    expect(result).toEqual({ ok: true });
    expect(existsSync(waitlistPath())).toBe(true);
    const line = JSON.parse(readFileSync(waitlistPath(), "utf-8").trim());
    expect(line.email).toBe("person@example.com");
    expect(line.submittedAt).toBeTruthy();
  });

  it("trims whitespace from the submitted email", async () => {
    await recordWaitlistSubmission("  person@example.com  ");
    const line = JSON.parse(readFileSync(waitlistPath(), "utf-8").trim());
    expect(line.email).toBe("person@example.com");
  });

  it("appends multiple submissions as separate lines", async () => {
    await recordWaitlistSubmission("a@example.com");
    await recordWaitlistSubmission("b@example.com");
    const lines = readFileSync(waitlistPath(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("forwards to WAITLIST_WEBHOOK_URL when configured, without blocking success on its outcome", async () => {
    process.env.WAITLIST_WEBHOOK_URL = "https://example.com/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const result = await recordWaitlistSubmission("person@example.com");

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.email).toBe("person@example.com");
  });

  it("still reports success and keeps the local record when the webhook forward fails", async () => {
    process.env.WAITLIST_WEBHOOK_URL = "https://example.com/hook";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error"))
    );

    const result = await recordWaitlistSubmission("person@example.com");

    expect(result).toEqual({ ok: true });
    expect(existsSync(waitlistPath())).toBe(true);
  });
});
