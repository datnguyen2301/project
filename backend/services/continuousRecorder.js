/**
 * Continuous ("24/7") recording, per camera, feeding the Playback timeline.
 *
 * Deliberately does NOT tee off the live HLS pipeline: live streaming is started
 * and stopped from the Cameras page at the user's whim, and stream.cleanupStream()
 * deletes the whole streams/<cameraId> directory on stop, which would take the
 * recordings with it. The recorder owns its own ffmpeg writing under uploads/.
 *
 * Three source types, dispatched on the same discriminator the rest of the app
 * uses (utils/cameraAddress):
 *   - mjpeg       IP Webcam (Android) — MJPEG over HTTP at <base>/video
 *   - rtsp        a real RTSP camera reachable on the LAN
 *   - ezviz-cloud EZVIZ serial — shares the reference-counted helper in
 *                 ezvizCloudStream so only one le-ezviz-vs runs per device
 *
 * Output is 5-minute plain-MP4 segments named in LOCAL time, indexed into the
 * Recording collection by tailing ffmpeg's own segment-list CSV.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const Camera = require('../models/Camera');
const Recording = require('../models/Recording');
const ezviz = require('./ezviz');
const ezvizCloud = require('./ezvizCloudStream');
const stream = require('./stream');
const { isIpWebcamAddress, isEzvizSerialAddress } = require('../utils/cameraAddress');
const { localDayKey, parseSegmentFilename, SEGMENT_PATTERN } = require('../utils/localDay');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const RECORDINGS_DIR = path.join(UPLOADS_DIR, 'recordings');

const SEGMENT_SEC = parseInt(process.env.RECORD_SEGMENT_SEC || '300', 10);
const HEIGHT = process.env.RECORD_HEIGHT || '480';
const BITRATE = process.env.RECORD_BITRATE || '600k';
const ENCODER = process.env.RECORD_ENCODER || 'libx264';

// Backoff never gives up while autoRecord is true: a camera offline for an hour
// must not permanently disable its recording (unlike a user-initiated live view,
// which ezvizCloudStream retires after MAX_RESTARTS).
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const STABLE_RESET_MS = 120_000;
const INDEX_INTERVAL_MS = 10_000;

const CSV_NAME = 'segments.csv';

/**
 * cameraId -> { cameraId, serial, source, runId, runDir, proc, stopping,
 *               restarts, backoffMs, startedAt, lastStartAt, restartTimer,
 *               lastSegmentAt }
 */
const active = new Map();
let indexTimer = null;

function ffmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function isConfigured() {
  return Boolean(ffmpegPath());
}

/** POSIX-relative path used both as the DB key and the URL under /uploads. */
function toPosixRel(absPath) {
  return path.relative(UPLOADS_DIR, absPath).split(path.sep).join('/');
}

function newRunId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

// ── source resolution ─────────────────────────────────────────────────────────

/** Input-side ffmpeg args for a camera, or null when the EZVIZ helper feeds us. */
async function resolveSource(camera) {
  const addr = String(camera.ipAddress || '').trim();

  // IP Webcam must be detected FIRST. Its rtspHost is set to the same host:8080,
  // which is an HTTP endpoint, not RTSP — trying rtsp://host:554 would just fail.
  if (isIpWebcamAddress(addr)) {
    const base = addr.startsWith('http') ? addr.replace(/\/$/, '') : `http://${addr}`;
    return {
      source: 'mjpeg',
      inputArgs: [
        // MJPEG-over-HTTP carries no timestamps; without this, stream time drifts
        // from wall time and every timeline seek lands in the wrong place.
        '-use_wallclock_as_timestamps', '1',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-f', 'mjpeg',
        '-i', `${base}/video`,
      ],
    };
  }

  if (!isEzvizSerialAddress(addr)) {
    throw new Error(`unrecognised camera address "${addr}"`);
  }

  // A real LAN RTSP path, but only if the configured host actually answers — a
  // stale rtspHost from another network must not block the cloud path.
  if (camera.rtspHost) {
    const [host, port] = String(camera.rtspHost).split(':');
    const reachable = await stream.checkTcpReachable(host, Number(port || 554), 2000).catch(() => false);
    if (reachable) {
      let info = { localIp: host, rtspPort: port || '554', camKey: camera.verifyCode || '' };
      const candidates = stream.buildRtspUrlCandidates(info);
      if (candidates.length) {
        return {
          source: 'rtsp',
          inputArgs: [
            '-rtsp_transport', 'tcp',
            '-timeout', '10000000',
            '-fflags', '+genpts+discardcorrupt',
            '-i', candidates[0].url,
          ],
        };
      }
    }
  }

  if (!ezvizCloud.isConfigured()) {
    throw new Error(`no reachable source for EZVIZ camera ${addr} (cloud helper not configured)`);
  }
  return { source: 'ezviz-cloud', inputArgs: null, serial: addr };
}

// ── ffmpeg output args (identical for every source) ───────────────────────────

function outputArgs() {
  return [
    '-c:v', ENCODER,
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-vf', `scale=-2:${HEIGHT}`,
    '-b:v', BITRATE, '-maxrate', BITRATE, '-bufsize', String(parseInt(BITRATE, 10) * 2) + 'k',
    '-g', '60',
    '-an',
    '-f', 'segment',
    '-segment_time', String(SEGMENT_SEC),
    // Cut on wall-clock multiples so segments line up with the timeline.
    '-segment_atclocktime', '1',
    // Mandatory: without it each segment's PTS continues from stream start, so
    // video.currentTime for a later segment starts at thousands of seconds and
    // every offset computation in the player is wrong.
    '-reset_timestamps', '1',
    '-strftime', '1',
    '-segment_format', 'mp4',
    // moov at the head so the browser can seek without first fetching the tail.
    '-segment_format_options', 'movflags=+faststart',
    '-segment_list', CSV_NAME,
    '-segment_list_type', 'csv',
    '-segment_list_flags', '+live',
    SEGMENT_PATTERN,
  ];
}

/**
 * Each ffmpeg run writes into its own directory. Segment filenames only carry
 * second resolution, so a restart landing in the same second as the previous
 * run's last segment would otherwise silently overwrite it (and leave the DB row
 * pointing at different content).
 */
function newRunDir(cameraId) {
  const runId = newRunId();
  const runDir = path.join(RECORDINGS_DIR, String(cameraId), runId);
  fs.mkdirSync(runDir, { recursive: true });
  return { runId, runDir };
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

function spawnFfmpeg(state, inputArgs) {
  const { runId, runDir } = newRunDir(state.cameraId);
  state.runId = runId;
  state.runDir = runDir;

  const args = ['-v', 'warning', ...inputArgs, ...outputArgs()];
  // stdin is a pipe so stop() can write 'q' for a graceful finalise — a killed
  // ffmpeg leaves the in-progress segment without a moov, i.e. unplayable.
  const proc = spawn(ffmpegPath(), args, { cwd: runDir, stdio: ['pipe', 'ignore', 'pipe'] });

  let err = '';
  proc.stderr.on('data', (c) => { err = (err + c.toString()).slice(-2000); });
  proc.stdin.on('error', () => {});

  proc.on('close', (code) => {
    const cur = active.get(state.cameraId);
    if (!cur || cur.stopping || cur.proc !== proc) return;
    console.warn(`[recorder] ffmpeg exited (code ${code}) for ${cur.cameraId}${err ? `: ${err.slice(-300)}` : ''}`);
    scheduleRestart(cur);
  });

  state.proc = proc;
  state.lastStartAt = Date.now();
  return proc;
}

function scheduleRestart(state) {
  if (state.stopping) return;

  // Only escalate for restarts that cluster: a recorder that ran fine for
  // minutes before dropping should retry promptly, not at the capped delay.
  if (state.lastStartAt && Date.now() - state.lastStartAt > STABLE_RESET_MS) {
    state.backoffMs = BACKOFF_START_MS;
  }
  const delay = state.backoffMs;
  state.backoffMs = Math.min(state.backoffMs * 2, BACKOFF_MAX_MS);
  state.restarts += 1;
  console.log(`[recorder] ${state.cameraId} retrying in ${Math.round(delay / 1000)}s (restart #${state.restarts})`);

  state.restartTimer = setTimeout(async () => {
    const cur = active.get(state.cameraId);
    if (!cur || cur.stopping) return;
    try {
      const camera = await Camera.findById(cur.cameraId);
      if (!camera || !camera.autoRecord) { stop(cur.cameraId); return; }
      const resolved = await resolveSource(camera);
      cur.source = resolved.source;
      if (resolved.source === 'ezviz-cloud') {
        attachEzviz(cur, resolved.serial);
      } else {
        spawnFfmpeg(cur, resolved.inputArgs);
      }
    } catch (e) {
      console.warn(`[recorder] ${state.cameraId} restart failed: ${e.message}`);
      scheduleRestart(cur);
    }
  }, delay);
}

/** EZVIZ shares one helper per device; we attach as a second consumer. */
function attachEzviz(state, serial) {
  ezvizCloud.attachConsumer(state.cameraId, serial, {
    id: 'record',
    ownsDir: false,
    // Called fresh on every (re)spawn so each run gets its own directory.
    makeSpec: () => {
      const { runId, runDir } = newRunDir(state.cameraId);
      state.runId = runId;
      state.runDir = runDir;
      state.lastStartAt = Date.now();
      return {
        cwd: runDir,
        args: [
          '-v', 'warning',
          '-use_wallclock_as_timestamps', '1',
          '-f', 'hevc',
          '-i', 'pipe:0',
          ...outputArgs(),
        ],
      };
    },
  });
}

async function start(cameraId) {
  const id = String(cameraId);
  if (active.has(id)) return { already: true };

  const camera = await Camera.findById(id);
  if (!camera) throw new Error('camera not found');

  const resolved = await resolveSource(camera);

  const state = {
    cameraId: id,
    serial: resolved.serial || null,
    source: resolved.source,
    runId: null,
    runDir: null,
    proc: null,
    stopping: false,
    restarts: 0,
    backoffMs: BACKOFF_START_MS,
    startedAt: new Date(),
    lastStartAt: 0,
    restartTimer: null,
    lastSegmentAt: null,
  };
  active.set(id, state);

  if (resolved.source === 'ezviz-cloud') {
    attachEzviz(state, resolved.serial);
  } else {
    spawnFfmpeg(state, resolved.inputArgs);
  }

  startIndexer();
  console.log(`[recorder] started ${id} via ${resolved.source}`);
  return { started: true, source: resolved.source };
}

function stop(cameraId) {
  const id = String(cameraId);
  const state = active.get(id);
  if (!state) return { already: true };

  state.stopping = true;
  if (state.restartTimer) clearTimeout(state.restartTimer);

  if (state.source === 'ezviz-cloud') {
    // Closing stdin gives ffmpeg EOF, which makes it finalise the in-progress
    // MP4 and write its moov. The grace period is what actually lets that
    // happen — killing immediately leaves the last segment unplayable.
    // Deliberately NOT a 'q' keystroke: here stdin carries the HEVC stream, so
    // writing to it would corrupt the input.
    ezvizCloud.detachConsumer(id, 'record', { graceMs: 4000 });
  } else if (state.proc) {
    // URL input, so stdin is free: 'q' is ffmpeg's graceful-quit keystroke.
    try { state.proc.stdin.write('q'); } catch (_) {}
    setTimeout(() => { try { state.proc.kill('SIGTERM'); } catch (_) {} }, 3000);
    setTimeout(() => { try { state.proc.kill('SIGKILL'); } catch (_) {} }, 6000);
  }

  active.delete(id);
  console.log(`[recorder] stopped ${id}`);
  // One last sweep, after the grace period, so the just-finalised segment is indexed.
  setTimeout(() => { indexOnce().catch(() => {}); }, 9000);
  if (active.size === 0) stopIndexer();
  return { stopped: true };
}

function stopAll() {
  for (const id of [...active.keys()]) stop(id);
}

function isRecording(cameraId) {
  return active.has(String(cameraId));
}

function getStatus() {
  return [...active.values()].map((s) => ({
    cameraId: s.cameraId,
    source: s.source,
    startedAt: s.startedAt,
    restarts: s.restarts,
    runId: s.runId,
    lastSegmentAt: s.lastSegmentAt,
  }));
}

// ── indexing: tail each run's segment-list CSV ────────────────────────────────

const csvOffsets = new Map(); // absolute csv path -> bytes consumed

/**
 * ffmpeg appends "<file>,<start>,<end>" the moment a segment closes, so the CSV
 * is a race-free signal that a file is complete. Using it also avoids depending
 * on ffprobe (FFPROBE_PATH is unset here and getFfprobePath() falls back to a
 * bare "ffprobe").
 */
async function indexOnce() {
  let cameraDirs = [];
  try {
    cameraDirs = await fsp.readdir(RECORDINGS_DIR, { withFileTypes: true });
  } catch (_) {
    return { indexed: 0 };
  }

  let indexed = 0;
  for (const camEntry of cameraDirs) {
    if (!camEntry.isDirectory()) continue;
    const cameraId = camEntry.name;
    const camDir = path.join(RECORDINGS_DIR, cameraId);

    let runDirs = [];
    try {
      runDirs = await fsp.readdir(camDir, { withFileTypes: true });
    } catch (_) { continue; }

    for (const runEntry of runDirs) {
      if (!runEntry.isDirectory()) continue;
      const runDir = path.join(camDir, runEntry.name);
      const csvPath = path.join(runDir, CSV_NAME);

      let text = '';
      try {
        text = await fsp.readFile(csvPath, 'utf8');
      } catch (_) { continue; }

      const consumed = csvOffsets.get(csvPath) || 0;
      if (text.length <= consumed) continue;
      const fresh = text.slice(consumed);
      // Only consume through the last newline; a partial trailing line means the
      // row is still being written.
      const lastNl = fresh.lastIndexOf('\n');
      if (lastNl < 0) continue;
      csvOffsets.set(csvPath, consumed + lastNl + 1);

      for (const line of fresh.slice(0, lastNl).split(/\r?\n/)) {
        const parts = line.trim().split(',');
        if (parts.length < 3) continue;
        const [name, startStr, endStr] = parts;
        const startedAt = parseSegmentFilename(name);
        if (!startedAt) continue;
        const durationSec = Math.max(0, Number(endStr) - Number(startStr));
        if (!Number.isFinite(durationSec) || durationSec <= 0) continue;

        const absFile = path.join(runDir, name);
        let sizeBytes = 0;
        try { sizeBytes = (await fsp.stat(absFile)).size; } catch (_) { continue; }

        const doc = {
          cameraId,
          startedAt,
          endedAt: new Date(startedAt.getTime() + durationSec * 1000),
          durationSec,
          filePath: toPosixRel(absFile),
          sizeBytes,
          dayKey: localDayKey(startedAt),
          source: active.get(cameraId)?.source || 'ezviz-cloud',
          runId: runEntry.name,
        };
        try {
          await Recording.create(doc);
          indexed += 1;
          const st = active.get(cameraId);
          if (st) st.lastSegmentAt = doc.endedAt;
        } catch (err) {
          // Duplicate key just means another sweep already indexed it.
          if (err.code !== 11000) console.warn(`[recorder] index failed ${doc.filePath}: ${err.message}`);
        }
      }
    }
  }
  if (indexed) console.log(`[recorder] indexed ${indexed} segment(s)`);
  return { indexed };
}

function startIndexer() {
  if (indexTimer) return;
  indexTimer = setInterval(() => { indexOnce().catch(() => {}); }, INDEX_INTERVAL_MS);
  console.log('[recorder] segment indexer started');
}

function stopIndexer() {
  if (!indexTimer) return;
  clearInterval(indexTimer);
  indexTimer = null;
}

async function restoreRecorders() {
  const raw = String(process.env.RESTORE_AUTORECORD_ON_START ?? 'true').trim().toLowerCase();
  if (raw === 'false' || raw === '0') {
    console.log('[recorder] Skipping restore on startup (RESTORE_AUTORECORD_ON_START=false)');
    return;
  }
  let cameras = [];
  try {
    cameras = await Camera.find({ autoRecord: true, ipAddress: { $ne: '' } }).lean();
  } catch (err) {
    console.warn(`[recorder] restore query failed: ${err.message}`);
    return;
  }
  cameras.forEach((cam, i) => {
    // Stagger so several cameras don't hit ffmpeg/EZVIZ simultaneously.
    setTimeout(() => {
      start(cam._id).catch((e) => console.warn(`[recorder] restore ${cam._id} failed: ${e.message}`));
    }, 3000 + i * 2000);
  });
  if (cameras.length) console.log(`[recorder] restoring ${cameras.length} recorder(s)`);
}

module.exports = {
  isConfigured,
  start,
  stop,
  stopAll,
  isRecording,
  getStatus,
  restoreRecorders,
  indexOnce,
  RECORDINGS_DIR,
};
