/**
 * Local-day helpers for the playback timeline.
 *
 * Mirrors backend/utils/localDay.js: recordings are named and grouped by LOCAL
 * day, so the date picker must produce the same key the API expects.
 * `toISOString().slice(0,10)` would give the UTC day and shows the wrong date
 * for the first hours of the evening at UTC+7.
 */

const pad = (n) => String(n).padStart(2, '0');

export function localDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
