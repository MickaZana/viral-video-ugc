/**
 * The dashboard's HTML shell. Data (queue items, run history, stats) is fetched
 * client-side against this app's own /queue, /runs, /stats endpoints — the shell
 * itself is static, which keeps it trivially testable (no request/response fixtures
 * needed to assert on markup) unlike the marketing site's per-request render.
 */
export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Viral Video UGC — Review Queue</title>
<link rel="stylesheet" href="/tokens.css" />
<style>
  body { max-width: 1100px; margin: 0 auto; padding: 1.5rem 1.5rem 4rem; }
  header.page-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }
  .stats { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  .stat { padding: 0.5rem 0.9rem; }
  .stat-num { font-size: 1.25rem; font-weight: 800; font-variant-numeric: tabular-nums; }
  .stat-label { font-size: 0.72rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }

  .toolbar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .toolbar label { font-size: 0.8rem; color: var(--text-dim); display: flex; align-items: center; gap: 0.4rem; }
  .bulk-actions { display: flex; gap: 0.5rem; margin-left: auto; }

  .queue-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .item { display: flex; gap: 0.9rem; align-items: flex-start; }
  .item input[type="checkbox"] { margin-top: 0.3rem; width: 16px; height: 16px; }
  .item-body { flex: 1; min-width: 0; }
  .item-head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
  .item-score { font-weight: 800; font-variant-numeric: tabular-nums; }
  .item-hook { margin: 0 0 0.4rem; color: var(--text); }
  .item-path { font-size: 0.78rem; color: var(--text-dim); word-break: break-all; }
  .item-flags { font-size: 0.78rem; color: var(--warn); margin-top: 0.3rem; }
  .item-actions { display: flex; gap: 0.5rem; margin-top: 0.6rem; }
  .item.rejected { opacity: 0.55; }

  section.runs { margin-top: 3rem; }
  table.runs-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  table.runs-table th { text-align: left; color: var(--text-dim); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); }
  table.runs-table td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .runs-table-wrap { overflow-x: auto; }

  .empty-state { color: var(--text-dim); padding: 2rem 0; text-align: center; }
  [hidden] { display: none !important; }
</style>
</head>
<body>

<header class="page-head">
  <div>
    <h1 style="font-size: 1.5rem; margin-bottom: 0.15em;">Review Queue</h1>
    <p style="margin: 0;">Approve or reject generated videos before they go out.</p>
  </div>
  <div class="stats" id="stats" role="status" aria-live="polite">
    <div class="card stat"><div class="stat-num" id="stat-pending">–</div><div class="stat-label">Pending</div></div>
    <div class="card stat"><div class="stat-num" id="stat-approved">–</div><div class="stat-label">Approved</div></div>
    <div class="card stat"><div class="stat-num" id="stat-rejected">–</div><div class="stat-label">Rejected</div></div>
    <div class="card stat"><div class="stat-num" id="stat-cost">–</div><div class="stat-label">Est. spend</div></div>
  </div>
</header>

<div class="toolbar">
  <label for="filter-status">Status
    <select id="filter-status" class="input">
      <option value="">All</option>
      <option value="pending" selected>Pending</option>
      <option value="approved">Approved</option>
      <option value="rejected">Rejected</option>
    </select>
  </label>
  <label for="filter-niche">Niche
    <select id="filter-niche" class="input"><option value="">All</option></select>
  </label>
  <label for="filter-platform">Platform
    <select id="filter-platform" class="input"><option value="">All</option></select>
  </label>
  <label>
    <input type="checkbox" id="select-all" aria-label="Select all visible items" />
    Select all
  </label>
  <div class="bulk-actions">
    <button class="btn btn-primary" id="bulk-approve" disabled>Approve selected</button>
    <button class="btn btn-danger" id="bulk-reject" disabled>Reject selected</button>
  </div>
</div>

<div class="queue-list" id="queue-list" aria-live="polite"></div>
<p class="empty-state" id="empty-state" hidden>No items match the current filters.</p>

<section class="runs">
  <h2 style="font-size: 1.1rem;">Run history</h2>
  <div class="runs-table-wrap">
    <table class="runs-table" id="runs-table">
      <thead>
        <tr><th>Run</th><th>Niche</th><th>Platforms</th><th>Candidates</th><th>Items</th><th>Est. cost</th><th>Started</th></tr>
      </thead>
      <tbody id="runs-tbody"></tbody>
    </table>
  </div>
</section>

<script>
const state = { items: [], selected: new Set() };

function pillClass(status) { return 'pill pill-' + status; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function loadStats() {
  const stats = await (await fetch('/stats')).json();
  document.getElementById('stat-pending').textContent = stats.pending;
  document.getElementById('stat-approved').textContent = stats.approved;
  document.getElementById('stat-rejected').textContent = stats.rejected;
  document.getElementById('stat-cost').textContent = '$' + stats.estimatedCostUsd.toFixed(2);
}

async function loadRuns() {
  const runs = await (await fetch('/runs')).json();
  document.getElementById('runs-tbody').innerHTML = runs.length
    ? runs.map((r) => \`<tr>
        <td>\${esc(r.runId)}</td>
        <td>\${esc(r.niche)}</td>
        <td>\${esc(r.platforms.join(', '))}</td>
        <td>\${r.candidatesFound}</td>
        <td>\${r.reviewItemsCreated}</td>
        <td>\${r.estimatedCostUsd !== undefined ? '$' + r.estimatedCostUsd.toFixed(4) : '—'}</td>
        <td>\${r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'}</td>
      </tr>\`).join('')
    : '<tr><td colspan="7" class="empty-state">No runs yet.</td></tr>';
}

function populateFilterOptions() {
  const nicheSel = document.getElementById('filter-niche');
  const platformSel = document.getElementById('filter-platform');
  const niches = [...new Set(state.items.map((i) => i.niche))].sort();
  const platforms = [...new Set(state.items.map((i) => i.platform))].sort();
  const keepValue = (sel, values) => {
    const current = sel.value;
    sel.innerHTML = '<option value="">All</option>' + values.map((v) => \`<option value="\${esc(v)}">\${esc(v)}</option>\`).join('');
    if (values.includes(current)) sel.value = current;
  };
  keepValue(nicheSel, niches);
  keepValue(platformSel, platforms);
}

function updateBulkButtons() {
  const has = state.selected.size > 0;
  document.getElementById('bulk-approve').disabled = !has;
  document.getElementById('bulk-reject').disabled = !has;
}

function renderItems() {
  const list = document.getElementById('queue-list');
  const empty = document.getElementById('empty-state');
  empty.hidden = state.items.length > 0;
  list.innerHTML = state.items.map((i) => \`
    <div class="card item \${i.status === 'rejected' ? 'rejected' : ''}">
      <input type="checkbox" data-id="\${i.id}" aria-label="Select item for \${esc(i.niche)}" \${state.selected.has(i.id) ? 'checked' : ''} />
      <div class="item-body">
        <div class="item-head">
          <span class="\${pillClass(i.status)}">\${esc(i.status)}</span>
          <strong>\${esc(i.niche)}</strong>
          <span style="color: var(--text-dim);">· \${esc(i.platform)}</span>
          <span class="item-score">\${i.score}</span>
        </div>
        <p class="item-hook">\${esc(i.script.hook)}</p>
        <div class="item-path">\${esc(i.videoPath)}</div>
        \${i.flags.length ? \`<div class="item-flags">flags: \${esc(i.flags.join(', '))}</div>\` : ''}
        <div class="item-actions">
          <button class="btn btn-primary" data-action="approve" data-id="\${i.id}" \${i.status !== 'pending' ? 'disabled' : ''}>Approve</button>
          <button class="btn btn-danger" data-action="reject" data-id="\${i.id}" \${i.status !== 'pending' ? 'disabled' : ''}>Reject</button>
        </div>
      </div>
    </div>\`).join('');

  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.target.getAttribute('data-id');
      if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
      updateBulkButtons();
    });
  });
  list.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => act(btn.getAttribute('data-id'), btn.getAttribute('data-action')));
  });
}

async function load() {
  const status = document.getElementById('filter-status').value;
  const niche = document.getElementById('filter-niche').value;
  const platform = document.getElementById('filter-platform').value;
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (niche) params.set('niche', niche);
  if (platform) params.set('platform', platform);

  state.items = await (await fetch('/queue?' + params.toString())).json();
  state.selected.clear();
  document.getElementById('select-all').checked = false;
  populateFilterOptions();
  renderItems();
  updateBulkButtons();
  await Promise.all([loadStats(), loadRuns()]);
}

async function act(id, action) {
  await fetch(\`/queue/\${id}/\${action}\`, { method: 'POST' });
  load();
}

async function bulkAct(action) {
  const ids = [...state.selected];
  if (ids.length === 0) return;
  await fetch(\`/queue/bulk/\${action}\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  });
  load();
}

document.getElementById('filter-status').addEventListener('change', load);
document.getElementById('filter-niche').addEventListener('change', load);
document.getElementById('filter-platform').addEventListener('change', load);
document.getElementById('select-all').addEventListener('change', (e) => {
  if (e.target.checked) state.items.forEach((i) => state.selected.add(i.id));
  else state.selected.clear();
  renderItems();
  updateBulkButtons();
});
document.getElementById('bulk-approve').addEventListener('click', () => bulkAct('approve'));
document.getElementById('bulk-reject').addEventListener('click', () => bulkAct('reject'));

load();
</script>
</body>
</html>`;
}
