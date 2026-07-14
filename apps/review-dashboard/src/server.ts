import express, { type Express } from "express";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  listReviewItems,
  getReviewItem,
  setReviewItemStatus,
  setReviewItemsStatus
} from "@vvugc/review-queue";
import { listRuns } from "./runs.js";
import { renderDashboardPage } from "./render.js";

const require = createRequire(import.meta.url);

export const app: Express = express();
app.use(express.json());

app.get("/tokens.css", (_req, res) => {
  res.type("css").sendFile(require.resolve("@vvugc/design-tokens"));
});

app.get("/queue", (req, res) => {
  const status = typeof req.query.status === "string" && req.query.status ? (req.query.status as any) : undefined;
  const niche = typeof req.query.niche === "string" && req.query.niche ? req.query.niche : undefined;
  const platform = typeof req.query.platform === "string" && req.query.platform ? (req.query.platform as any) : undefined;
  res.json(listReviewItems({ status, niche, platform }));
});

app.get("/stats", (_req, res) => {
  const items = listReviewItems();
  const pending = items.filter((i) => i.status === "pending").length;
  const approved = items.filter((i) => i.status === "approved").length;
  const rejected = items.filter((i) => i.status === "rejected").length;
  const estimatedCostUsd = listRuns().reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
  res.json({ pending, approved, rejected, estimatedCostUsd });
});

app.get("/runs", (_req, res) => {
  res.json(listRuns());
});

// Bulk routes must be registered before the "/queue/:id/..." routes below — Express
// matches route patterns in registration order, and ":id" would otherwise greedily
// match the literal segment "bulk" (i.e. POST /queue/bulk/approve would 404 by hitting
// "/queue/:id/approve" with id="bulk" first). Found by an actual request during manual
// testing, not by the test suite alone — the route-order mistake produced a 404, not a
// type error, so nothing caught it until something actually hit the endpoint.
app.post("/queue/bulk/approve", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
  res.json({ updated: setReviewItemsStatus(ids, "approved") });
});

app.post("/queue/bulk/reject", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
  res.json({ updated: setReviewItemsStatus(ids, "rejected") });
});

app.get("/queue/:id", (req, res) => {
  const item = getReviewItem(req.params.id);
  if (!item) return res.status(404).json({ error: "not found" });
  res.json(item);
});

app.post("/queue/:id/approve", (req, res) => {
  const item = getReviewItem(req.params.id);
  if (!item) return res.status(404).json({ error: "not found" });
  setReviewItemStatus(req.params.id, "approved");
  res.json({ ...item, status: "approved" });
});

app.post("/queue/:id/reject", (req, res) => {
  const item = getReviewItem(req.params.id);
  if (!item) return res.status(404).json({ error: "not found" });
  setReviewItemStatus(req.params.id, "rejected");
  res.json({ ...item, status: "rejected" });
});

app.get("/", (_req, res) => {
  res.type("html").send(renderDashboardPage());
});

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 4310);
  app.listen(port, () => {
    console.log(`Viral Video UGC review dashboard listening on http://localhost:${port}`);
  });
}
