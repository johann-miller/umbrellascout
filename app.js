/* ═══════════════════════════════════════════════════════
   Weather Dashboard — app.js
   Static frontend, no build step, no framework.
   ═══════════════════════════════════════════════════════ */

/* ── Defaults ──────────────────────────────────────── */
const DEFAULTS = Object.freeze({
  lat: 39.9612,
  lon: -82.9988,
  zoom: 8,
  wfo: null,
  x: null,
  y: null,
});

/* ── Cookie helpers ────────────────────────────────── */
function setCookie(name, value, days = 365) {
  const d = new Date();
  d.setTime(d.getTime() + days * 864e5);
  document.cookie = `${name}=${value};expires=${d.toUTCString()};path=/;SameSite=Lax`;
}

function getCookie(name) {
  const v = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
  return v ? v.pop() : undefined;
}

function readLocationCookie() {
  const raw = getCookie('dashboard_location');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch { return null; }
}

function writeLocationCookie(data) {
  setCookie('dashboard_location', JSON.stringify(data));
}

/* ── URL query params → cookie ─────────────────────── */
function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const lat = params.get('lat');
  const lon = params.get('lon');
  if (lat && lon) {
    const cfg = readLocationCookie() || { ...DEFAULTS };
    cfg.lat = parseFloat(lat);
    cfg.lon = parseFloat(lon);
    cfg.wfo = null;
    cfg.x = null;
    cfg.y = null;
    writeLocationCookie(cfg);
    window.location.href = window.location.pathname;
  }
}

/* ── IndexedDB logger ──────────────────────────────── */
const LOG_DB_NAME = 'WeatherDashboardLogs';
const LOG_DB_VERSION = 1;
const LOG_STORE = 'entries';
const LOG_RETENTION_MS = 7 * 864e5;

let logDb = null;

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

function logEntry(endpoint, status, error, responseTime, retryCount) {
  if (!logDb) return;
  const entry = {
    timestamp: new Date().toISOString(),
    endpoint,
    status,
    error,
    responseTime,
    retryCount: retryCount || 0,
  };
  const tx = logDb.transaction(LOG_STORE, 'readwrite');
  tx.objectStore(LOG_STORE).add(entry);
}

function pruneOldLogs() {
  if (!logDb) return;
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const tx = logDb.transaction(LOG_STORE, 'readwrite');
  const store = tx.objectStore(LOG_STORE);
  const req = store.getAll();
  req.onsuccess = () => {
    const toDelete = req.result.filter(e => new Date(e.timestamp).getTime() < cutoff);
    toDelete.forEach(e => store.delete(e.id));
  };
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

/* ── Retry with exponential backoff ────────────────── */
const BACKOFF_BASE = 10000;
const BACKOFF_MAX = 300000;

function backoffDelay(retryCount) {
  return Math.min(BACKOFF_BASE * Math.pow(3, retryCount), BACKOFF_MAX);
}

/* ── Panel state tracking ──────────────────────────── */
const panelState = {
  radar: { status: 'ok', lastFetch: null, error: null, retryCount: 0 },
  current: { status: 'ok', lastFetch: null, error: null, retryCount: 0 },
  hourly: { status: 'ok', lastFetch: null, error: null, retryCount: 0 },
  daily: { status: 'ok', lastFetch: null, error: null, retryCount: 0 },
};

function statusAgeMs(lastFetch) {
  if (!lastFetch) return null;
  return Date.now() - new Date(lastFetch).getTime();
}

function statusAgeStr(lastFetch) {
  const ms = statusAgeMs(lastFetch);
  if (ms === null) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m old`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m old`;
}

function updatePanelStatus(panelId, ok, error) {
  const ps = panelState[panelId];
  if (ok) {
    ps.status = 'ok';
    ps.lastFetch = new Date().toISOString();
    ps.error = null;
    ps.retryCount = 0;
  } else {
    ps.status = ps.lastFetch ? 'stale' : 'fail';
    ps.error = error;
    ps.retryCount++;
  }
  renderStatusIndicator(panelId, ps);
  localStorage.setItem('panelState', JSON.stringify(panelState));
}

function renderStatusIndicator(panelId, ps) {
  const el = document.getElementById(`status-${panelId}`);
  if (!el) return;
  el.className = `panel-status status-${ps.status}`;
  const label = el.querySelector('.status-label');
  if (ps.status === 'ok') {
    label.textContent = 'Live';
  } else if (ps.status === 'stale') {
    label.textContent = `Cached ${statusAgeStr(ps.lastFetch)}`;
  } else {
    label.textContent = ps.error || 'Failed';
  }
}

/* ── Fade transition helper ────────────────────────── */
async function fadeUpdate(panelId, updateFn) {
  const el = document.getElementById(panelId === 'current' ? 'current-conditions' : (panelId + '-strip'));
  if (!el) { updateFn(); return; }
  el.classList.add('fade-out');
  await sleep(300);
  updateFn();
  el.classList.remove('fade-out');
  el.classList.add('fade-in');
  await sleep(300);
  el.classList.remove('fade-in');
}

/* ── NWS fetch helpers ─────────────────────────────── */
const NWS_BASE = 'https://api.weather.gov';

async function nwsFetch(url, retryCount = 0) {
  const start = performance.now();
  try {
    const res = await fetch(url);
    const elapsed = Math.round(performance.now() - start);
    if (!res.ok) {
      if (res.status === 400) {
        logEntry(url, res.status, 'Bad Request — malformed query', elapsed, retryCount);
        updatePanelStatus(resolvePanel(url), false, `NWS ${res.status}`);
        return null;
      }
      logEntry(url, res.status, await res.text().catch(() => ''), elapsed, retryCount);
      updatePanelStatus(resolvePanel(url), false, `NWS ${res.status}`);
      if (retryCount < 4) {
        await sleep(backoffDelay(retryCount));
        return nwsFetch(url, retryCount + 1);
      }
      return null;
    }
    logEntry(url, res.status, null, elapsed, retryCount);
    updatePanelStatus(resolvePanel(url), true);
    return res.json();
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    logEntry(url, 0, err.message, elapsed, retryCount);
    updatePanelStatus(resolvePanel(url), false, err.message);
    if (retryCount < 4) {
      await sleep(backoffDelay(retryCount));
      return nwsFetch(url, retryCount + 1);
    }
    return null;
  }
}

function resolvePanel(url) {
  if (url.includes('/forecast/daily')) return 'daily';
  if (url.includes('/forecast')) return 'hourly';
  return 'current';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ── Grid point resolution ─────────────────────────── */
let cachedGrid = null;

async function resolveGridPoint(cfg) {
  if (cachedGrid) return cachedGrid;
  const data = await nwsFetch(`${NWS_BASE}/points/${cfg.lat},${cfg.lon}`);
  if (data && data.properties) {
    const grid = data.properties;
    cachedGrid = { wfo: grid.forecastGrid.split('/').pop(), x: grid.gridX, y: grid.gridY };
    const updated = { ...cfg, wfo: cachedGrid.wfo, x: cachedGrid.x, y: cachedGrid.y };
    writeLocationCookie(updated);
    return cachedGrid;
  }
  return null;
}

/* ── Current conditions (via observations) ──────────── */
async function fetchCurrentConditions(cfg) {
  const data = await nwsFetch(`${NWS_BASE}/points/${cfg.lat},${cfg.lon}/observation`);
  if (!data) return;
  const obsUrl = data.properties?.observationStations;
  if (!obsUrl) return;
  const match = obsUrl.match(/(\w+)$/);
  if (!match) return;
  const station = match[1];
  const obs = await nwsFetch(`${NWS_BASE}/stations/${station}/observations/latest`);
  if (!obs || !obs.features?.length) return;
  await fadeUpdate('current', () => renderCurrentConditions(obs.features[0].properties));
}

function renderCurrentConditions(props) {
  const el = document.getElementById('current-conditions');
  if (!el) return;
  const temp = props.temp ?? '—';
  const dewpoint = props.dewpoint ?? '—';
  const humidity = props.relativeHumidity ?? '—';
  const windString = props.windDirection || '—';
  const windSpeed = props.windSpeed ?? '—';
  const conditions = props.weather ? props.weather.join(', ') : (props.textDescription || '—');

  // Compute feels-like
  let feelsLike = temp;
  if (temp !== '—' && humidity !== '—' && Number(humidity) > 40) {
    const t = Number(temp);
    const rh = Number(humidity) / 100;
    if (t >= 27) {
      // Heat index (simplified)
      feelsLike = Math.round(heatIndex(t, rh)) + '°C';
    } else if (windSpeed !== '—' && Number(windSpeed) > 3.2 && t < 10) {
      // Wind chill
      const ws = Number(windSpeed);
      feelsLike = Math.round(13.2 - 11.37 * Math.pow(ws, 0.16) + 0.33 * rh * t + (17.27 - 0.33 * t) * Math.pow(ws, 0.16)) + '°C';
    }
  }

  el.innerHTML = `
    <div class="condition-row">
      <span class="condition-label">Temperature</span>
      <span class="condition-value condition-temp">${temp}°C</span>
    </div>
    <div class="condition-row">
      <span class="condition-label">Feels Like</span>
      <span class="condition-value">${feelsLike}</span>
    </div>
    <div class="condition-row">
      <span class="condition-label">Humidity</span>
      <span class="condition-value">${humidity}%</span>
    </div>
    <div class="condition-row">
      <span class="condition-label">Wind</span>
      <span class="condition-value">${windString} at ${windSpeed} km/h</span>
    </div>
    <div class="condition-row">
      <span class="condition-label">Conditions</span>
      <span class="condition-value">${conditions}</span>
    </div>
  `;
}

function heatIndex(t, rh) {
  // t in °C, rh 0-1
  const f = t * 9 / 5 + 32;
  let hi = -42.379 + 2.04901523 * f + 10.14333127 * rh - 0.22475541 * f * rh - 0.00683783 * f * f - 0.05481717 * rh * rh + 0.00122874 * f * f * rh + 0.00085282 * f * rh * rh - 0.00000199 * f * f * rh * rh;
  return (hi - 32) * 5 / 9;
}

/* ── Hourly forecast ───────────────────────────────── */
async function fetchHourlyForecast(cfg) {
  const grid = await resolveGridPoint(cfg);
  if (!grid) return;
  const data = await nwsFetch(`${NWS_BASE}/gridpoints/${grid.wfo}/${grid.x},${grid.y}/forecast?units=si`);
  if (!data || !data.properties || !data.properties.periods) return;
  const periods = data.properties.periods.filter(p => p.isDaytime !== undefined).slice(0, 12);
  await fadeUpdate('hourly', () => renderHourlyStrip(periods));
}

function renderHourlyStrip(periods) {
  const container = document.getElementById('hourly-strip');
  if (!container) return;
  container.innerHTML = periods.map(p => {
    const timeLabel = p.startTime ? new Date(p.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const pop = p.probabilityOfPrecipitation
      ? `${p.probabilityOfPrecipitation.value || p.probabilityOfPrecipitation}`
      : '';
    const iconUrl = p.icon || '';
    return `
      <div class="hourly-card">
        <span class="hourly-time">${timeLabel}</span>
        ${iconUrl ? `<img class="hourly-icon" src="${iconUrl}" alt="${p.shortForecast || ''}" />` : ''}
        <span class="hourly-temp">${p.temperature}°</span>
        ${pop ? `<span class="hourly-pop">💧${pop}</span>` : ''}
      </div>
    `;
  }).join('');
}

/* ── Daily forecast ────────────────────────────────── */
async function fetchDailyForecast(cfg) {
  const grid = await resolveGridPoint(cfg);
  if (!grid) return;
  const data = await nwsFetch(`${NWS_BASE}/gridpoints/${grid.wfo}/${grid.x},${grid.y}/forecast/daily?units=si`);
  if (!data || !data.properties || !data.properties.periods) return;
  const periods = data.properties.periods.slice(0, 7);
  await fadeUpdate('daily', () => renderDailyStrip(periods));
}

function renderDailyStrip(periods) {
  const container = document.getElementById('daily-strip');
  if (!container) return;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  container.innerHTML = periods.map((p, i) => {
    const dayName = i === 0 ? 'Today' : days[new Date(p.startTime).getDay()];
    const iconUrl = p.icon || '';
    const pop = p.probabilityOfPrecipitation
      ? `${p.probabilityOfPrecipitation.value || p.probabilityOfPrecipitation}`
      : '';
    return `
      <div class="daily-card">
        <span class="daily-day">${dayName}</span>
        ${iconUrl ? `<img class="daily-icon" src="${iconUrl}" alt="${p.shortForecast || ''}" />` : ''}
        <span class="daily-desc" title="${p.shortForecast || ''}">${p.shortForecast || ''}</span>
        <span class="daily-temps">
          <span class="daily-high">${p.temperature}</span>
          /<span class="daily-low">${p.temperature ? Math.round(p.temperature - 8) : '—'}</span>
        </span>
        ${pop ? `<span class="daily-pop">💧${pop}</span>` : ''}
      </div>
    `;
  }).join('');
}

/* ── Radar ─────────────────────────────────────────── */
let radarMap = null;
let radarLayer = null;
let radarPlaying = true;
let radarFrames = [];
let radarFrameIndex = 0;
let radarAnimTimer = null;
let radarTileCache = {};

function initRadar(cfg) {
  radarMap = L.map('radar-map', {
    zoomControl: false,
    attributionControl: false,
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: false,
  }).setView([cfg.lat, cfg.lon], cfg.zoom);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
  }).addTo(radarMap);

  radarLayer = L.tileLayer.wms(
    'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi',
    {
      format: 'image/png',
      transparent: true,
      layers: 'nexrad-n0q-900913',
    }
  ).addTo(radarMap);

  buildRadarFrames();
  animateRadar();
}

function buildRadarFrames() {
  radarFrames = [];
  const now = new Date();
  for (let i = 24; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 5 * 60000);
    radarFrames.push(t.toISOString());
  }
}

function animateRadar() {
  if (!radarPlaying) return;
  showRadarFrame(radarFrameIndex);
  radarFrameIndex = (radarFrameIndex + 1) % radarFrames.length;
  radarAnimTimer = setTimeout(animateRadar, 700);
}

function showRadarFrame(index) {
  const ts = radarFrames[index];
  if (!ts) return;
  radarLayer.setParams({ time: ts.substring(0, 19).replace('T', ' ') });
  const tsEl = document.getElementById('radar-timestamp');
  if (tsEl) {
    tsEl.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
}

function toggleRadarPlay() {
  radarPlaying = !radarPlaying;
  const btn = document.getElementById('radar-play-btn');
  if (btn) btn.textContent = radarPlaying ? '⏸' : '▶';
  if (radarPlaying) animateRadar();
  else if (radarAnimTimer) clearTimeout(radarAnimTimer);
}

async function refreshRadarFrames() {
  buildRadarFrames();
  if (radarPlaying) {
    radarFrameIndex = 0;
    showRadarFrame(0);
  }
  updatePanelStatus('radar', true);
}

/* ── Header clock ──────────────────────────────────── */
function updateClock(cfg) {
  const now = new Date();
  const timeEl = document.getElementById('header-time');
  const locEl = document.getElementById('header-location');
  if (timeEl) {
    timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  if (locEl) {
    locEl.textContent = `${cfg.lat.toFixed(2)}°, ${cfg.lon.toFixed(2)}°`;
  }
}

/* ── Periodic refresh ──────────────────────────────── */
let refreshTimer = null;

function startRefresh(cfg) {
  const tick = async () => {
    await Promise.allSettled([
      fetchCurrentConditions(cfg),
      fetchHourlyForecast(cfg),
      fetchDailyForecast(cfg),
    ]);
  };

  tick();
  refreshTimer = setInterval(() => tick(), 15 * 60000);

  setInterval(() => refreshRadarFrames(), 5 * 60000);
}

/* ── Init ──────────────────────────────────────────── */
async function init() {
  applyUrlParams();

  let cfg = readLocationCookie();
  if (!cfg) {
    cfg = { ...DEFAULTS };
    writeLocationCookie(cfg);
  }

  const saved = localStorage.getItem('panelState');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      for (const k of Object.keys(panelState)) {
        if (parsed[k]) panelState[k] = { ...panelState[k], ...parsed[k] };
      }
    } catch (_) { /* ignore */ }
  }

  await openLogDb();
  pruneOldLogs();

  initRadar(cfg);
  updateClock(cfg);
  setInterval(() => updateClock(cfg), 1000);
  startRefresh(cfg);
}

document.addEventListener('DOMContentLoaded', init);
