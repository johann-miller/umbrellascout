# TODO

## Bugs

- [ ] **Admin panel state always shows "unknown"/"never"**
  `renderPanelState()` (admin.js) reads `localStorage.getItem('panel_' + p)`
  per panel, but `app.js` never writes those keys — `updatePanelStatus()`
  (app.js) writes the whole state object to a single `'panelState'` key
  instead. The admin `/admin` state cards are permanently stale/empty as a
  result.

