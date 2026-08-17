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
const BACKOFF_DELAYS = [0, 10000, 30000, 60000];
const BACKOFF_MAX = 300000;

function backoffDelay(retryCount) {
  return Math.min(BACKOFF_DELAYS[retryCount] ?? BACKOFF_MAX, BACKOFF_MAX);
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
let cachedStationUrl = null;
let cachedGridKey = '';

function gridKey(cfg) {
  return `${cfg.lat.toFixed(4)},${cfg.lon.toFixed(4)}`;
}

function loadCachedGrid(cfg) {
  try {
    const raw = localStorage.getItem('cachedGrid');
    const key = cfg ? gridKey(cfg) : '';
    if (raw && key) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.wfo && parsed.x != null && parsed.y != null && parsed.key === key) {
        cachedGrid = parsed;
        cachedStationUrl = parsed.stationUrl || null;
        cachedGridKey = key;
        return;
      }
    }
  } catch (_) { /* ignore */ }
  cachedGrid = null;
  cachedStationUrl = null;
  cachedGridKey = '';
}

function saveCachedGrid(cfg) {
  if (!cachedGrid) return;
  cachedGrid.key = gridKey(cfg);
  localStorage.setItem('cachedGrid', JSON.stringify(cachedGrid));
}

async function resolveGridPoint(cfg) {
  const key = gridKey(cfg);
  if (cachedGrid && cachedGridKey === key) return cachedGrid;
  const data = await nwsFetch(`${NWS_BASE}/points/${cfg.lat},${cfg.lon}`);
  if (data && data.properties) {
    const grid = data.properties;
    cachedGrid = { wfo: grid.gridId, x: grid.gridX, y: grid.gridY, stationUrl: grid.observationStations };
    saveCachedGrid(cfg);
    const updated = { ...cfg, wfo: cachedGrid.wfo, x: cachedGrid.x, y: cachedGrid.y };
    writeLocationCookie(updated);
    return cachedGrid;
  }
  return null;
}

/* ── Current conditions (via observations) ──────────── */
async function fetchCurrentConditions(cfg) {
  await resolveGridPoint(cfg);
  const stationsUrl = cachedStationUrl;
  if (!stationsUrl) return;
  const stations = await nwsFetch(stationsUrl);
  if (!stations || !stations.features?.length) return;
  const stationId = stations.features[0].id.split('/').pop();
  const obs = await nwsFetch(`${NWS_BASE}/stations/${stationId}/observations/latest`);
  if (!obs || !obs.features?.length) return;
  await fadeUpdate('current', () => renderCurrentConditions(obs.features[0].properties));
}

function renderCurrentConditions(props) {
  const el = document.getElementById('current-conditions');
  if (!el) return;
  const temp = props.temperature?.value ?? '—';
  const dewpoint = props.dewpoint?.value ?? '—';
  const humidity = props.relativeHumidity?.value ?? '—';
  const windString = props.windDirection?.value || '—';
  const windSpeed = props.windSpeed?.value ?? '—';
  const conditions = props.textDescription || '—';

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
  const data = await nwsFetch(`${NWS_BASE}/gridpoints/${grid.wfo}/${grid.x},${grid.y}/forecast/hourly?units=si`);
  if (!data || !data.properties || !data.properties.periods) return;
  const periods = data.properties.periods.slice(0, 12);
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
  const data = await nwsFetch(`${NWS_BASE}/gridpoints/${grid.wfo}/${grid.x},${grid.y}/forecast?units=si`);
  if (!data || !data.properties || !data.properties.periods) return;
  const periods = data.properties.periods.filter(p => p.isDaytime).slice(0, 7);
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
let radarLayerA = null;
let radarLayerB = null;
let radarActiveLayer = null; // whichever of A/B is currently opacity:1
let radarTransitioning = false;
let radarPlaying = true;
let radarFrames = [];
let radarFrameIndex = 0;
let radarAnimTimer = null;
const RADAR_SPEED_STEPS = [0.25, 0.5, 1, 2, 4, 8];
let radarSpeedIndex = RADAR_SPEED_STEPS.indexOf(1);
let radarSpeedMultiplier = RADAR_SPEED_STEPS[radarSpeedIndex];
let radarBBox = null; // fixed EPSG:3857 bbox + pixel size, capped around the configured location; computed once
const RADAR_FRAME_MS = 350;
const RADAR_OVERLAP_MS = 50; // how long incoming/outgoing frames stay stacked before outgoing is hidden
const WMS_TIME_URL = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi';

/* Requests are capped to a fixed extent around the configured location,
   independent of whatever zoom the admin display happens to use — this
   deployment only ever needs Ohio and its immediate neighbors, so there's
   no reason to request (or show) radar data hundreds of km further out
   just because the basemap's zoom is wide enough to include it. */
const RADAR_HALF_EXTENT_M = 320000; // ~245km true ground half-extent at Ohio's latitude → ~490km box
const RADAR_IMAGE_PX = 1024; // fixed request resolution for that fixed extent (~625m/px, near NEXRAD's native ~500m)

/* Maps frame timestamp → object URL of the fetched blob. IEM sends no
   Cache-Control on WMS responses, so without this the animation loop
   would re-request every frame from the network on every loop pass.

   This display never pans or zooms (fixed kiosk view, always Ohio), so
   rather than a Leaflet tile grid recomputed per frame, the whole panel
   is requested as a single non-tiled GetMap image per frame — one HTTP
   request per frame instead of several tile requests. */
let radarFrameCache = new Map();

function computeRadarBBox(cfg) {
  const center = L.CRS.EPSG3857.project(L.latLng(cfg.lat, cfg.lon));
  radarBBox = {
    xmin: center.x - RADAR_HALF_EXTENT_M,
    ymin: center.y - RADAR_HALF_EXTENT_M,
    xmax: center.x + RADAR_HALF_EXTENT_M,
    ymax: center.y + RADAR_HALF_EXTENT_M,
    widthPx: RADAR_IMAGE_PX,
    heightPx: RADAR_IMAGE_PX,
  };
}

function radarFrameUrl(ts) {
  const b = radarBBox;
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.1.1', // 1.3.0 flips BBOX axis order for some CRSes; 1.1.1 keeps plain x,y
    REQUEST: 'GetMap',
    LAYERS: 'nexrad-n0q-wmst',
    SRS: 'EPSG:3857',
    BBOX: `${b.xmin},${b.ymin},${b.xmax},${b.ymax}`,
    WIDTH: String(Math.round(b.widthPx)),
    HEIGHT: String(Math.round(b.heightPx)),
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
    TIME: ts,
  });
  return `${WMS_TIME_URL}?${params}`;
}

function fetchRadarFrameBlob(ts) {
  const cached = radarFrameCache.get(ts);
  if (cached) return Promise.resolve(cached);
  // A stalled (not refused) connection never resolves fetch() on its own;
  // without a timeout that would leave a frame "loading" forever and
  // permanently wedge the overlap-cut swap that waits on it.
  return fetch(radarFrameUrl(ts), { signal: AbortSignal.timeout(10000) })
    .then(res => {
      if (!res.ok) throw new Error(`radar frame ${res.status}`);
      return res.blob();
    })
    .then(blob => {
      const objUrl = URL.createObjectURL(blob);
      radarFrameCache.set(ts, objUrl);
      return objUrl;
    });
}

function initRadar(cfg) {
  radarMap = L.map('radar-map', {
    zoomControl: false,
    attributionControl: false,
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: false,
    fadeAnimation: false,
  }).setView([cfg.lat, cfg.lon], cfg.zoom);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
  }).addTo(radarMap);

  // Bbox is computed once, capped to a fixed extent around the configured
  // location (not the panel's view/zoom — see RADAR_HALF_EXTENT_M above),
  // and reused for every frame. Unproject it back to lat/lon so the image
  // overlay is geo-referenced to the same fixed area it was requested for;
  // any part of the panel outside that area just shows plain basemap.
  computeRadarBBox(cfg);
  const bounds = L.latLngBounds(
    L.CRS.EPSG3857.unproject(L.point(radarBBox.xmin, radarBBox.ymin)),
    L.CRS.EPSG3857.unproject(L.point(radarBBox.xmax, radarBBox.ymax))
  );

  // Two overlapping image overlays, both covering the same fixed bounds:
  // the incoming frame loads fully hidden (opacity 0) on top of the visible
  // one. Once loaded it's revealed instantly and held stacked over the
  // outgoing frame briefly before the outgoing one is hidden, so there's
  // never a gap with neither painted.
  radarLayerA = L.imageOverlay('', bounds, { opacity: 1, interactive: false }).addTo(radarMap);
  radarLayerB = L.imageOverlay('', bounds, { opacity: 0, interactive: false }).addTo(radarMap);
  radarActiveLayer = radarLayerA;

  buildRadarFrames();
  startRadarLoop();

  radarMap.on('click', handleAdminMapClick);
  loadAdminPins();
  renderAdminPinsOnMap();
}

function buildRadarFrames() {
  radarFrames = [];
  const FIVE_MIN = 5 * 60000;
  // IEM's WMS-T time dimension has nearestValue="0" — it requires an exact
  // match against its 5-minute data grid rather than snapping, so frame
  // timestamps must be floored to that grid or every request comes back blank.
  const alignedNow = Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN;
  for (let i = 24; i >= 0; i--) {
    radarFrames.push(new Date(alignedNow - i * FIVE_MIN).toISOString());
  }
  pruneRadarFrameCache();
}

function pruneRadarFrameCache() {
  const valid = new Set(radarFrames);
  for (const [ts, objUrl] of radarFrameCache) {
    if (!valid.has(ts)) {
      URL.revokeObjectURL(objUrl);
      radarFrameCache.delete(ts);
    }
  }
}

function animateRadar() {
  if (!radarPlaying) return;
  showRadarFrame(radarFrameIndex);
  radarFrameIndex = (radarFrameIndex + 1) % radarFrames.length;
  radarAnimTimer = setTimeout(animateRadar, RADAR_FRAME_MS / radarSpeedMultiplier);
}

// Shows the most recent frame immediately, then starts the oldest→newest
// loop only once that frame's tiles have finished loading — so the display
// never sits on a blank map waiting to climb through 2 hours of history.
function startRadarLoop() {
  if (radarAnimTimer) {
    clearTimeout(radarAnimTimer);
    radarAnimTimer = null;
  }
  radarTransitioning = false;
  showRadarFrame(radarFrames.length - 1, () => {
    radarFrameIndex = 0;
    if (radarPlaying) animateRadar();
  });
}

let lastRadarTimestamp = null;

function showRadarFrame(index, onReady) {
  const ts = radarFrames[index];
  if (!ts || ts === lastRadarTimestamp || radarTransitioning) {
    onReady?.();
    return;
  }
  radarTransitioning = true;
  lastRadarTimestamp = ts;

  const incoming = radarActiveLayer === radarLayerA ? radarLayerB : radarLayerA;
  const outgoing = radarActiveLayer;

  incoming.off('load');
  incoming.off('error');
  incoming.once('error', () => {
    // Leave the incoming layer hidden and keep showing the outgoing
    // (last-good) frame — per SPEC.md, a failure falls back to the last
    // successfully cached value rather than replacing it with a blank one.
    radarTransitioning = false;
    updatePanelStatus('radar', false, 'IEM frame error');
    onReady?.();
  });
  incoming.once('load', () => {
    // Reveal the fully-painted incoming frame instantly, on top of the
    // still-visible outgoing one, then hold both stacked briefly before
    // dropping the outgoing frame — no opacity animation on either edge,
    // just a short overlap so there's never a gap with neither painted.
    incoming.setOpacity(1);
    radarActiveLayer = incoming;
    updatePanelStatus('radar', true);
    const tsEl = document.getElementById('radar-timestamp');
    if (tsEl) {
      tsEl.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    const progressEl = document.getElementById('radar-progress-fill');
    if (progressEl) {
      const pct = radarFrames.length > 1 ? (index / (radarFrames.length - 1)) * 100 : 100;
      progressEl.style.width = `${pct}%`;
    }
    setTimeout(() => {
      outgoing.setOpacity(0);
      radarTransitioning = false;
      onReady?.();
    }, RADAR_OVERLAP_MS);
  });

  fetchRadarFrameBlob(ts)
    .then(objUrl => incoming.setUrl(objUrl))
    .catch(err => {
      incoming.off('load');
      incoming.off('error');
      radarTransitioning = false;
      updatePanelStatus('radar', false, err.message || 'IEM frame error');
      onReady?.();
    });
}

function toggleRadarPlay() {
  radarPlaying = !radarPlaying;
  const btn = document.getElementById('radar-play-btn');
  if (btn) btn.textContent = radarPlaying ? '⏸' : '▶';
  if (radarPlaying) animateRadar();
  else if (radarAnimTimer) clearTimeout(radarAnimTimer);
}

function adjustRadarSpeed(direction) {
  radarSpeedIndex = Math.min(RADAR_SPEED_STEPS.length - 1, Math.max(0, radarSpeedIndex + direction));
  radarSpeedMultiplier = RADAR_SPEED_STEPS[radarSpeedIndex];
  const readout = document.getElementById('radar-speed-readout');
  if (readout) readout.textContent = `${radarSpeedMultiplier}×`;
  // Reschedule the pending tick at the new speed rather than waiting out
  // the old interval, so the change feels immediate.
  if (radarPlaying && radarAnimTimer) {
    clearTimeout(radarAnimTimer);
    radarAnimTimer = setTimeout(animateRadar, RADAR_FRAME_MS / radarSpeedMultiplier);
  }
}

async function refreshRadarFrames() {
  buildRadarFrames();
  if (radarPlaying) startRadarLoop();
}

/* ── Admin drawer (hidden; toggled by the "H" key) ─────
   No visible affordance anywhere in the normal UI points at this — see
   the keydown listener in init(). Pins are the one part of this that's
   public-facing: once placed they render on the live map for everyone,
   only the *management* UI is hidden. */
const ADMIN_PINS_KEY = 'adminPins';
let adminDrawerOpen = false;
let adminPinMode = false;
let adminPins = [];
let adminPinMarkers = [];

function loadAdminPins() {
  try {
    const raw = localStorage.getItem(ADMIN_PINS_KEY);
    adminPins = raw ? JSON.parse(raw) : [];
  } catch (_) {
    adminPins = [];
  }
}

function saveAdminPins() {
  localStorage.setItem(ADMIN_PINS_KEY, JSON.stringify(adminPins));
}

function renderAdminPinsOnMap() {
  adminPinMarkers.forEach(m => radarMap.removeLayer(m));
  adminPinMarkers = adminPins.map(pin => {
    const marker = L.marker([pin.lat, pin.lon], {
      icon: L.divIcon({ className: 'admin-pin-icon', iconSize: [14, 14] }),
      interactive: false,
    }).addTo(radarMap);
    if (pin.label) {
      marker.bindTooltip(pin.label, {
        permanent: true,
        direction: 'right',
        offset: [10, 0],
        className: 'admin-pin-label',
      }).openTooltip();
    }
    return marker;
  });
}

function renderAdminPinList() {
  const listEl = document.getElementById('admin-pin-list');
  if (!listEl) return;
  listEl.innerHTML = adminPins.map((pin, i) => `
    <div class="admin-pin-row">
      <span>${pin.label ? pin.label : `${pin.lat.toFixed(4)}, ${pin.lon.toFixed(4)}`}</span>
      <button onclick="removeAdminPin(${i})">×</button>
    </div>
  `).join('');
}

function removeAdminPin(index) {
  adminPins.splice(index, 1);
  saveAdminPins();
  renderAdminPinsOnMap();
  renderAdminPinList();
}

function setAdminPinMode(active) {
  adminPinMode = active;
  const btn = document.getElementById('admin-pin-toggle-btn');
  const hint = document.getElementById('admin-pin-hint');
  if (btn) btn.classList.toggle('active', adminPinMode);
  if (hint) hint.hidden = !adminPinMode;
}

function toggleAdminPinMode() {
  setAdminPinMode(!adminPinMode);
}

function handleAdminMapClick(e) {
  if (!adminPinMode) return;
  const label = (window.prompt('Label for this pin (optional):', '') || '').trim();
  adminPins.push({ lat: e.latlng.lat, lon: e.latlng.lng, label });
  saveAdminPins();
  renderAdminPinsOnMap();
  renderAdminPinList();
  setAdminPinMode(false);
}

function openAdminDrawer() {
  adminDrawerOpen = true;
  const el = document.getElementById('admin-drawer');
  if (el) el.hidden = false;

  const cfg = readLocationCookie() || { ...DEFAULTS };
  const latEl = document.getElementById('admin-cfg-lat');
  const lonEl = document.getElementById('admin-cfg-lon');
  const zoomEl = document.getElementById('admin-cfg-zoom');
  if (latEl) latEl.value = cfg.lat;
  if (lonEl) lonEl.value = cfg.lon;
  if (zoomEl) zoomEl.value = cfg.zoom;

  renderAdminPinList();
}

function closeAdminDrawer() {
  adminDrawerOpen = false;
  const el = document.getElementById('admin-drawer');
  if (el) el.hidden = true;
  setAdminPinMode(false);
}

function toggleAdminDrawer() {
  if (adminDrawerOpen) closeAdminDrawer();
  else openAdminDrawer();
}

function saveAdminLocation() {
  const cfg = readLocationCookie() || { ...DEFAULTS };
  cfg.lat = parseFloat(document.getElementById('admin-cfg-lat').value);
  cfg.lon = parseFloat(document.getElementById('admin-cfg-lon').value);
  cfg.zoom = parseInt(document.getElementById('admin-cfg-zoom').value, 10) || 8;
  cfg.wfo = null;
  cfg.x = null;
  cfg.y = null;
  writeLocationCookie(cfg);
  window.location.reload();
}

function handleAdminKeydown(e) {
  const activeTag = document.activeElement?.tagName;
  const typing = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

  if (e.key === 'Escape' && adminDrawerOpen) {
    closeAdminDrawer();
    return;
  }
  if (typing) return;
  if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    toggleAdminDrawer();
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

  loadCachedGrid(cfg);

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
  startRefresh(cfg);
  document.addEventListener('keydown', handleAdminKeydown);
}

document.addEventListener('DOMContentLoaded', init);
