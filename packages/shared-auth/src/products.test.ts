import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProductProfileStore } from "./products.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("product profile store", () => {
  it("creates, lists, updates, images, and isolates by org", () => {
    const dir = mkdtempSync(join(tmpdir(), "vvugc-products-"));
    dirs.push(dir);
    const store = createProductProfileStore(join(dir, "products.json"));
    const product = store.create("org-a", {
      name: "Example Product",
      description: "A useful product",
      shortDescription: "Useful",
      productCategory: "SaaS",
      targetCustomer: "Operators",
      customerPain: "Too much manual work",
      primaryBenefits: ["Saves time"],
      features: ["Automation"],
      claims: ["Saves time"],
      forbiddenClaims: ["Guaranteed results"],
      differentiators: ["Simple"],
      callToAction: "Try it",
      extractedImageUrls: []
    });
    expect(store.listByOrg("org-a")).toHaveLength(1);
    expect(store.listByOrg("org-b")).toHaveLength(0);
    const updated = store.update("org-a", product.id, { ...product, name: "Updated Product" });
    expect(updated?.name).toBe("Updated Product");
    const withImage = store.addImage("org-a", product.id, {
      id: "image-1", fileName: "hero.png", mimeType: "image/png", filePath: "product-assets/org-a/p/hero.png", createdAt: new Date().toISOString()
    });
    expect(withImage?.productImages).toHaveLength(1);
    expect(store.removeImage("org-a", product.id, "image-1")?.id).toBe("image-1");
    expect(store.archive("org-a", product.id)).toBe(true);
    expect(store.getForOrg("org-a", product.id)).toBeUndefined();
  });
});
