import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ProductProfileSchema, type ProductImage, type ProductProfile } from "@vvugc/shared-schema";

export type ProductProfileInput = Omit<ProductProfile, "id" | "orgId" | "createdAt" | "updatedAt" | "productImages" | "extractionStatus"> & {
  productImages?: ProductImage[];
  extractionStatus?: ProductProfile["extractionStatus"];
};

export interface ProductProfileStore {
  listByOrg(orgId: string, clientId?: string): ProductProfile[];
  getForOrg(orgId: string, id: string): ProductProfile | undefined;
  create(orgId: string, input: ProductProfileInput): ProductProfile;
  update(orgId: string, id: string, input: ProductProfileInput): ProductProfile | undefined;
  archive(orgId: string, id: string): boolean;
  addImage(orgId: string, id: string, image: ProductImage): ProductProfile | undefined;
  removeImage(orgId: string, id: string, imageId: string): ProductImage | undefined;
  deleteOrg(orgId: string): number;
}

function acquireLock(dbPath: string, timeoutMs = 5000): void {
  const lockPath = `${dbPath}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for products lock at ${dbPath}`);
      const until = Date.now() + 20;
      while (Date.now() < until) { /* bounded lock wait */ }
    }
  }
}

function readAll(dbPath: string): ProductProfile[] {
  if (!existsSync(dbPath)) return [];
  const parsed: unknown = JSON.parse(readFileSync(dbPath, "utf8"));
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => {
    const result = ProductProfileSchema.safeParse(value);
    return result.success ? [result.data] : [];
  });
}

function writeAll(dbPath: string, products: ProductProfile[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  { const _atomicTmp = `${dbPath}.${randomUUID()}.tmp`; writeFileSync(_atomicTmp, JSON.stringify(products, null, 2)); renameSync(_atomicTmp, dbPath); };
}

export function createProductProfileStore(dbPath: string): ProductProfileStore {
  function mutate<T>(fn: (products: ProductProfile[]) => T): T {
    mkdirSync(dirname(dbPath), { recursive: true });
    acquireLock(dbPath);
    try {
      const products = readAll(dbPath);
      const result = fn(products);
      writeAll(dbPath, products);
      return result;
    } finally {
      rmSync(`${dbPath}.lock`, { force: true });
    }
  }

  return {
    listByOrg(orgId, clientId) {
      return readAll(dbPath)
        .filter((product) => product.orgId === orgId && (!clientId || product.clientId === clientId))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    getForOrg(orgId, id) {
      return readAll(dbPath).find((product) => product.orgId === orgId && product.id === id);
    },
    create(orgId, input) {
      return mutate((products) => {
        const now = new Date().toISOString();
        const product = ProductProfileSchema.parse({
          ...input,
          id: randomUUID(),
          orgId,
          productImages: input.productImages ?? [],
          extractionStatus: input.extractionStatus ?? "manual",
          createdAt: now,
          updatedAt: now
        });
        products.push(product);
        return product;
      });
    },
    update(orgId, id, input) {
      return mutate((products) => {
        const index = products.findIndex((product) => product.orgId === orgId && product.id === id);
        if (index === -1) return undefined;
        const current = products[index];
        const updated = ProductProfileSchema.parse({
          ...current,
          ...input,
          id,
          orgId,
          productImages: input.productImages ?? current.productImages,
          updatedAt: new Date().toISOString()
        });
        products[index] = updated;
        return updated;
      });
    },
    archive(orgId, id) {
      return mutate((products) => {
        const index = products.findIndex((product) => product.orgId === orgId && product.id === id);
        if (index === -1) return false;
        products.splice(index, 1);
        return true;
      });
    },
    addImage(orgId, id, image) {
      return mutate((products) => {
        const product = products.find((entry) => entry.orgId === orgId && entry.id === id);
        if (!product || product.productImages.length >= 12) return undefined;
        product.productImages.push(image);
        product.updatedAt = new Date().toISOString();
        return ProductProfileSchema.parse(product);
      });
    },
    removeImage(orgId, id, imageId) {
      return mutate((products) => {
        const product = products.find((entry) => entry.orgId === orgId && entry.id === id);
        if (!product) return undefined;
        const index = product.productImages.findIndex((image) => image.id === imageId);
        if (index === -1) return undefined;
        const [removed] = product.productImages.splice(index, 1);
        product.updatedAt = new Date().toISOString();
        return removed;
      });
    },
    deleteOrg(orgId) {
      return mutate((products) => {
        const before = products.length;
        for (let i = products.length - 1; i >= 0; i--) {
          if (products[i].orgId === orgId) products.splice(i, 1);
        }
        return before - products.length;
      });
    }
  };
}
