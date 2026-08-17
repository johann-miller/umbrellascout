# Weather Dashboard — Spec

Fixed 1080p television display driven by a Raspberry Pi 3 B+, showing radar, current
conditions, and forecast continuously. Static frontend, no backend, no API keys.

## Stack
- **Frontend:** Static HTML/CSS/JS, no build step, no framework
- **Mapping:** Leaflet
- **Forecast/conditions:** National Weather Service API (api.weather.gov) — free, no key, US-only
- **Radar:** IEM NEXRAD WMS (mesonet.agron.iastate.edu, Iowa State University) — free, no key, CONUS-only, full ~500m resolution, time-enabled
- **Basemap:** CARTO Positron raster tiles
- **Serving on Pi:** nginx, localhost only
- **Display:** Chromium in kiosk mode under X11, auto-launched on boot via systemd

## Data Flow
1. Location (lat/lon, radar zoom/center) read from a browser cookie on load; falls back to a baked-in default if unset
2. Resolve NWS grid point from stored lat/lon once per session, cache the result
3. Poll NWS `/points/{lat,lon}` → `/gridpoints/{wfo}/{x},{y}/forecast?units=si` every ~15 min
4. Poll NWS hourly forecast for the 12-hour strip, including `probabilityOfPrecipitation`
5. Build radar frame timestamps at 5-minute intervals over the past 2 hours; request each frame from the IEM WMS-T endpoint and animate
6. All refresh loops are client-side

## NWS API Constraints
- Request SI units directly via `?units=si` on the forecast endpoint. No client-side unit conversion.
- **Do not set a custom `User-Agent` or any custom request header.** NWS documentation asks for a User-Agent, but browsers forbid setting it and the NWS CORS preflight rejects it — attempting to set it causes a hard fetch failure. Use plain `fetch()` with no headers. Low-volume anonymous browser access is acceptable per NWS maintainers.
- Unrecognized query parameters return HTTP 400. Do not append anything beyond documented params.
- Honor the returned `Cache-Control` / `Last-Modified` headers; do not use cache-busting query strings.
- `/points` responses are stable and should be cached rather than re-fetched each cycle.

## Units
- Temperature: Celsius, as returned with `units=si`
- Wind: km/h, as returned with `units=si`

## UI Layout (target: 1920×1080, 16:9)

Radar is a full-bleed background layer (`#radar-map { position: fixed; inset: 0; }`);
every other panel is a floating tile positioned over it with `position: fixed`,
so the animated radar reads through the open space around the tiles instead of
being boxed into a column.

```
┌───────────────────┐                          ┌─────────────────────┐
│ HEADER             │                          │                     │
└───────────────────┘                          │                     │
┌───────────┐                                  │  Current Conditions │
│ ● Live     │                                  │  (huge temp, feels  │
├───────────┤        (radar visible through)   │  like, wind, humid) │
│ attribution│                                  ├─────────────────────┤
└───────────┘                                  │  Next 12 Hours       │
┌──────────────────────────┐                    │  (scrollable list)  │
│ ⏸ − 1× + ▓▓▓▓▓░░░ 14:05  │                    │                     │
└──────────────────────────┘                    └─────────────────────┘
┌───────────────────────────────────────────────────────────────────┐
│  7-Day Forecast (flex row, 7 equal columns)                        │
└───────────────────────────────────────────────────────────────────┘
```

- Tiles: flat semi-transparent white (`rgba(255,255,255,0.86)`), rounded
  corners, `box-shadow` for lift. Deliberately **no `backdrop-filter: blur()`**
  — blur has to resample everything beneath it on every repaint, and the
  radar loop repaints every ~350ms; continuous blur recompute on a Pi 3B+'s
  GPU is not worth the risk. A flat alpha-blended fill reads nearly the same
  at TV viewing distance for a fraction of the render cost.
- Header: top, full width, floating tile with location + a large clock.
- Right column: `current-conditions` + `hourly-section` tiles stacked,
  fixed width, right-aligned, from below the header to above the daily tile.
- Daily forecast: bottom, full width, flex row of 7 equal-width day cards.
- Radar transport controls (play/pause, speed, progress, timestamp): a
  tile in the open lower-left area, above the daily tile.
- Radar status + attribution: stacked tiles in the open upper-left area.
- Font sizing via `clamp()`, pushed deliberately large (e.g. the current
  temperature reads at up to ~150px) so the display is legible from across
  a lobby, not just up close. Light theme for bright-room viewing.

## Attribution (required, not optional)
A persistent attribution line must be visible on the main display:
- Basemap: `© OpenStreetMap contributors © CARTO`
- Radar: credit to Iowa Environmental Mesonet, Iowa State University
Keep it small but legible. This is a licensing obligation of both tile sources.

## Radar Detail
- Source: IEM CONUS NEXRAD base reflectivity (N0Q), Web Mercator
  - Current: `https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi?`, layer `nexrad-n0q-900913`
  - Time-enabled (for the animated loop): `https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi?`
- The kiosk view is fixed (no pan/zoom in practice) and always Ohio, so the radar panel is drawn as a single non-tiled WMS `GetMap` image per frame — `format=image/png`, `transparent=true` — rather than a Leaflet tile grid. The `BBOX`/`WIDTH`/`HEIGHT` are computed once and reused for every frame; only `TIME` changes per request. This cuts each frame from several tile requests down to one HTTP request. Rendered via `L.imageOverlay(...)`, swapped with `setUrl()`, fetched/cached manually as blob URLs (`fetch()` → `URL.createObjectURL()`) since ImageOverlay has no built-in tile cache.
- The requested `BBOX` is capped to a fixed extent around the configured lat/lon (`RADAR_HALF_EXTENT_M` in `app.js`, ~245km true ground half-extent, ~490km box), independent of the admin-configurable display zoom. This is deliberate: the display zoom controls how the basemap looks, but the radar request should never balloon out to distant states just because zoom is wide — data outside the capped extent simply isn't requested, and that part of the panel shows plain basemap.
- Frame list is constructed client-side from 5-minute timestamps across the past 2 hours, not read from a JSON manifest
- Loop pauses/resumes with a visible play/pause indicator, and displays the timestamp of the frame currently shown
- Be a polite consumer: this is a university-run public service. Cache frames, don't re-request unchanged timestamps, and don't poll faster than the 5-minute data cadence.

## Predicted Radar — Not Implemented
Forecast/nowcast radar tiles are not available from any free, key-free, tile-ready source.
RainViewer discontinued nowcast radar on 1 January 2026 (and simultaneously capped max zoom
at 7, dropped all color schemes but Universal Blue, and imposed a 100 req/IP/min limit),
which is why RainViewer is not used in this design at all. HRRR model reflectivity exists but
requires server-side processing, which conflicts with the no-backend architecture.

Near-term precipitation inference is instead served by the NWS hourly
`probabilityOfPrecipitation` values in the 12-hour strip. Revisit if a suitable tile source appears.

## Refresh Cadence
- Radar frames refresh every ~5 min; forecast data every ~15 min; the radar loop animates continuously in between (~500ms–1s per frame)
- Problem: swapping frame data mid-animation causes a visible jump or flicker
- Fix: new frames are fetched and fully prepared in the background; the swap happens only at a loop boundary (start of a fresh cycle), never mid-play
- Same principle for the forecast/hourly panels: stage new data, then swap on a clean transition (e.g. fade) rather than an abrupt mid-render DOM replace

## Location Config
- Lat/lon and radar zoom/center stored in a browser cookie (e.g. `dashboard_location`), not hardcoded
- On first run (no cookie), falls back to a default baked into the app
- Settable via a form on `/admin`, or via URL query params (e.g. `?lat=...&lon=...`) that write the cookie on load
- Makes the same build redeployable to another Pi/TV without code changes
- **Requires a persistent Chromium profile.** `--user-data-dir` must point at persistent storage, not `/tmp`, or the cookie is lost on every nightly reboot.

## Raspberry Pi Setup (Pi 3 B+)

**Known risk:** the Pi 3 B+ has 1 GB RAM and Chromium is memory-hungry. Recent reports on
Raspberry Pi OS Trixie are mixed — some users run current Chromium fine on a 3 B+, others hit
a browser that won't render at all, particularly on 32-bit and under Wayland. The configuration
below (64-bit Lite + X11) is the one reported to be lightest and most reliable, at roughly
260 MB idle. Validate early; this is the highest-risk part of the build.

**OS / display server**
- Raspberry Pi OS Lite, **64-bit** (no desktop)
- **X11**, not Wayland: `xserver-xorg`, `xinit`, `openbox`, `unclutter`
- Wayland (labwc) is the fallback path only if X11 proves problematic. Note that Pi OS replaced Wayfire with labwc; `cage` still exists but is no longer the path Pi's own tooling assumes.

**Serving the app**
- nginx on port 8080, bound to localhost
- App files in `/var/www/dashboard`

**Kiosk launch**
- Package and binary are `chromium` on Bookworm/Trixie (`chromium-browser` is a legacy transitional name)
- Run as a dedicated unprivileged `kiosk` user
- systemd service `dashboard-kiosk.service`:
  ```
  After=nginx.service
  Requires=nginx.service
  ExecStart=/usr/bin/startx /usr/bin/chromium --kiosk --noerrdialogs --disable-infobars \
    --no-first-run --disable-session-crashed-bubble --disable-features=Translate \
    --user-data-dir=/home/kiosk/.chromium-profile --disk-cache-dir=/tmp/chromium-cache \
    http://localhost:8080
  Restart=always
  RestartSec=5
  ```
- Note the kiosk unit orders after nginx, not `network-online.target` — nginx serves localhost and needs no network, and the frontend's retry logic already handles the APIs being unreachable at boot.
- Screen blanking disabled: `xset s off`, `xset s noblank`, `xset -dpms`

**Stability / watchdog**
- systemd `Restart=always` recovers a crashed Chromium in ~5s
- The hardware watchdog is **already enabled by default** on current Pi OS — `/dev/watchdog` exists without editing `config.txt`. No `dtparam=watchdog=on` line is needed.
- The timeout does still need setting, and this is a known trap: on Trixie, editing `/etc/systemd/system.conf` has no effect because it is overridden by `/usr/lib/systemd/system.conf.d/40-rpi-enable-watchdog.conf`. Use a drop-in at `/etc/systemd/system.conf.d/`:
  ```
  [Manager]
  RuntimeWatchdogSec=15s
  RebootWatchdogSec=5min
  ```
  15s is the maximum the BCM hardware supports.
- Nightly cron reboot (e.g. 4am) to mitigate slow memory growth over long uptimes
- Boot config, if edited for any reason, lives at `/boot/firmware/config.txt` on Bookworm and later — **not** `/boot/config.txt`

**Networking**
- Wired Ethernet preferred over Wi-Fi if the mount location allows
- Static IP or DHCP reservation for remote access/debugging; SSH enabled

## Error Handling
- No fetch failure, parse error, or API outage may crash or freeze the render. All fetch calls wrapped in try/catch; failures degrade gracefully, never block the UI thread.
- On failure, each panel (radar, current conditions, hourly, 7-day) independently falls back to its last successfully cached value.
- A small, non-blocking indicator (corner icon or subtle banner, not a modal) shows per-panel status:
  - OK
  - Stale — showing cached data, with age (e.g. "12 min old")
  - Failed — with the HTTP status or error code (e.g. `NWS 503`, `IEM timeout`)
- Retry policy: exponential backoff (10s, 30s, 60s, capped at 5 min) per endpoint, independent of other panels
- Watch specifically for NWS 400 responses, which indicate a malformed query rather than an outage, and should not be retried blindly
- No alerts, sounds, or popups — failures are visual-only and low-urgency, consistent with a passive display

## Logging
- Client-side log of fetch attempts, failures, and recoveries in IndexedDB
- Each entry: timestamp, endpoint, status/error code, response time, retry count
- Retention: rolling 7-day window, pruned automatically on write, so storage stays bounded
- Implementation is a single logging function called from each fetch's catch/finally block, plus a startup routine that prunes entries older than the window
- IndexedDB persists across reboots given a persistent Chromium profile (see Location Config)

## Admin/Debug View
- Separate static route `/admin`, served by the same nginx instance
- No authentication — local network only, not exposed beyond the LAN
- Displays raw log entries: timestamp, endpoint, status/error code, response time, retry count
- Sortable/filterable by endpoint or status, most recent first
- Surfaces current in-memory state: last successful fetch per panel, current backoff state
- Includes the location config form (writes the cookie)
- Accessed at `http://<pi-ip>:8080/admin`

## Project Layout
Flat, no build step:
```
index.html
admin.html
style.css
app.js
admin.js
```
Version control: git, single repo.

## Documentation
A **Setup & Operations Manual** (Markdown) covering, from scratch:
- Flashing Raspberry Pi OS Lite 64-bit to SD card via Raspberry Pi Imager
- Initial config: hostname, SSH enable, locale/timezone, user creation
- Wi-Fi configuration (and Ethernet notes if wired)
- Installing and configuring nginx; deploying app files to `/var/www/dashboard`
- Installing X11 and Chromium kiosk dependencies; creating the `kiosk` user
- Creating and enabling systemd units, including ordering against nginx
- Disabling screen blanking
- Setting the watchdog timeout via systemd drop-in (noting the Trixie override trap)
- Configuring the nightly reboot cron
- Verifying end-to-end boot (power-on to live dashboard)
- Troubleshooting: blank screen, Chromium failing to render on 1 GB RAM, stale data, network loss, SD card corruption
- Update/redeploy procedure for future app changes

## Open Items
- Forecast radar source, should a free tile-ready option become available
- Validate Chromium behavior on the 3 B+ early — fallback is a lighter browser or a lower render resolution
- 3D case (owner's own scope)