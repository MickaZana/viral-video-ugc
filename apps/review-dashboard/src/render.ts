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
  .regen-panel { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 0.5rem; }
  .regen-panel textarea, .regen-panel input[type="text"] { width: 100%; box-sizing: border-box; }
  .regen-scenes { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .regen-scenes button { font-size: 0.78rem; padding: 0.3rem 0.6rem; }

  section.runs { margin-top: 3rem; }
  table.runs-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  table.runs-table th { text-align: left; color: var(--text-dim); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); }
  table.runs-table td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .runs-table-wrap { overflow-x: auto; }

  .empty-state { color: var(--text-dim); padding: 2rem 0; text-align: center; }
  .action-error { color: var(--bad); background: rgba(248, 113, 113, 0.1); border: 1px solid var(--bad); border-radius: var(--radius-sm); padding: 0.6rem 0.9rem; margin-bottom: 0.75rem; font-size: 0.85rem; }
  [hidden] { display: none !important; }

  .skip-link { position: absolute; left: -9999px; top: 0; z-index: 100; padding: 0.6rem 1rem; background: var(--accent); color: var(--bg); border-radius: 0 0 var(--radius) 0; }
  .skip-link:focus { left: 0; }

  @keyframes skeleton-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
  .skeleton {
    background: linear-gradient(90deg, var(--bg-card) 25%, var(--bg-raised) 37%, var(--bg-card) 63%);
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.4s ease-in-out infinite;
    border-radius: var(--radius-sm);
    color: transparent !important;
  }
  .skeleton-item { height: 4.5rem; }
  .skeleton-stat-num { display: inline-block; width: 2ch; }
  .skeleton-row td { padding: 0.6rem 0.75rem; }
  .skeleton-row .skeleton { height: 1rem; }
  @media (prefers-reduced-motion: reduce) {
    .skeleton { animation: none; }
  }

  @media (max-width: 720px) {
    body { padding: 1rem 1rem 3rem; }
    header.page-head { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
    .stats { width: 100%; }
    .stat { flex: 1 1 40%; }
    .toolbar { flex-direction: column; align-items: stretch; }
    .toolbar label { justify-content: space-between; }
    .bulk-actions { margin-left: 0; }
    .bulk-actions .btn { flex: 1; }
    .item { flex-wrap: wrap; }
    .item-actions { width: 100%; }
    .item-actions .btn { flex: 1; }
    table.runs-table { font-size: 0.78rem; }
  }
</style>
</head>
<body>

<a class="skip-link" href="#queue-list">Skip to queue</a>

<header class="page-head">
  <div>
    <h1 style="font-size: 1.5rem; margin-bottom: 0.15em;">Review Queue</h1>
    <p style="margin: 0;">Approve or reject generated videos before they go out.</p>
  </div>
  <div class="stats" id="stats" role="status" aria-live="polite">
    <div class="card stat"><div class="stat-num skeleton skeleton-stat-num" id="stat-pending">–</div><div class="stat-label">Pending</div></div>
    <div class="card stat"><div class="stat-num skeleton skeleton-stat-num" id="stat-approved">–</div><div class="stat-label">Approved</div></div>
    <div class="card stat"><div class="stat-num skeleton skeleton-stat-num" id="stat-rejected">–</div><div class="stat-label">Rejected</div></div>
    <div class="card stat"><div class="stat-num skeleton skeleton-stat-num" id="stat-cost">–</div><div class="stat-label">Est. spend</div></div>
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

<p class="action-error" id="action-error" role="alert" hidden></p>
<div class="queue-list" id="queue-list" aria-live="polite" aria-busy="true">
  <div class="card item skeleton skeleton-item" aria-hidden="true"></div>
  <div class="card item skeleton skeleton-item" aria-hidden="true"></div>
  <div class="card item skeleton skeleton-item" aria-hidden="true"></div>
</div>
<p class="empty-state" id="empty-state" hidden>No items match the current filters.</p>

<section class="runs">
  <h2 style="font-size: 1.1rem;">Run history</h2>
  <div class="runs-table-wrap">
    <table class="runs-table" id="runs-table">
      <thead>
        <tr><th scope="col">Run</th><th scope="col">Niche</th><th scope="col">Platforms</th><th scope="col">Candidates</th><th scope="col">Items</th><th scope="col">Failed</th><th scope="col">Est. cost</th><th scope="col">Started</th></tr>
      </thead>
      <tbody id="runs-tbody">
        <tr class="skeleton-row" aria-hidden="true"><td colspan="8"><div class="skeleton" style="height: 1.2rem;"></div></td></tr>
      </tbody>
    </table>
  </div>
</section>

<script>
const state = { items: [], selected: new Set(), regenOpen: new Set() };

function pillClass(status) { return 'pill pill-' + status; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// QA scores are 0-100 (see apps/orchestrator/src/agents/qa-agent.ts) but a bare
// number gives a reviewer nothing to judge it against without doing mental math
// on every item — a qualitative label next to it answers "is this good?" at a glance.
function scoreLabel(score) {
  if (score >= 80) return 'Strong';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Needs work';
  return 'Weak';
}

// The live QA agent's system prompt lets Claude invent its own short flag slugs
// (e.g. "weak_cta") rather than picking from a fixed enum, so this can't be a
// closed lookup table — the --dry-run heuristic path's fixed flags get a specific,
// more natural phrasing; anything else (including whatever Claude comes up with)
// still gets de-slugified into readable text instead of a raw snake_case token.
const FLAG_LABELS = {
  hook_too_long: 'Hook is too long',
  low_trending_phrase_density: 'Not enough trending phrases',
  duration_mismatch: "Duration doesn't match the target",
  no_captions: 'No captions burned in',
  few_hashtags: 'Too few hashtags'
};
function humanizeFlag(flag) {
  return FLAG_LABELS[flag] ?? flag.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

// originalityScore (see @vvugc/shared-originality) is a separate, algorithmic
// "trend-informed but original" compliance check, distinct from the Claude-scored
// virality \`score\` above — a reviewer needs both, not one folded into the other.
function originalityLabel(originalityScore) {
  if (originalityScore >= 70) return 'Original';
  if (originalityScore >= 50) return 'Some overlap';
  return 'Close match — review';
}

function setStat(id, text) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.classList.remove('skeleton', 'skeleton-stat-num');
}

async function loadStats() {
  const res = await fetch('/stats');
  if (!res.ok) throw new Error('Failed to load stats (' + res.status + ')');
  const stats = await res.json();
  setStat('stat-pending', stats.pending);
  setStat('stat-approved', stats.approved);
  setStat('stat-rejected', stats.rejected);
  setStat('stat-cost', '$' + stats.estimatedCostUsd.toFixed(2));
}

async function loadRuns() {
  const res = await fetch('/runs');
  if (!res.ok) throw new Error('Failed to load run history (' + res.status + ')');
  const runs = await res.json();
  document.getElementById('runs-tbody').innerHTML = runs.length
    ? runs.map((r) => {
        const failed = (r.candidatesFailed ?? 0) + (r.platformsFailed ?? 0);
        const failedLabel = failed === 0 ? '—' : \`\${r.candidatesFailed ?? 0} candidate\${(r.candidatesFailed ?? 0) === 1 ? '' : 's'}, \${r.platformsFailed ?? 0} platform\${(r.platformsFailed ?? 0) === 1 ? '' : 's'}\`;
        // Reasons used to only exist in server-side logs a dashboard-only user could
        // never reach — a native <details> keeps the table scannable by default while
        // still making "why" one click away instead of requiring the terminal/logs.
        const failedCell = failed === 0
          ? '—'
          : \`<details><summary style="cursor: pointer;">\${failedLabel}</summary>\${
              (r.failures ?? []).length
                ? '<ul style="margin: 0.4rem 0 0; padding-left: 1.1rem;">' +
                  r.failures.map((f) => \`<li>\${esc(f.candidateId)}\${f.platform ? ' · ' + esc(f.platform) : ''}: \${esc(f.reason)}</li>\`).join('') +
                  '</ul>'
                : '<p style="margin: 0.4rem 0 0; color: var(--text-dim);">No failure details recorded for this run (older run, or check server logs).</p>'
            }</details>\`;
        return \`<tr>
        <td>\${esc(r.runId)}</td>
        <td>\${esc(r.niche)}</td>
        <td>\${esc(r.platforms.join(', '))}</td>
        <td>\${r.candidatesFound}</td>
        <td>\${r.reviewItemsCreated}</td>
        <td\${failed > 0 ? ' style="color: var(--warn);"' : ''}>\${failedCell}</td>
        <td>\${r.estimatedCostUsd !== undefined ? '$' + r.estimatedCostUsd.toFixed(4) : '—'}</td>
        <td>\${r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'}</td>
      </tr>\`;
      }).join('')
    : '<tr><td colspan="8" class="empty-state">No runs yet.</td></tr>';
}

function populateFilterOptions() {
  const nicheSel = document.getElementById('filter-niche');
  const platformSel = document.getElementById('filter-platform');
  const niches = [...new Set(state.items.map((i) => i.niche))].sort();
  const platforms = [...new Set(state.items.map((i) => i.platform))].sort();
  // An active filter (e.g. niche=X) can legitimately narrow the current fetch
  // down to zero items — approving/rejecting the last pending item in a niche
  // is the common case. That must not silently drop the filter back to "All":
  // keep the currently-selected value in the option list even when it isn't
  // present in this fetch's items, instead of only ever offering values seen
  // in the (possibly now-empty) current result set.
  const keepValue = (sel, values) => {
    const current = sel.value;
    const options = current && !values.includes(current) ? [...values, current] : values;
    sel.innerHTML = '<option value="">All</option>' + options.map((v) => \`<option value="\${esc(v)}">\${esc(v)}</option>\`).join('');
    sel.value = current;
  };
  keepValue(nicheSel, niches);
  keepValue(platformSel, platforms);
}

function updateBulkButtons() {
  const has = state.selected.size > 0;
  document.getElementById('bulk-approve').disabled = !has;
  document.getElementById('bulk-reject').disabled = !has;
}

// Hidden by default (state.regenOpen tracks which item ids have this expanded) —
// most reviewers approve/reject without ever touching this, so it stays out of the
// way until "Edit / Regenerate" is clicked.
function renderRegenPanel(i) {
  const open = state.regenOpen.has(i.id);
  const segmentLabels = ['Hook', ...i.script.points.map((_, idx) => \`Point \${idx + 1}\`), 'CTA'];
  return \`
    <div class="regen-panel" data-regen-panel="\${i.id}" \${open ? '' : 'hidden'}>
      <label>Hook<input type="text" data-regen-field="hook" data-id="\${i.id}" value="\${esc(i.script.hook)}" /></label>
      <label>Points (one per line)<textarea rows="3" data-regen-field="points" data-id="\${i.id}">\${esc(i.script.points.join('\\n'))}</textarea></label>
      <label>CTA<input type="text" data-regen-field="cta" data-id="\${i.id}" value="\${esc(i.script.cta)}" /></label>
      <button class="btn btn-primary" data-action="regenerate-script" data-id="\${i.id}">Regenerate whole script</button>
      <div class="regen-scenes">
        \${segmentLabels.map((label, idx) => \`<button class="btn" data-action="regenerate-scene" data-id="\${i.id}" data-scene-index="\${idx}">Regenerate: \${esc(label)}</button>\`).join('')}
      </div>
    </div>\`;
}

function renderItems() {
  const list = document.getElementById('queue-list');
  const empty = document.getElementById('empty-state');
  list.removeAttribute('aria-busy');
  empty.hidden = state.items.length > 0;
  list.innerHTML = state.items.map((i) => \`
    <div class="card item \${i.status === 'rejected' ? 'rejected' : ''}">
      <input type="checkbox" data-id="\${i.id}" aria-label="Select item for \${esc(i.niche)}" \${state.selected.has(i.id) ? 'checked' : ''} />
      <div class="item-body">
        <div class="item-head">
          <span class="\${pillClass(i.status)}">\${esc(i.status)}</span>
          <strong>\${esc(i.niche)}</strong>
          <span style="color: var(--text-dim);">· \${esc(i.platform)}</span>
          <span class="item-score" title="Virality score out of 100">\${i.score}/100 · \${scoreLabel(i.score)}</span>
          \${typeof i.originalityScore === 'number' ? \`<span class="item-score" title="Originality score out of 100 — structural/wording similarity vs. the source">🔍 \${i.originalityScore}/100 · \${originalityLabel(i.originalityScore)}</span>\` : ''}
        </div>
        <p class="item-hook">\${esc(i.script.hook)}</p>
        <div class="item-path">\${esc(i.videoPath)}</div>
        \${i.flags.length ? \`<div class="item-flags">⚠ \${esc(i.flags.map(humanizeFlag).join(', '))}</div>\` : ''}
        <div class="item-actions">
          <button class="btn btn-primary" data-action="approve" data-id="\${i.id}" aria-label="Approve \${esc(i.niche)} · \${esc(i.platform)} item" \${i.status !== 'pending' ? 'disabled' : ''}>Approve</button>
          <button class="btn btn-danger" data-action="reject" data-id="\${i.id}" aria-label="Reject \${esc(i.niche)} · \${esc(i.platform)} item" \${i.status !== 'pending' ? 'disabled' : ''}>Reject</button>
          \${i.clips && i.clips.length ? \`<button class="btn" data-action="toggle-regen" data-id="\${i.id}" aria-expanded="false">Edit / Regenerate</button>\` : ''}
        </div>
        \${i.clips && i.clips.length ? renderRegenPanel(i) : ''}
      </div>
    </div>\`).join('');

  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.target.getAttribute('data-id');
      if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
      updateBulkButtons();
    });
  });
  list.querySelectorAll('button[data-action="approve"], button[data-action="reject"]').forEach((btn) => {
    btn.addEventListener('click', () => act(btn.getAttribute('data-id'), btn.getAttribute('data-action'), btn));
  });
  list.querySelectorAll('button[data-action="toggle-regen"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      if (state.regenOpen.has(id)) state.regenOpen.delete(id); else state.regenOpen.add(id);
      const panel = list.querySelector(\`[data-regen-panel="\${id}"]\`);
      if (panel) panel.hidden = !state.regenOpen.has(id);
      btn.setAttribute('aria-expanded', String(state.regenOpen.has(id)));
    });
  });
  list.querySelectorAll('button[data-action="regenerate-script"]').forEach((btn) => {
    btn.addEventListener('click', () => regenerateScript(btn.getAttribute('data-id'), btn));
  });
  list.querySelectorAll('button[data-action="regenerate-scene"]').forEach((btn) => {
    btn.addEventListener('click', () => regenerateScene(btn.getAttribute('data-id'), Number(btn.getAttribute('data-scene-index')), btn));
  });
}

function readRegenFields(id) {
  const hookEl = document.querySelector(\`input[data-regen-field="hook"][data-id="\${id}"]\`);
  const pointsEl = document.querySelector(\`textarea[data-regen-field="points"][data-id="\${id}"]\`);
  const ctaEl = document.querySelector(\`input[data-regen-field="cta"][data-id="\${id}"]\`);
  return {
    hook: hookEl.value,
    points: pointsEl.value.split('\\n').map((s) => s.trim()).filter(Boolean),
    cta: ctaEl.value
  };
}

async function regenerateScript(id, btn) {
  clearError();
  btn.disabled = true;
  btn.classList.add('btn-loading');
  try {
    const res = await fetch(\`/queue/\${id}/regenerate-script\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readRegenFields(id))
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Request failed (' + res.status + ')');
    }
    state.regenOpen.add(id); // keep the panel open across the reload so the reviewer sees the result
    await load();
  } catch (err) {
    showError('Could not regenerate the script — ' + err.message);
    btn.disabled = false;
    btn.classList.remove('btn-loading');
  }
}

async function regenerateScene(id, sceneIndex, btn) {
  clearError();
  btn.disabled = true;
  btn.classList.add('btn-loading');
  try {
    const res = await fetch(\`/queue/\${id}/regenerate-scene\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneIndex })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Request failed (' + res.status + ')');
    }
    state.regenOpen.add(id);
    await load();
  } catch (err) {
    showError('Could not regenerate that scene — ' + err.message);
    btn.disabled = false;
    btn.classList.remove('btn-loading');
  }
}

async function load() {
  const status = document.getElementById('filter-status').value;
  const niche = document.getElementById('filter-niche').value;
  const platform = document.getElementById('filter-platform').value;
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (niche) params.set('niche', niche);
  if (platform) params.set('platform', platform);

  const res = await fetch('/queue?' + params.toString());
  if (!res.ok) throw new Error('Failed to load queue (' + res.status + ')');
  state.items = await res.json();
  state.selected.clear();
  document.getElementById('select-all').checked = false;
  populateFilterOptions();
  renderItems();
  updateBulkButtons();
  await Promise.all([loadStats(), loadRuns()]);
}

function showError(message) {
  const el = document.getElementById('action-error');
  el.textContent = message;
  el.hidden = false;
}
function clearError() {
  const el = document.getElementById('action-error');
  el.hidden = true;
}

async function act(id, action, btn) {
  if (action === 'reject' && !confirm('Reject this item? This cannot be undone from here.')) return;
  clearError();
  if (btn) {
    btn.disabled = true;
    btn.classList.add('btn-loading');
  }
  try {
    const res = await fetch(\`/queue/\${id}/\${action}\`, { method: 'POST' });
    if (!res.ok) throw new Error('Request failed (' + res.status + ')');
    await load(); // re-renders the list, which replaces this button — no need to clear the loading class here
  } catch (err) {
    showError('Could not ' + action + ' this item — ' + err.message + '. Try again.');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
    }
  }
}

async function bulkAct(action) {
  const ids = [...state.selected];
  if (ids.length === 0) return;
  if (action === 'reject' && !confirm(\`Reject \${ids.length} selected item\${ids.length === 1 ? '' : 's'}? This cannot be undone from here.\`)) return;
  clearError();
  const btn = document.getElementById('bulk-' + action);
  btn.disabled = true;
  btn.classList.add('btn-loading');
  try {
    const res = await fetch(\`/queue/bulk/\${action}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    if (!res.ok) throw new Error('Request failed (' + res.status + ')');
    await load();
    btn.classList.remove('btn-loading'); // load() re-enables via updateBulkButtons(), but doesn't know about the loading class
  } catch (err) {
    showError('Could not ' + action + ' the selected items — ' + err.message + '. Try again.');
    btn.classList.remove('btn-loading');
    updateBulkButtons();
  }
}

function clearSkeletons() {
  // Only run on a failed first load — a successful load() already replaces
  // this markup via renderItems()/loadStats()/loadRuns(). Left shimmering
  // forever alongside an error banner would look like it's still loading.
  const list = document.getElementById('queue-list');
  list.removeAttribute('aria-busy');
  list.querySelectorAll('.skeleton-item').forEach((el) => el.remove());
  ['stat-pending', 'stat-approved', 'stat-rejected', 'stat-cost'].forEach((id) => setStat(id, '–'));
  document.querySelectorAll('#runs-tbody .skeleton-row').forEach((el) => el.remove());
}

async function safeLoad() {
  try {
    clearError();
    await load();
  } catch (err) {
    showError('Could not load the queue — ' + err.message + '. Try refreshing the page.');
    clearSkeletons();
  }
}

document.getElementById('filter-status').addEventListener('change', safeLoad);
document.getElementById('filter-niche').addEventListener('change', safeLoad);
document.getElementById('filter-platform').addEventListener('change', safeLoad);
document.getElementById('select-all').addEventListener('change', (e) => {
  if (e.target.checked) state.items.forEach((i) => state.selected.add(i.id));
  else state.selected.clear();
  renderItems();
  updateBulkButtons();
});
document.getElementById('bulk-approve').addEventListener('click', () => bulkAct('approve'));
document.getElementById('bulk-reject').addEventListener('click', () => bulkAct('reject'));

safeLoad();
</script>
</body>
</html>`;
}
