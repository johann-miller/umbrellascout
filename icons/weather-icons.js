/* ═══════════════════════════════════════════════════════
   Weather Dashboard — icons/weather-icons.js
   Maps NWS forecast data to one of this project's weather icon files
   (icons/*.svg — clear-day.svg, rain-heavy.svg, etc.). The icons
   themselves are plain standalone SVG files, referenced directly via
   <img src>; this module only decides *which* file applies.
   ═══════════════════════════════════════════════════════ */

/* Maps NWS's condition vocabulary (from the `icon` URL's condition
   segment, e.g. "tsra" in ".../icons/land/day/tsra,40") down to this
   set's dozen icon files. NWS has ~30 codes; anything not listed here
   falls back to 'cloudy' rather than throwing. */
const NWS_ICON_CODE_MAP = {
  skc: 'clear', hot: 'clear',
  few: 'partly-cloudy', sct: 'partly-cloudy',
  bkn: 'cloudy', ovc: 'cloudy', cold: 'cloudy',
  fog: 'fog', haze: 'fog', smoke: 'fog', dust: 'fog',
  rain_showers: 'rain-light', rain_showers_hi: 'rain-light',
  rain: 'rain-heavy',
  tsra: 'thunderstorm', tsra_sct: 'thunderstorm', tsra_hi: 'thunderstorm',
  tornado: 'thunderstorm', hurricane: 'thunderstorm', tropical_storm: 'thunderstorm',
  snow: 'snow', blizzard: 'snow',
  rain_snow: 'wintry-mix', rain_sleet: 'wintry-mix', snow_sleet: 'wintry-mix',
  sleet: 'wintry-mix', fzra: 'wintry-mix', rain_fzra: 'wintry-mix', snow_fzra: 'wintry-mix',
  wind_skc: 'windy', wind_few: 'windy', wind_sct: 'windy', wind_bkn: 'windy', wind_ovc: 'windy',
};

/* NWS icon URLs look like .../icons/land/{day|night}/{condition}[,pct]
   — day/night and the dominant condition are both read directly from
   the URL, so callers don't need to track isDaytime separately. */
function nwsIconKey(iconUrl) {
  if (!iconUrl) return 'cloudy';
  try {
    const segments = new URL(iconUrl).pathname.split('/').filter(Boolean);
    const dayNight = segments[segments.length - 2] === 'night' ? 'night' : 'day';
    const condition = (segments[segments.length - 1] || '').split(',')[0];
    const bucket = NWS_ICON_CODE_MAP[condition] || 'cloudy';
    return (bucket === 'clear' || bucket === 'partly-cloudy') ? `${bucket}-${dayNight}` : bucket;
  } catch (_) {
    return 'cloudy';
  }
}

function weatherIconUrl(iconUrl) {
  return `icons/${nwsIconKey(iconUrl)}.svg`;
}
