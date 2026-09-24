import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalAssetStore, createTenantAssetKey, type AssetLocator } from "./assets.js";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
async function store() { root = await mkdtemp(join(tmpdir(), "vvugc-assets-")); return createLocalAssetStore(root); }

describe("AssetStore", () => {
  it("stores and retrieves a stream using only a tenant-scoped opaque key", async () => {
    const assets = await store();
    const locator: AssetLocator = { tenantId: "tenant_a", key: createTenantAssetKey("tenant_a", "videos/a.mp4") };
    const metadata = await assets.put(locator, { content: Readable.from([Buffer.from("video")]), metadata: { contentType: "video/mp4", contentLength: 5 } });
    expect(metadata.contentType).toBe("video/mp4");
    const opened = await assets.open(locator);
    expect(opened?.metadata.contentLength).toBe(5);
    const chunks: Buffer[] = [];
    for await (const chunk of opened!.content) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("video");
  });
  it("rejects traversal and a key borrowed from another tenant", async () => {
    expect(() => createTenantAssetKey("tenant_a", "../secrets.txt")).toThrow(/unsafe/i);
    const assets = await store();
    const foreign: AssetLocator = { tenantId: "tenant_a", key: createTenantAssetKey("tenant_b", "x.txt") };
    await expect(assets.metadata(foreign)).rejects.toThrow(/tenant/i);
  });
  it("fails a write whose declared length differs from the stream", async () => {
    const assets = await store();
    const locator: AssetLocator = { tenantId: "tenant_a", key: createTenantAssetKey("tenant_a", "x.txt") };
    await expect(assets.put(locator, { content: new Uint8Array([1, 2]), metadata: { contentType: "text/plain", contentLength: 1 } })).rejects.toThrow(/length/i);
    expect(await assets.open(locator)).toBeUndefined();
  });
});
