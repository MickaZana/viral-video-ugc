/**
 * The account-facing, self-service surface — separate from renderDashboardPage()'s
 * operator queue (Basic-Auth-protected). This page is public (session-cookie
 * auth handled client-side against /accounts/* — see accounts.ts) and is where a
 * new customer signs up, configures their niche/brand-voice/platforms, and
 * triggers their first run without touching the CLI.
 */
export function renderAccountPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Viral Video UGC — Your Account</title>
<script>
  // Applied before first paint so the saved theme doesn't flash the default
  // (dark) theme for a frame — must run ahead of tokens.css taking effect.
  (function () {
    var saved = localStorage.getItem('vvugc-theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  })();
</script>
<link rel="stylesheet" href="/tokens.css" />
<style>
  .theme-toggle { padding: 0.4rem 0.7rem; font-size: 0.8rem; }
  body { max-width: 720px; margin: 0 auto; padding: 1.5rem 1.5rem 4rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25em; }
  .card { padding: 1.25rem; margin-bottom: 1.25rem; }
  .field { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.9rem; }
  .field label { font-size: 0.82rem; color: var(--text-dim); }
  .field input, .field select, .field textarea { width: 100%; box-sizing: border-box; }
  .checkbox-row { display: flex; gap: 1rem; flex-wrap: wrap; }
  .checkbox-row label { display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; color: var(--text); }
  .stats { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .stat { padding: 0.5rem 0.9rem; }
  .stat-num { font-size: 1.15rem; font-weight: 800; font-variant-numeric: tabular-nums; }
  .stat-label { font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
  .msg { padding: 0.6rem 0.9rem; border-radius: var(--radius-sm); font-size: 0.85rem; margin-bottom: 0.9rem; }
  .msg-error { color: var(--bad); background: rgba(248, 113, 113, 0.1); border: 1px solid var(--bad); }
  .msg-ok { color: var(--accent); background: rgba(52, 211, 153, 0.1); border: 1px solid var(--accent); }
  [hidden] { display: none !important; }
  .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  .chart-bars { display: flex; align-items: flex-end; gap: 3px; height: 60px; margin-top: 0.5rem; }
  .chart-bar { flex: 1; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 2px; }
</style>
</head>
<body>

<div id="authView">
  <h1>Sign in</h1>
  <div class="card" id="authCard">
    <div class="tabs">
      <button class="btn" id="tabLogin" type="button">Log in</button>
      <button class="btn" id="tabSignup" type="button">Sign up</button>
    </div>
    <p class="msg msg-error" id="authError" hidden></p>
    <form id="authForm">
      <div class="field" id="authEmailField">
        <label for="authEmail">Email</label>
        <input type="email" id="authEmail" class="input" required />
      </div>
      <div class="field">
        <label for="authPassword">Password</label>
        <input type="password" id="authPassword" class="input" required minlength="8" />
      </div>
      <div class="field" id="orgNameField">
        <label for="authOrgName">Agency / brand name (optional)</label>
        <input type="text" id="authOrgName" class="input" />
      </div>
      <button type="submit" class="btn btn-primary" id="authSubmit">Log in</button>
    </form>
  </div>
</div>

<div id="appView" hidden>
  <div class="row" style="justify-content: space-between;">
    <h1>Your account</h1>
    <div class="row">
      <button class="btn theme-toggle" id="themeToggleBtn" type="button" aria-pressed="false">Light mode</button>
      <button class="btn" id="logoutBtn" type="button">Log out</button>
    </div>
  </div>

  <div class="card">
    <h2 style="font-size: 1.05rem;">Usage</h2>
    <div class="stats" id="usageStats">
      <div class="card stat"><div class="stat-num" id="statRuns">–</div><div class="stat-label">Runs</div></div>
      <div class="card stat"><div class="stat-num" id="statItems">–</div><div class="stat-label">Videos produced</div></div>
      <div class="card stat"><div class="stat-num" id="statSpend">–</div><div class="stat-label">Est. spend</div></div>
    </div>
    <div class="chart-bars" id="usageChart" aria-hidden="true"></div>
  </div>

  <div class="card">
    <h2 style="font-size: 1.05rem;">Team</h2>
    <p class="msg msg-error" id="teamError" hidden></p>
    <ul id="memberList" style="margin: 0 0 0.75rem; padding-left: 1.1rem; font-size: 0.85rem;"></ul>
    <form id="inviteForm" class="row" style="display: none;" >
      <label for="inviteEmail" class="visually-hidden">Teammate's email</label>
      <input type="email" id="inviteEmail" class="input" placeholder="teammate@agency.com" required style="flex: 1;" />
      <button type="submit" class="btn btn-primary">Invite</button>
    </form>
    <p id="inviteResult" style="font-size: 0.8rem; color: var(--text-dim); margin-top: 0.5rem;"></p>
  </div>

  <div class="card">
    <h2 style="font-size: 1.05rem;">Billing</h2>
    <p class="msg msg-error" id="billingError" hidden></p>
    <p id="currentPlanLabel" style="font-size: 0.85rem; color: var(--text-dim); margin-bottom: 0.75rem;">–</p>
    <div class="row" id="tierButtons"></div>
  </div>

  <div class="card">
    <h2 style="font-size: 1.05rem;">Settings</h2>
    <p class="msg msg-error" id="settingsError" hidden></p>
    <p class="msg msg-ok" id="settingsOk" hidden></p>
    <form id="settingsForm">
      <div class="field">
        <label for="niche">Niche</label>
        <input type="text" id="niche" class="input" placeholder="e.g. fitness" required />
      </div>
      <div class="field">
        <label for="brandVoice">Brand voice</label>
        <input type="text" id="brandVoice" class="input" placeholder="e.g. neutral, energetic, concise" required />
      </div>
      <div class="field">
        <label>Platforms</label>
        <div class="checkbox-row">
          <label><input type="checkbox" name="platform" value="youtube_shorts" /> YouTube Shorts</label>
          <label><input type="checkbox" name="platform" value="tiktok" /> TikTok</label>
          <label><input type="checkbox" name="platform" value="instagram_reels" /> Instagram Reels</label>
          <label><input type="checkbox" name="platform" value="facebook" /> Facebook</label>
        </div>
      </div>
      <div class="field">
        <label for="targetDurationSec">Target duration (seconds)</label>
        <input type="number" id="targetDurationSec" class="input" min="15" max="60" value="25" required />
      </div>
      <div class="field">
        <label for="videoVendor">Video vendor</label>
        <select id="videoVendor" class="input">
          <option value="higgsfield">Higgsfield</option>
          <option value="kling">Kling</option>
          <option value="runway">Runway</option>
          <option value="pika">Pika</option>
          <option value="gemini">Gemini (stills + Ken Burns)</option>
          <option value="replicate">Replicate (many models — see REPLICATE_MODEL)</option>
        </select>
      </div>
      <div class="field">
        <label for="voiceVendor">Voiceover (optional)</label>
        <select id="voiceVendor" class="input">
          <option value="">None</option>
          <option value="elevenlabs">ElevenLabs</option>
          <option value="grok">Grok</option>
        </select>
      </div>
      <div class="field">
        <label for="cadence">Cadence</label>
        <select id="cadence" class="input">
          <option value="manual">Manual (I'll click "Run now")</option>
          <option value="weekly">Weekly (scheduled)</option>
        </select>
      </div>
      <button type="submit" class="btn btn-primary">Save settings</button>
    </form>
  </div>

  <div class="card">
    <h2 style="font-size: 1.05rem;">Run</h2>
    <p class="msg msg-error" id="runError" hidden></p>
    <p class="msg msg-ok" id="runOk" hidden></p>
    <div class="row">
      <button class="btn btn-primary" id="runNowBtn" type="button">Run now (dry-run)</button>
      <label style="font-size: 0.82rem; color: var(--text-dim); display: flex; align-items: center; gap: 0.4rem;">
        <input type="checkbox" id="liveRunCheckbox" /> Run live (uses real vendor credits, if configured)
      </label>
    </div>
  </div>
</div>

<script>
const authView = document.getElementById('authView');
const appView = document.getElementById('appView');
const inviteToken = new URLSearchParams(window.location.search).get('token');
let mode = inviteToken ? 'invite' : 'login';

function setMode(next) {
  mode = next;
  document.getElementById('authSubmit').textContent = mode === 'login' ? 'Log in' : mode === 'invite' ? 'Accept invite & join' : 'Sign up';
  document.getElementById('orgNameField').hidden = mode !== 'signup';
  document.getElementById('authEmailField').hidden = mode === 'invite';
  document.getElementById('authEmail').required = mode !== 'invite';
}
document.getElementById('tabLogin').addEventListener('click', () => setMode('login'));
document.getElementById('tabSignup').addEventListener('click', () => setMode('signup'));
if (inviteToken) {
  document.querySelector('#authView h1').textContent = "You've been invited — set a password to join";
  document.querySelector('.tabs').hidden = true;
}
setMode(mode);

const themeToggleBtn = document.getElementById('themeToggleBtn');
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('vvugc-theme', theme);
  themeToggleBtn.textContent = theme === 'light' ? 'Dark mode' : 'Light mode';
  themeToggleBtn.setAttribute('aria-pressed', String(theme === 'light'));
}
applyTheme(currentTheme());
themeToggleBtn.addEventListener('click', () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light'));

function showError(id, message) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.hidden = false;
}
function hide(id) { document.getElementById(id).hidden = true; }

document.getElementById('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hide('authError');
  const email = document.getElementById('authEmail').value;
  const password = document.getElementById('authPassword').value;
  const orgName = document.getElementById('authOrgName').value;
  const path = mode === 'login' ? '/accounts/login' : mode === 'invite' ? '/accounts/invite/accept' : '/accounts/signup';
  const body = mode === 'login' ? { email, password } : mode === 'invite' ? { token: inviteToken, password } : { email, password, orgName };
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Request failed');
    }
    await boot();
  } catch (err) {
    showError('authError', err.message);
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/accounts/logout', { method: 'POST' });
  appView.hidden = true;
  authView.hidden = false;
});

async function loadUsage() {
  const res = await fetch('/accounts/usage');
  if (!res.ok) return;
  const usage = await res.json();
  document.getElementById('statRuns').textContent = usage.totalRuns;
  document.getElementById('statItems').textContent = usage.totalReviewItemsCreated;
  document.getElementById('statSpend').textContent = '$' + usage.totalUsd.toFixed(2);

  // Simple bar chart: spend per run, oldest first, last 20 runs — no charting
  // library needed for "how has spend trended recently".
  const runs = [...usage.runs].reverse().slice(-20);
  const max = Math.max(...runs.map((r) => r.estimatedCostUsd), 0.0001);
  document.getElementById('usageChart').innerHTML = runs
    .map((r) => \`<div class="chart-bar" style="height:\${Math.max((r.estimatedCostUsd / max) * 100, 2)}%" title="\${r.runId}: $\${r.estimatedCostUsd.toFixed(4)}"></div>\`)
    .join('');
}

async function loadTeam() {
  hide('teamError');
  const res = await fetch('/accounts/members');
  if (!res.ok) return;
  const data = await res.json();
  document.getElementById('memberList').innerHTML = data.members
    .map((m) => \`<li>\${m.email} \${m.role === 'owner' ? '(owner)' : ''}</li>\`)
    .join('');
  document.getElementById('inviteForm').style.display = data.role === 'owner' ? 'flex' : 'none';
}

document.getElementById('inviteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hide('teamError');
  document.getElementById('inviteResult').textContent = '';
  const email = document.getElementById('inviteEmail').value;
  try {
    const res = await fetch('/accounts/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Request failed');
    }
    const { inviteToken } = await res.json();
    const link = \`\${window.location.origin}/account/join?token=\${inviteToken}\`;
    document.getElementById('inviteResult').textContent = \`Invite link (send it to \${email}): \${link}\`;
    document.getElementById('inviteEmail').value = '';
  } catch (err) {
    showError('teamError', err.message);
  }
});

async function loadBilling() {
  hide('billingError');
  const res = await fetch('/accounts/billing');
  if (!res.ok) return;
  const data = await res.json();
  const label = document.getElementById('currentPlanLabel');
  label.textContent = data.plan.tierId
    ? \`Current plan: \${data.plan.tierId} (\${data.plan.status})\${data.monthlyRunLimit ? ' — ' + data.runsUsedThisMonth + '/' + data.monthlyRunLimit + ' runs this month' : ''}\`
    : 'No active plan.';

  document.getElementById('tierButtons').innerHTML = data.tiers
    .map((t) => \`<button class="btn \${data.plan.tierId === t.id ? '' : 'btn-primary'}" data-tier="\${t.id}" \${data.plan.tierId === t.id ? 'disabled' : ''}>\${t.name} — $\${t.priceUsdPerMonth}/mo</button>\`)
    .join('');
  document.querySelectorAll('#tierButtons button[data-tier]').forEach((btn) => {
    btn.addEventListener('click', () => startCheckout(btn.getAttribute('data-tier'), btn));
  });
}

async function startCheckout(tierId, btn) {
  hide('billingError');
  btn.disabled = true;
  btn.classList.add('btn-loading');
  try {
    const res = await fetch('/accounts/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Request failed');
    }
    const { url } = await res.json();
    window.location.href = url;
  } catch (err) {
    showError('billingError', err.message);
    btn.disabled = false;
    btn.classList.remove('btn-loading');
  }
}

async function loadSettings() {
  const res = await fetch('/accounts/settings');
  if (!res.ok) return;
  const s = await res.json();
  document.getElementById('niche').value = s.niche || '';
  document.getElementById('brandVoice').value = s.brandVoice || '';
  document.getElementById('targetDurationSec').value = s.targetDurationSec || 25;
  document.getElementById('videoVendor').value = s.videoVendor || 'higgsfield';
  document.getElementById('voiceVendor').value = s.voiceVendor || '';
  document.getElementById('cadence').value = s.cadence || 'manual';
  document.querySelectorAll('input[name="platform"]').forEach((cb) => {
    cb.checked = (s.platforms || []).includes(cb.value);
  });
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hide('settingsError');
  hide('settingsOk');
  const platforms = [...document.querySelectorAll('input[name="platform"]:checked')].map((cb) => cb.value);
  const body = {
    niche: document.getElementById('niche').value,
    brandVoice: document.getElementById('brandVoice').value,
    platforms,
    targetDurationSec: Number(document.getElementById('targetDurationSec').value),
    videoVendor: document.getElementById('videoVendor').value,
    voiceVendor: document.getElementById('voiceVendor').value || undefined,
    cadence: document.getElementById('cadence').value
  };
  try {
    const res = await fetch('/accounts/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Request failed');
    }
    document.getElementById('settingsOk').textContent = 'Saved.';
    document.getElementById('settingsOk').hidden = false;
  } catch (err) {
    showError('settingsError', err.message);
  }
});

document.getElementById('runNowBtn').addEventListener('click', async () => {
  hide('runError');
  hide('runOk');
  const btn = document.getElementById('runNowBtn');
  const live = document.getElementById('liveRunCheckbox').checked;
  btn.disabled = true;
  btn.classList.add('btn-loading');
  try {
    const res = await fetch('/accounts/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: !live })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Request failed');
    }
    const result = await res.json();
    document.getElementById('runOk').textContent = \`Run complete — \${result.reviewItemsCreated} video(s) queued for review.\`;
    document.getElementById('runOk').hidden = false;
    await loadUsage();
  } catch (err) {
    showError('runError', err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
  }
});

async function boot() {
  const res = await fetch('/accounts/me');
  if (res.ok) {
    authView.hidden = true;
    appView.hidden = false;
    await Promise.all([loadUsage(), loadSettings(), loadBilling(), loadTeam()]);
  } else {
    authView.hidden = false;
    appView.hidden = true;
  }
}
boot();
</script>
</body>
</html>`;
}
