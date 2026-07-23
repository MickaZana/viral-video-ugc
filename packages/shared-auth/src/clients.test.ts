import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgencyClientStore, type AgencyClientInput } from "./clients.js";

const input: AgencyClientInput = {
  name: "Acme",
  niche: "fitness",
  brandVoice: "direct",
  locale: "en",
  platforms: ["youtube_shorts"],
  targetDurationSec: 30,
  videoVendor: "replicate",
  cadence: "manual",
  active: true
};

describe("createAgencyClientStore", () => {
  let dir = "";
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function store() {
    dir = mkdtempSync(join(tmpdir(), "agency-clients-"));
    return createAgencyClientStore(join(dir, "clients.json"));
  }

  it("creates, reads, updates, lists, and archives within the owning org", () => {
    const clients = store();
    const created = clients.create("org-a", input);
    clients.create("org-b", { ...input, name: "Other" });
    expect(clients.getForOrg("org-a", created.id)?.name).toBe("Acme");
    expect(clients.getForOrg("org-b", created.id)).toBeUndefined();
    expect(clients.listByOrg("org-a")).toHaveLength(1);
    expect(clients.update("org-a", created.id, { ...input, name: "Renamed" })?.name).toBe("Renamed");
    expect(clients.archive("org-a", created.id)).toBe(true);
    expect(clients.getForOrg("org-a", created.id)?.active).toBe(false);
  });

  it("atomically claims only active weekly clients that are due", () => {
    const clients = store();
    const now = new Date("2026-07-23T00:00:00.000Z");
    const weekly = clients.create("org-a", { ...input, cadence: "weekly" });
    const manual = clients.create("org-a", input);
    clients.update("org-a", weekly.id, { ...input, cadence: "weekly" });
    // The store schedules weekly work seven days out; claim at a later boundary.
    const due = clients.claimDue(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
    expect(due.map((entry) => entry.id)).toContain(weekly.id);
    expect(due.map((entry) => entry.id)).not.toContain(manual.id);
    expect(clients.claimDue(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000))).toHaveLength(0);
  });

  it("does not lose concurrent creates guarded by the lock", async () => {
    const clients = store();
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      Promise.resolve().then(() => clients.create("org-a", { ...input, name: `Client ${index}` }))
    ));
    expect(clients.listByOrg("org-a")).toHaveLength(20);
  });
});
