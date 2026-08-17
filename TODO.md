# TODO

## Bugs

- [ ] **Current conditions stuck on "Loading…"**
  `resolveGridPoint()` (app.js) stores the observation-stations URL on
  `cachedGrid.stationUrl` but never assigns the module-level
  `cachedStationUrl` variable that `fetchCurrentConditions()` actually
  reads — that variable is only set by `loadCachedGrid()` when restoring
  from localStorage. On the first run at any location (no cache yet),
  `fetchCurrentConditions` reads `null`, bails silently, and
  `renderCurrentConditions()` never runs, so the panel never leaves its
  initial "Loading…" markup.

- [ ] **`[object Object]` shown for 0% precipitation chance**
  In `renderHourlyStrip()` and `renderDailyStrip()` (app.js), both use
  `p.probabilityOfPrecipitation.value || p.probabilityOfPrecipitation`.
  NWS returns `probabilityOfPrecipitation` as `{unitCode, value}`; when
  `value` is `0` (most hours), `0` is falsy, so the `||` falls through to
  stringifying the whole object.

- [ ] **Admin panel state always shows "unknown"/"never"**
  `renderPanelState()` (admin.js) reads `localStorage.getItem('panel_' + p)`
  per panel, but `app.js` never writes those keys — `updatePanelStatus()`
  (app.js) writes the whole state object to a single `'panelState'` key
  instead. The admin `/admin` state cards are permanently stale/empty as a
  result.

## UI

- [ ] **Replace default NWS icon URLs with custom SVGs.** Hourly and daily
  cards currently render `<img src="{p.icon}">` pointing at
  `api.weather.gov/icons/...`. Wants a custom SVG icon set instead —
  needs an icon mapping from NWS's `shortForecast`/icon condition codes
  to the custom set.
