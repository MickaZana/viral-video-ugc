import express from "express";
import { listReviewItems, getReviewItem, setReviewItemStatus } from "@vvugc/review-queue";

const app = express();
app.use(express.json());

app.get("/queue", (req, res) => {
  const status = typeof req.query.status === "string" ? (req.query.status as any) : undefined;
  res.json(listReviewItems(status));
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
  res.type("html").send(`<!doctype html>
<html>
<head><title>Viral Video UGC Review Queue</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  .item { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .pending { border-left: 4px solid #e0a800; }
  .approved { border-left: 4px solid #2e7d32; }
  .rejected { border-left: 4px solid #c62828; opacity: 0.6; }
  button { margin-right: 0.5rem; padding: 0.4rem 0.8rem; }
</style>
</head>
<body>
<h1>Viral Video UGC Review Queue</h1>
<div id="items">Loading...</div>
<script>
async function load() {
  const items = await (await fetch('/queue')).json();
  document.getElementById('items').innerHTML = items.map(i => \`
    <div class="item \${i.status}">
      <strong>\${i.niche}</strong> — \${i.platform} — score \${i.score}
      <p>\${i.script.hook}</p>
      <small>\${i.videoPath}</small><br/>
      <small>flags: \${i.flags.join(', ') || 'none'}</small><br/>
      <button onclick="act('\${i.id}','approve')" \${i.status !== 'pending' ? 'disabled' : ''}>Approve</button>
      <button onclick="act('\${i.id}','reject')" \${i.status !== 'pending' ? 'disabled' : ''}>Reject</button>
    </div>\`).join('');
}
async function act(id, action) {
  await fetch(\`/queue/\${id}/\${action}\`, { method: 'POST' });
  load();
}
load();
</script>
</body>
</html>`);
});

const port = Number(process.env.PORT ?? 4310);
app.listen(port, () => {
  console.log(`Viral Video UGC review dashboard listening on http://localhost:${port}`);
});
