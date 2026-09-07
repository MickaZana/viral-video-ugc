import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlanStore } from "@vvugc/shared-billing";
import { runDueClientSchedules } from "./scheduler.js";
import { LocalTenantProfileRepository } from "./tenant-profile-postgres.js";

let testDir: string;
let runsDir: string;

const ORG = "org-1";
const profiles = () => new LocalTenantProfileRepository(runsDir, "test-social-encryption-key-at-least-32-chars");

function seedWeeklyClientDueNow() {
  writeFileSync(
    join(runsDir, "agency-clients.json"),
    JSON.stringify([
      {
        id: "client-1",
        orgId: ORG,
        name: "Weekly Brand",
        niche: "fitness",
        brandVoice: "punchy",
        locale: "en",
        platforms: ["youtube_shorts"],
        targetDurationSec: 25,
        videoVendor: "higgsfield",
        cadence: "weekly",
        active: true,
        nextRunAt: new Date(Date.now() - 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ])
  );
}

function seedRunManifest(runId: string) {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      config: { accountId: ORG, niche: "fitness", createdAt: new Date().toISOString() },
      reviewItemsCreated: 1
    })
  );
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "vvugc-scheduler-quota-"));
  runsDir = join(testDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  process.env.VVUGC_RUNS_DIR = runsDir;
  // Keep the pipeline-job store on its JSON fallback.
  delete process.env.DATABASE_URL;
  delete process.env.SUPABASE_DATABASE_URL;
});

afterEach(() => {
  delete process.env.VVUGC_RUNS_DIR;
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("client scheduler enqueue-time quota", () => {
  it("enqueues a due weekly client past its monthly run limit as consumption overage rather than skipping it", async () => {
    seedWeeklyClientDueNow();
    createPlanStore(join(runsDir, "account-plans.json")).upsert(ORG, { tierId: "starter", status: "active" });
    for (let i = 0; i < 4; i++) seedRunManifest(`seeded-${i}`); // Starter limit is 4

    const result = await runDueClientSchedules(profiles());
    expect(result.failed).toHaveLength(0);
    expect(result.enqueued).toHaveLength(1);
    expect(result.enqueued[0].status).toBe("queued");
  });

  it("enqueues a due weekly client when its plan is under the limit", async () => {
    seedWeeklyClientDueNow();
    createPlanStore(join(runsDir, "account-plans.json")).upsert(ORG, { tierId: "starter", status: "active" });
    for (let i = 0; i < 3; i++) seedRunManifest(`seeded-${i}`);

    const result = await runDueClientSchedules(profiles());
    expect(result.failed).toHaveLength(0);
    expect(result.enqueued).toHaveLength(1);
    expect(result.enqueued[0].status).toBe("queued");
  });

  it("enqueues a due weekly client with no plan on file regardless of usage — billing hasn't been asked to gate", async () => {
    seedWeeklyClientDueNow();
    for (let i = 0; i < 5; i++) seedRunManifest(`seeded-${i}`);

    const result = await runDueClientSchedules(profiles());
    expect(result.failed).toHaveLength(0);
    expect(result.enqueued).toHaveLength(1);
  });
});
