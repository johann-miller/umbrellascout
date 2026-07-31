/* ═══════════════════════════════════════════════════════
   Weather Dashboard — admin.js
   ═══════════════════════════════════════════════════════ */

const LOG_DB_NAME = 'WeatherDashboardLogs';
const LOG_DB_VERSION = 1;
const LOG_STORE = 'entries';

let logDb = null;
let logData = [];
let sortField = 'timestamp';
let sortDir = -1;

/* ── IndexedDB ─────────────────────────────────────── */
function openLogDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LOG_DB_NAME, LOG_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOG_STORE)) {
        db.createObjectStore(LOG_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => { logDb = req.result; resolve(logDb); };
    req.onerror = () => reject(req.error);
  });
}

function getAllLogs() {
  return new Promise((resolve, reject) => {
    if (!logDb) { resolve([]); return; }
    const tx = logDb.transaction(LOG_STORE, 'readonly');
    const req = tx.objectStore(LOG_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ── Cookie helpers ────────────────────────────────── */
function getCookie(name) {
  const v = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
  return v ? v.pop() : undefined;
}

function readLocationCookie() {
  const raw = getCookie('dashboard_location');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function writeLocationCookie(data) {
  const d = new Date();
  d.setTime(d.getTime() + 365 * 864e5);
  document.cookie = `dashboard_location=${JSON.stringify(data)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
}

/* ── Location config ───────────────────────────────── */
function loadConfigForm() {
  const cfg = readLocationCookie() || {};
  document.getElementById('cfg-lat').value = cfg.lat || '';
  document.getElementById('cfg-lon').value = cfg.lon || '';
  document.getElementById('cfg-zoom').value = cfg.zoom || 8;
}

document.getElementById('save-cfg-btn').addEventListener('click', () => {
  const cfg = readLocationCookie() || {};
  cfg.lat = parseFloat(document.getElementById('cfg-lat').value);
  cfg.lon = parseFloat(document.getElementById('cfg-lon').value);
  cfg.zoom = parseInt(document.getElementById('cfg-zoom').value, 10) || 8;
  cfg.wfo = null;
  cfg.x = null;
  cfg.y = null;
  writeLocationCookie(cfg);
  window.location.href = 'index.html';
});

/* ── Panel state (from localStorage proxy) ─────────── */
function renderPanelState() {
  const grid = document.getElementById('state-grid');
  if (!grid) return;
  const panels = ['radar', 'current', 'hourly', 'daily'];
  grid.innerHTML = panels.map(p => {
    const state = JSON.parse(localStorage.getItem('panel_' + p) || '{}');
    return `
      <div class="state-card">
        <h3>${p.charAt(0).toUpperCase() + p.slice(1)}</h3>
        <p>Status: ${state.status || 'unknown'}</p>
        <p>Last fetch: ${state.lastFetch || 'never'}</p>
        <p>Error: ${state.error || 'none'}</p>
        <p>Retries: ${state.retryCount || 0}</p>
      </div>
    `;
  }).join('');
}

/* ── Logs ──────────────────────────────────────────── */
async function loadLogs() {
  logData = await getAllLogs();
  populateFilters();
  renderLogs();
}

function populateFilters() {
  const endpoints = [...new Set(logData.map(e => e.endpoint).filter(Boolean))];
  const sel = document.getElementById('filter-endpoint');
  sel.innerHTML = '<option value="">All</option>' + endpoints.map(e => `<option value="${e}">${truncate(e, 60)}</option>`).join('');
}

function truncate(s, n) {
  return s.length > n ? s.substring(0, n) + '…' : s;
}

function getFilteredLogs() {
  const epFilter = document.getElementById('filter-endpoint').value;
  const stFilter = document.getElementById('filter-status').value;
  return logData.filter(e => {
    if (epFilter && e.endpoint !== epFilter) return false;
    if (stFilter === 'ok' && (e.error || e.status >= 400)) return false;
    if (stFilter === 'err' && !e.error && e.status < 400) return false;
    return true;
  });
}

function sortLogs(logs) {
  return logs.sort((a, b) => {
    let va = a[sortField];
    let vb = b[sortField];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') {
      return va.localeCompare(vb) * sortDir;
    }
    return (va - vb) * sortDir;
  });
}

function renderLogs() {
  const tbody = document.getElementById('log-tbody');
  if (!tbody) return;
  const filtered = getFilteredLogs();
  const sorted = sortLogs(filtered);
  tbody.innerHTML = sorted.map(e => {
    const isErr = e.error || e.status >= 400;
    return `<tr>
      <td>${new Date(e.timestamp).toLocaleString()}</td>
      <td title="${e.endpoint || ''}">${truncate(e.endpoint || '', 70)}</td>
      <td class="${isErr ? 'log-status-err' : 'log-status-ok'}">${e.status || '—'}</td>
      <td>${e.error ? truncate(e.error, 50) : '—'}</td>
      <td>${e.responseTime || '—'}</td>
      <td>${e.retryCount || 0}</td>
    </tr>`;
  }).join('');
}

document.getElementById('filter-endpoint').addEventListener('change', renderLogs);
document.getElementById('filter-status').addEventListener('change', renderLogs);
document.getElementById('refresh-logs-btn').addEventListener('click', loadLogs);

document.querySelectorAll('.log-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const field = th.dataset.sort;
    if (sortField === field) { sortDir *= -1; }
    else { sortField = field; sortDir = -1; }
    renderLogs();
  });
});

/* ── Init ──────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  await openLogDb();
  loadConfigForm();
  renderPanelState();
  await loadLogs();
});
