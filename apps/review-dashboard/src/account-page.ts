/**
 * The account-facing, self-service surface — separate from renderDashboardPage()'s
 * operator queue (Basic-Auth-protected). This page is public (session-cookie
 * auth handled client-side against /accounts/* — see accounts.ts) and is where a
 * new customer signs up, configures their niche/brand-voice/platforms, and
 * triggers their first run without touching the CLI.
 */
export function renderAccountPage(scriptNonce = "development-nonce"): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Viral Video UGC — Your Account</title>
<script nonce="${scriptNonce}">
let csrfToken = '';
const nativeFetch = window.fetch.bind(window);
window.fetch = function(input, init) {
  const options = Object.assign({}, init || {});
  const method = String(options.method || 'GET').toUpperCase();
  if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    options.headers = Object.assign({}, options.headers || {}, { 'X-CSRF-Token': csrfToken });
  }
  return nativeFetch(input, options);
};
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
    <p class="msg msg-ok" id="authNotice" hidden></p>
    <form id="authForm">
      <div class="field" id="authEmailField">
        <label for="authEmail">Email</label>
        <input type="email" id="authEmail" class="input" required />
      </div>
      <div class="field">
        <label for="authPassword">Password</label>
        <input type="password" id="authPassword" class="input" required minlength="8" />
      </div>
      <div class="field" id="mfaField" hidden>
        <label for="authMfaCode">Authentication code</label>
        <input type="text" id="authMfaCode" class="input" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" placeholder="6-digit code" />
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
      <a class="btn" href="/">Home dashboard</a>
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
    <form id="inviteForm" class="row" style="display: none;">
      <label for="inviteEmail" class="visually-hidden">Teammate's email</label>
      <input type="email" id="inviteEmail" class="input" placeholder="teammate@agency.com" required style="flex: 1;" />
      <select id="inviteRole" class="input" style="width: auto;" aria-label="Role for the invitee">
        <option value="admin">Admin</option>
        <option value="editor" selected>Editor</option>
        <option value="reviewer">Reviewer</option>
        <option value="viewer">Viewer</option>
      </select>
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
    <h2 style="font-size: 1.05rem;">Clients</h2>
    <p style="font-size: 0.85rem; color: var(--text-dim);">Each client has independent brand, platform, language, and schedule settings.</p>
    <p class="msg msg-error" id="clientsError" hidden></p>
    <div class="row">
      <label for="clientSelect" class="visually-hidden">Active client</label>
      <select id="clientSelect" class="input" style="flex: 1;"><option value="">No client selected</option></select>
      <input id="newClientName" class="input" style="flex: 1;" placeholder="Client / brand name" aria-label="New client or brand name" />
      <button class="btn btn-primary" id="saveClientBtn" type="button">Save as client</button>
    </div>
    <div class="row" style="margin-top: 0.75rem;">
      <button class="btn" id="connectYouTubeBtn" type="button">Connect YouTube</button>
      <span id="socialConnectionStatus" style="font-size: 0.8rem; color: var(--text-dim);"></span>
    </div>
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
          <!-- <label><input type="checkbox" name="platform" value="instagram_reels" /> Instagram Reels</label> -->
          <!-- <label><input type="checkbox" name="platform" value="facebook" /> Facebook</label> -->
        </div>
      </div>
      <div class="field">
        <label for="locale">Content language</label>
        <input type="text" id="locale" class="input" value="en" placeholder="e.g. en, sv, es, pt-BR" required />
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
    <h2 style="font-size: 1.05rem;">Security</h2>
    <p class="msg msg-error" id="securityError" hidden></p>
    <form id="passwordForm">
      <div class="field">
        <label for="currentPassword">Current password</label>
        <input type="password" id="currentPassword" class="input" required />
      </div>
      <div class="field">
        <label for="newPassword">New password</label>
        <input type="password" id="newPassword" class="input" required minlength="8" />
      </div>
      <button type="submit" class="btn">Change password</button>
      <span style="font-size: 0.78rem; color: var(--text-dim); margin-left: 0.6rem;">Changing it signs you out everywhere.</span>
    </form>
    <div id="securityCard" style="margin-top: 1rem;">
      <div id="mfaSection" style="border-top: 1px solid var(--border); padding-top: 1rem; margin-bottom: 1rem;">
        <h3 style="font-size: 0.9rem; margin-bottom: 0.4rem;">Two-factor authentication</h3>
        <p id="mfaStatus" style="font-size: 0.82rem; color: var(--text-dim);"></p>
        <div id="mfaEnableRow" class="row" style="margin-top: 0.5rem;">
          <button class="btn" id="mfaEnableBtn" type="button">Enable 2FA</button>
        </div>
        <div id="mfaEnroll" hidden style="margin-top: 0.5rem;">
          <p style="font-size: 0.82rem; color: var(--text-dim);">Add this secret to your authenticator app (Google Authenticator, Authy, 1Password…), then enter the current code to confirm:</p>
          <code id="mfaSecret" style="display:block; margin: 0.5rem 0; word-break: break-all; font-size: 0.85rem;"></code>
          <div class="row">
            <input id="mfaVerifyCode" class="input" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="6-digit code" style="max-width: 9rem;" aria-label="Authentication code to confirm enrollment" />
            <button class="btn btn-primary" id="mfaVerifyBtn" type="button">Confirm and enable</button>
          </div>
        </div>
        <div id="mfaDisableRow" hidden style="margin-top: 0.5rem;">
          <div class="row">
            <input id="mfaDisableCode" class="input" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="6-digit code" style="max-width: 9rem;" aria-label="Current authentication code" />
            <button class="btn" id="mfaDisableBtn" type="button">Disable 2FA</button>
          </div>
        </div>
      </div>
      <h3 style="font-size: 0.9rem; margin-bottom: 0.4rem;">Recent security events</h3>
      <ul id="securityEventsList" style="font-size: 0.8rem; padding-left: 1.1rem; color: var(--text-dim);"></ul>
    </div>
  </div>

  <div class="card">
    <h2 style="font-size: 1.05rem;">Data &amp; account</h2>
    <p class="msg msg-error" id="deleteError" hidden></p>
    <div class="row" style="margin-bottom: 0.75rem;">
      <a class="btn" href="/accounts/export" id="exportLink">Download my data (JSON)</a>
      <span style="font-size: 0.78rem; color: var(--text-dim);">A copy of everything this org has stored.</span>
    </div>
    <p id="deleteHint" style="font-size: 0.82rem; color: var(--text-dim);">Type DELETE and your password, then confirm. This cannot be undone.</p>
    <form id="deleteForm" class="row">
      <input id="deleteConfirm" class="input" placeholder="Type DELETE" style="max-width: 9rem;" />
      <input type="password" id="deletePassword" class="input" placeholder="Your password" />
      <button type="submit" class="btn" style="color: var(--bad); border-color: var(--bad);">Delete account</button>
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

  <div class="card">
    <div class="row" style="justify-content: space-between;">
      <h2 style="font-size: 1.05rem;">Client review queue</h2>
      <button class="btn" id="refreshReviewsBtn" type="button">Refresh</button>
    </div>
    <p class="msg msg-error" id="reviewsError" hidden></p>
    <div id="customerReviewList"><p style="color: var(--text-dim);">Select a client to see its videos.</p></div>
  </div>
</div>

<script nonce="${scriptNonce}">
const authView = document.getElementById('authView');
const appView = document.getElementById('appView');
const inviteToken = new URLSearchParams(window.location.search).get('token');
let mode = inviteToken ? 'invite' : 'login';
let agencyClients = [];
let pendingMfaToken = '';
let isOwner = false;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setMode(next) {
  mode = next;
  pendingMfaToken = '';
  document.getElementById('mfaField').hidden = true;
  document.getElementById('authSubmit').textContent = mode === 'login' ? 'Log in' : mode === 'invite' ? 'Accept invite & join' : 'Sign up';
  document.getElementById('orgNameField').hidden = mode !== 'signup';
  document.getElementById('authEmailField').hidden = mode === 'invite';
  document.getElementById('authEmail').required = mode !== 'invite';
  // Restore the password constraint when leaving the MFA challenge step (the
  // challenge branch below clears the value and temporarily drops "required",
  // otherwise the empty-but-required password field silently blocks the form's
  // submit event via HTML5 constraint validation — the "Verify code" button
  // would appear to do nothing).
  document.getElementById('authPassword').required = true;
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
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
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
  hide('authNotice');

  // Step two of a two-factor login: the password was already accepted and we're
  // now redeeming the challenge token with the authenticator code.
  if (pendingMfaToken) {
    const code = document.getElementById('authMfaCode').value;
    try {
      const res = await fetch('/accounts/mfa/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfaToken: pendingMfaToken, code })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Request failed');
      }
      pendingMfaToken = '';
      await boot();
    } catch (err) {
      showError('authError', err.message);
    }
    return;
  }

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
    const data = await res.json();
    // Password accepted but the account has 2FA enabled — switch the form to the
    // authenticator-code step instead of proceeding to the app.
    if (data.mfaRequired) {
      pendingMfaToken = data.mfaToken;
      document.getElementById('mfaField').hidden = false;
      document.getElementById('authMfaCode').value = '';
      document.getElementById('authPassword').value = '';
      // The password was already accepted by the server; an empty-but-required
      // field here would block the "Verify code" submit via HTML5 constraint
      // validation (submit event never fires). Drop "required" for the
      // challenge step — setMode() restores it when the form resets.
      document.getElementById('authPassword').removeAttribute('required');
      document.getElementById('authSubmit').textContent = 'Verify code';
      document.getElementById('authMfaCode').focus();
      return;
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
  const canManageTeam = data.canManageTeam;
  const roleLabel = (role) => ({ owner: 'Owner', admin: 'Admin', editor: 'Editor', reviewer: 'Reviewer', viewer: 'Viewer', member: 'Editor' })[role] || role;
  const changeableRoles = ['admin', 'editor', 'reviewer', 'viewer'];
  document.getElementById('memberList').innerHTML = data.members
    .map((m) => {
      const effectiveRole = m.role === 'member' ? 'editor' : m.role;
      let controls = '';
      if (canManageTeam && m.role !== 'owner') {
        controls =
          '<select class="input member-role" data-id="' + m.id + '" style="width: auto; margin-left: 0.5rem;">' +
          changeableRoles.map((r) => '<option value="' + r + '"' + (effectiveRole === r ? ' selected' : '') + '>' + r + '</option>').join('') +
          '</select>' +
          '<button class="btn member-remove" type="button" data-id="' + m.id + '" data-email="' + escapeHtml(m.email) + '" style="margin-left: 0.5rem; font-size: 0.75rem;">Remove</button>';
      }
      return '<li style="margin-bottom: 0.4rem;">' + escapeHtml(m.email) + ' <span class="pill">' + roleLabel(m.role) + '</span>' + controls + '</li>';
    })
    .join('');
  document.getElementById('inviteForm').style.display = canManageTeam ? 'flex' : 'none';
  document.getElementById('securityCard').style.display = canManageTeam ? '' : 'none';
}

document.getElementById('memberList').addEventListener('change', async (event) => {
  if (!event.target.classList.contains('member-role')) return;
  const id = event.target.dataset.id;
  const role = event.target.value;
  try {
    const res = await fetch('/accounts/members/' + id + '/role', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Could not change role');
    }
    await loadTeam();
  } catch (err) {
    showError('teamError', err.message);
    await loadTeam();
  }
});

document.getElementById('memberList').addEventListener('click', async (event) => {
  const button = event.target.closest('.member-remove');
  if (!button) return;
  const id = button.dataset.id;
  const email = button.dataset.email;
  if (!window.confirm('Remove ' + email + ' from this org? Their sessions will be revoked immediately.')) return;
  try {
    const res = await fetch('/accounts/members/' + id, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Could not remove member');
    }
    await loadTeam();
  } catch (err) {
    showError('teamError', err.message);
  }
});

document.getElementById('inviteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hide('teamError');
  document.getElementById('inviteResult').textContent = '';
  const email = document.getElementById('inviteEmail').value;
  const role = document.getElementById('inviteRole').value;
  try {
    const res = await fetch('/accounts/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Request failed');
    }
    const { inviteToken } = await res.json();
    const link = \`\${window.location.origin}/account/join?token=\${inviteToken}\`;
    document.getElementById('inviteResult').textContent = \`\${role} invite link (send it to \${email}): \${link}\`;
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
  document.getElementById('locale').value = s.locale || 'en';
  document.querySelectorAll('input[name="platform"]').forEach((cb) => {
    cb.checked = (s.platforms || []).includes(cb.value);
  });
}

function applyClient(client) {
  if (!client) return;
  document.getElementById('newClientName').value = client.name;
  document.getElementById('niche').value = client.niche;
  document.getElementById('brandVoice').value = client.brandVoice;
  document.getElementById('locale').value = client.locale || 'en';
  document.getElementById('targetDurationSec').value = client.targetDurationSec;
  document.getElementById('videoVendor').value = client.videoVendor;
  document.getElementById('voiceVendor').value = client.voiceVendor || '';
  document.getElementById('cadence').value = client.cadence;
  document.querySelectorAll('input[name="platform"]').forEach((cb) => { cb.checked = client.platforms.includes(cb.value); });
}

async function loadClients() {
  const res = await fetch('/accounts/clients');
  if (!res.ok) return;
  const data = await res.json();
  agencyClients = data.clients.filter((client) => client.active);
  const select = document.getElementById('clientSelect');
  const selected = select.value;
  select.innerHTML = '<option value="">No client selected</option>' + agencyClients
    .map((client) => '<option value="' + client.id + '">' + escapeHtml(client.name) + '</option>').join('');
  if (agencyClients.some((client) => client.id === selected)) select.value = selected;
  else if (agencyClients.length) {
    select.value = agencyClients[0].id;
    applyClient(agencyClients[0]);
  }
}

document.getElementById('clientSelect').addEventListener('change', (event) => {
  applyClient(agencyClients.find((client) => client.id === event.target.value));
  loadCustomerReviews();
  loadSocialConnections();
});

async function loadSocialConnections() {
  const clientId = document.getElementById('clientSelect').value;
  const status = document.getElementById('socialConnectionStatus');
  if (!clientId) {
    status.textContent = 'Select a client first.';
    return;
  }
  const res = await fetch('/accounts/social-connections?clientId=' + encodeURIComponent(clientId));
  const data = await res.json().catch(() => ({}));
  const youtube = data.connections?.find((connection) => connection.platform === 'youtube_shorts');
  status.textContent = youtube ? 'YouTube: ' + youtube.accountLabel + ' · ' + youtube.status : 'YouTube not connected';
}

document.getElementById('connectYouTubeBtn').addEventListener('click', async () => {
  const clientId = document.getElementById('clientSelect').value;
  if (!clientId) return showError('clientsError', 'Select or create a client first.');
  const res = await fetch('/accounts/clients/' + clientId + '/oauth/google/start', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showError('clientsError', data.error || 'Could not start Google authorization.');
  window.location.assign(data.authorizationUrl);
});

document.getElementById('saveClientBtn').addEventListener('click', async () => {
  hide('clientsError');
  const name = document.getElementById('newClientName').value.trim();
  if (!name) return showError('clientsError', 'Enter a client or brand name.');
  const platforms = [...document.querySelectorAll('input[name="platform"]:checked')].map((cb) => cb.value);
  const body = {
    name,
    niche: document.getElementById('niche').value,
    brandVoice: document.getElementById('brandVoice').value,
    locale: document.getElementById('locale').value,
    platforms,
    targetDurationSec: Number(document.getElementById('targetDurationSec').value),
    videoVendor: document.getElementById('videoVendor').value,
    voiceVendor: document.getElementById('voiceVendor').value || undefined,
    cadence: document.getElementById('cadence').value,
    active: true
  };
  const selectedId = document.getElementById('clientSelect').value;
  const res = await fetch(selectedId ? '/accounts/clients/' + selectedId : '/accounts/clients', {
    method: selectedId ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showError('clientsError', data.error || 'Could not save client.');
  await loadClients();
  document.getElementById('clientSelect').value = data.client.id;
  await loadCustomerReviews();
});

async function loadCustomerReviews() {
  hide('reviewsError');
  const clientId = document.getElementById('clientSelect').value;
  const list = document.getElementById('customerReviewList');
  if (!clientId) {
    list.innerHTML = '<p style="color: var(--text-dim);">Select a client to see its videos.</p>';
    return;
  }
  const res = await fetch('/accounts/review-items?clientId=' + encodeURIComponent(clientId));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showError('reviewsError', data.error || 'Could not load review queue.');
  if (!data.items.length) {
    list.innerHTML = '<p style="color: var(--text-dim);">No videos yet. Run this client to create its first review batch.</p>';
    return;
  }
  list.innerHTML = data.items.map((item) =>
    '<article class="card" data-review-id="' + item.id + '">' +
      '<div class="row" style="justify-content: space-between;"><strong>' + escapeHtml(item.niche) + ' · ' + escapeHtml(item.platform) + '</strong><span class="pill">' + escapeHtml(item.status) + '</span></div>' +
      '<p>' + escapeHtml(item.script.hook) + '</p>' +
      '<p style="font-size: 0.8rem; color: var(--text-dim);">Virality score ' + item.score + '/100</p>' +
      (item.status === 'pending' ? '<div class="row"><button class="btn btn-primary customer-review-action" data-action="approve">Approve</button><button class="btn customer-review-action" data-action="reject">Reject</button></div>' : '') +
    '</article>'
  ).join('');
}

document.getElementById('refreshReviewsBtn').addEventListener('click', loadCustomerReviews);
document.getElementById('customerReviewList').addEventListener('click', async (event) => {
  const button = event.target.closest('.customer-review-action');
  if (!button) return;
  const article = button.closest('[data-review-id]');
  const res = await fetch('/accounts/review-items/' + article.dataset.reviewId + '/' + button.dataset.action, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showError('reviewsError', data.error || 'Could not update review item.');
  await loadCustomerReviews();
});

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
      body: JSON.stringify({ dryRun: !live, clientId: document.getElementById('clientSelect').value || undefined })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Request failed');
    }
    const result = await res.json();
    document.getElementById('runOk').textContent = \`Run complete — \${result.reviewItemsCreated} video(s) queued for review.\`;
    document.getElementById('runOk').hidden = false;
    await loadUsage();
    await loadCustomerReviews();
  } catch (err) {
    showError('runError', err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
  }
});

document.getElementById('passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hide('securityError');
  const currentPassword = document.getElementById('currentPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  try {
    const res = await fetch('/accounts/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Could not change password');
    }
    // Every session (including this one) was revoked — return to the login view.
    csrfToken = '';
    document.getElementById('currentPassword').value = '';
    document.getElementById('newPassword').value = '';
    appView.hidden = true;
    authView.hidden = false;
    setMode('login');
    document.getElementById('authNotice').textContent = 'Password changed — all sessions were signed out. Please log in with your new password.';
    document.getElementById('authNotice').hidden = false;
  } catch (err) {
    showError('securityError', err.message);
  }
});

async function loadSecurityEvents() {
  const res = await fetch('/accounts/security-events');
  if (!res.ok) return;
  const data = await res.json();
  document.getElementById('securityEventsList').innerHTML = data.events.length
    ? data.events.map((ev) => {
        const when = new Date(ev.at).toLocaleString();
        const who = ev.email || ev.actorAccountId || '';
        const detail = ev.detail ? ' — ' + ev.detail : '';
        return '<li>' + escapeHtml(when + ' · ' + ev.type + ' · ' + who + detail) + '</li>';
      }).join('')
    : '<li>No security events yet.</li>';
}

function renderMfa(enabled) {
  document.getElementById('mfaStatus').textContent = enabled
    ? "Two-factor authentication is ON — you'll be asked for an authenticator code at login."
    : 'Two-factor authentication is OFF.';
  document.getElementById('mfaEnableRow').hidden = enabled;
  document.getElementById('mfaEnroll').hidden = true;
  document.getElementById('mfaDisableRow').hidden = !enabled;
}

document.getElementById('mfaEnableBtn').addEventListener('click', async () => {
  hide('securityError');
  const res = await fetch('/accounts/mfa/enroll', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showError('securityError', data.error || 'Could not start two-factor enrollment.');
  document.getElementById('mfaSecret').textContent = data.secret;
  document.getElementById('mfaEnroll').hidden = false;
  document.getElementById('mfaStatus').textContent = 'Scan this code or enter it manually, then enter the current code to confirm.';
});

document.getElementById('mfaVerifyBtn').addEventListener('click', async () => {
  hide('securityError');
  const code = document.getElementById('mfaVerifyCode').value.trim();
  if (!code) return showError('securityError', 'Enter the code from your authenticator app.');
  const res = await fetch('/accounts/mfa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showError('securityError', data.error || 'Could not confirm two-factor enrollment.');
  document.getElementById('mfaVerifyCode').value = '';
  renderMfa(true);
  await loadSecurityEvents();
});

document.getElementById('mfaDisableBtn').addEventListener('click', async () => {
  hide('securityError');
  const code = document.getElementById('mfaDisableCode').value.trim();
  if (!code) return showError('securityError', 'Enter the current code from your authenticator app.');
  const res = await fetch('/accounts/mfa/disable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showError('securityError', data.error || 'Could not disable two-factor authentication.');
  document.getElementById('mfaDisableCode').value = '';
  renderMfa(false);
  await loadSecurityEvents();
});

document.getElementById('deleteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hide('deleteError');
  const confirm = document.getElementById('deleteConfirm').value.trim();
  const password = document.getElementById('deletePassword').value;
  if (confirm !== 'DELETE') return showError('deleteError', 'Type DELETE to confirm.');
  try {
    const res = await fetch('/accounts/delete-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm, password })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Could not delete account');
    }
    csrfToken = '';
    pendingMfaToken = '';
    appView.hidden = true;
    authView.hidden = false;
    setMode('login');
    document.getElementById('authNotice').textContent = isOwner
      ? 'Your account and organization were deleted.'
      : 'Your account was deleted.';
    document.getElementById('authNotice').hidden = false;
  } catch (err) {
    showError('deleteError', err.message);
  }
});

async function boot() {
  const res = await fetch('/accounts/me');
  if (res.ok) {
    const me = await res.json();
    csrfToken = me.csrfToken || '';
    isOwner = me.account.role === 'owner';
    renderMfa(Boolean(me.mfaEnabled));
    document.getElementById('deleteHint').textContent = isOwner
      ? 'You are the owner — deleting your account deletes the entire organization and all of its data. This cannot be undone.'
      : 'Deleting your account removes you from this organization. This cannot be undone.';
    authView.hidden = true;
    appView.hidden = false;
    await Promise.all([loadUsage(), loadSettings(), loadBilling(), loadTeam(), loadSecurityEvents()]);
    await loadClients();
    await loadCustomerReviews();
    await loadSocialConnections();
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
