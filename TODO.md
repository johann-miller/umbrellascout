# TODO

## Bugs

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
