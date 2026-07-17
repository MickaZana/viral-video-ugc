import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPublicAssetUrl, registerPublicAssetRoute } from "./public-assets.js";

let runsDir: string;
let server: Server;
let baseUrl: string;

async function startServer() {
  const app = express();
  registerPublicAssetRoute(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

describe("public video asset URLs", () => {
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "vvugc-public-assets-"));
    process.env.VVUGC_RUNS_DIR = runsDir;
    process.env.PUBLIC_BASE_URL = "https://dashboard.example.com";
  });

  afterEach(() => {
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.PUBLIC_BASE_URL;
    server?.close();
    if (existsSync(runsDir)) rmSync(runsDir, { recursive: true, force: true });
  });

  it("throws without PUBLIC_BASE_URL set — can't produce a URL Meta's servers could actually fetch", () => {
    delete process.env.PUBLIC_BASE_URL;
    const videoPath = join(runsDir, "final.mp4");
    writeFileSync(videoPath, "fake video bytes");
    expect(() => createPublicAssetUrl(videoPath)).toThrow(/PUBLIC_BASE_URL/);
  });

  it("refuses to sign a URL for a file outside VVUGC_RUNS_DIR", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "vvugc-outside-"));
    const outsidePath = join(outsideDir, "secret.mp4");
    writeFileSync(outsidePath, "not supposed to be servable");
    try {
      expect(() => createPublicAssetUrl(outsidePath)).toThrow(/outside VVUGC_RUNS_DIR/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("throws for a video file that doesn't exist", () => {
    expect(() => createPublicAssetUrl(join(runsDir, "does-not-exist.mp4"))).toThrow(/not found/);
  });

  it("a signed URL actually serves the real video bytes over real HTTP", async () => {
    await startServer();
    const videoPath = join(runsDir, "final.mp4");
    writeFileSync(videoPath, "these are the real video bytes");

    const { url } = createPublicAssetUrl(videoPath);
    const token = url.split("/public/assets/")[1];

    const res = await fetch(`${baseUrl}/public/assets/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await res.text()).toBe("these are the real video bytes");
  });

  it("rejects a tampered token with 404, not a distinguishable error", async () => {
    await startServer();
    const videoPath = join(runsDir, "final.mp4");
    writeFileSync(videoPath, "bytes");
    const { url } = createPublicAssetUrl(videoPath);
    const token = url.split("/public/assets/")[1];
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

    const res = await fetch(`${baseUrl}/public/assets/${tampered}`);
    expect(res.status).toBe(404);
  });

  it("rejects an expired token", async () => {
    await startServer();
    const videoPath = join(runsDir, "final.mp4");
    writeFileSync(videoPath, "bytes");

    const { url } = createPublicAssetUrl(videoPath, 10);
    const token = url.split("/public/assets/")[1];
    await new Promise((resolve) => setTimeout(resolve, 30));

    const res = await fetch(`${baseUrl}/public/assets/${token}`);
    expect(res.status).toBe(404);
  });
});
