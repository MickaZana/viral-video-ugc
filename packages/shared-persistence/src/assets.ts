import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

declare const assetKeyBrand: unique symbol;
export type AssetKey = string & { readonly [assetKeyBrand]: "AssetKey" };
export interface AssetLocator { readonly tenantId: string; readonly key: AssetKey; }
export interface AssetMetadata { readonly contentType: string; readonly contentLength: number; readonly checksum?: string; readonly createdAt: string; }
export interface AssetWrite { readonly content: Uint8Array | Readable; readonly metadata: Omit<AssetMetadata, "createdAt">; }
export interface AssetRead { readonly metadata: AssetMetadata; readonly content: Readable; }

/** Provider-neutral storage contract: all locations are opaque tenant-scoped keys. */
export interface AssetStore {
  put(locator: AssetLocator, write: AssetWrite): Promise<AssetMetadata>;
  open(locator: AssetLocator): Promise<AssetRead | undefined>;
  metadata(locator: AssetLocator): Promise<AssetMetadata | undefined>;
  delete(locator: AssetLocator): Promise<boolean>;
}

function assertTenantId(tenantId: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(tenantId)) throw new Error("Invalid tenant id for asset key.");
}
function assertObjectName(objectName: string): void {
  if (!objectName || objectName.includes("\\") || objectName.startsWith("/") || objectName.includes("\0")) throw new Error("Asset object name must be a relative POSIX key.");
  for (const segment of objectName.split("/")) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment === "." || segment === "..") throw new Error("Asset object name contains an unsafe path segment.");
  }
}

/** Builds the only supported tenant-scoped opaque object-key form. */
export function createTenantAssetKey(tenantId: string, objectName: string): AssetKey {
  assertTenantId(tenantId);
  assertObjectName(objectName);
  return `tenants/${tenantId}/${objectName}` as AssetKey;
}
export function assertTenantAssetLocator(locator: AssetLocator): void {
  assertTenantId(locator.tenantId);
  const prefix = `tenants/${locator.tenantId}/`;
  if (!locator.key.startsWith(prefix)) throw new Error("Asset key is not scoped to its tenant.");
  assertObjectName(locator.key.slice(prefix.length));
}
function asReadable(content: Uint8Array | Readable): Readable { return content instanceof Readable ? content : Readable.from([content]); }
function validateMetadata(metadata: Omit<AssetMetadata, "createdAt">): void {
  if (!Number.isSafeInteger(metadata.contentLength) || metadata.contentLength < 0) throw new Error("Asset contentLength must be a non-negative integer.");
  if (!metadata.contentType || /[\r\n]/.test(metadata.contentType)) throw new Error("Asset contentType is invalid.");
}

/** Local-only implementation for development and isolated tests. It does not expose host paths. */
export function createLocalAssetStore(rootDirectory: string): AssetStore {
  const root = resolve(rootDirectory);
  function paths(locator: AssetLocator): { data: string; metadata: string } {
    assertTenantAssetLocator(locator);
    const data = resolve(root, ...locator.key.split("/"));
    if (relative(root, data).startsWith("..")) throw new Error("Asset key escapes local storage root.");
    return { data, metadata: `${data}.metadata.json` };
  }
  return {
    async put(locator, write) {
      validateMetadata(write.metadata);
      const { data, metadata } = paths(locator);
      await mkdir(dirname(data), { recursive: true });
      const temporary = join(dirname(data), `.${basename(data)}.${randomUUID()}.tmp`);
      let bytes = 0;
      const counter = new Transform({ transform(chunk: Uint8Array, _encoding, callback) { bytes += chunk.byteLength; callback(null, chunk); } });
      try {
        await pipeline(asReadable(write.content), counter, createWriteStream(temporary, { flags: "wx" }));
        if (bytes !== write.metadata.contentLength) throw new Error("Asset content length does not match metadata.");
        const assetMetadata: AssetMetadata = { ...write.metadata, createdAt: new Date().toISOString() };
        await writeFile(`${temporary}.metadata.json`, JSON.stringify(assetMetadata), { encoding: "utf8", flag: "wx" });
        await rename(temporary, data);
        await rename(`${temporary}.metadata.json`, metadata);
        return assetMetadata;
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rm(`${temporary}.metadata.json`, { force: true }).catch(() => undefined);
      }
    },
    async open(locator) {
      const { data, metadata } = paths(locator);
      try {
        const [rawMetadata] = await Promise.all([readFile(metadata, "utf8"), stat(data)]);
        return { metadata: JSON.parse(rawMetadata) as AssetMetadata, content: createReadStream(data) };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async metadata(locator) {
      const opened = await this.open(locator);
      if (opened) opened.content.destroy();
      return opened?.metadata;
    },
    async delete(locator) {
      const { data, metadata } = paths(locator);
      const existed = await stat(data).then(() => true).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
      await Promise.all([rm(data, { force: true }), rm(metadata, { force: true })]);
      return existed;
    }
  };
}
