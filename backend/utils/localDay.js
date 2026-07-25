/**
 * Local-time day helpers for continuous recordings.
 *
 * These exist because ffmpeg's `-strftime` names segment files in **local** time,
 * so anything that turns a filename back into a Date, or groups footage by day,
 * must work in local time too.
 *
 * Note the rest of this codebase uses the opposite convention: watcher.js derives
 * its clip day key from `new Date().toISOString().slice(0, 10)`, which is a UTC
 * day and therefore rolls over at 07:00 local at UTC+7. Do not reuse that idiom
 * here — footage would be filed under the wrong day for the first 7 hours.
 *
 * Vietnam has no DST, so the ambiguous/skipped local hour cannot occur here; on a
 * DST-observing host a repeated local hour would produce two segments that parse
 * to the same instant.
 */

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' for the LOCAL day containing `date`. */
function localDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight..next local midnight for a 'YYYY-MM-DD' key. */
function localDayRange(dayKey) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  // Component constructor is local-time; `new Date('YYYY-MM-DD')` would be UTC.
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { start, end };
}

/**
 * Turn a segment filename written by `-strftime 1` with the pattern
 * "%Y-%m-%d_%H%M%S.mp4" back into the local Date it represents.
 * Accepts a bare name or any path ending in one. Returns null if it doesn't match.
 */
function parseSegmentFilename(nameOrPath) {
  const base = String(nameOrPath).split(/[\\/]/).pop() || '';
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})\.mp4$/);
  if (!m) return null;
  const [, y, mo, d, H, M, S] = m.map(Number);
  return new Date(y, mo - 1, d, H, M, S, 0);
}

/** Build the strftime pattern used for segment filenames. */
const SEGMENT_PATTERN = '%Y-%m-%d_%H%M%S.mp4';

module.exports = { localDayKey, localDayRange, parseSegmentFilename, SEGMENT_PATTERN };
