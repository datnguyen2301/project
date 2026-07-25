/**
 * EZVIZ cloud live streaming via the consumer (app) protocol.
 *
 * Why this exists: the EZVIZ Open Platform live-address API refuses to serve
 * video on accounts whose streaming package is exhausted (it returns a manifest
 * pointing at /ErrCode/9053_0.ts), and the camera's own LAN RTSP is unreachable
 * when the camera isn't on the server's network. This path avoids both:
 *
 *   - It authenticates with the ACCOUNT email/password (the same credentials the
 *     EZVIZ app uses), not an Open Platform appKey, so the streaming quota does
 *     not apply.
 *   - It pulls video over an OUTBOUND TCP connection to EZVIZ's VTM/VTDU relays,
 *     so it works behind symmetric NAT, where UDP hole-punching fails.
 *
 * The helper binary emits raw Annex-B HEVC on stdout. That stdout is a SHARED
 * resource: one helper per camera, fanned out to N "consumers" (each its own
 * ffmpeg). Live view is one consumer; continuous recording is another. Running a
 * second helper for the same serial would open a second VTM/VTDU session for the
 * device and race over the `featurecode` terminal identity the helper persists in
 * bin/, so consumers are reference-counted and the helper is torn down only when
 * the last one detaches.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const STREAMS_DIR = path.join(__dirname, '..', 'streams');
const BIN_DIR = path.join(__dirname, '..', 'bin');
const DEFAULT_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'le-ezviz-vs.exe' : 'le-ezviz-vs');

const READY_TIMEOUT_MS = 45_000;
const RESTART_DELAY_MS = 3_000;
const MAX_RESTARTS = 5;
// Uptime after which a stream counts as healthy and its restart budget resets.
const STABLE_RESET_MS = 120_000;

const LIVE_CONSUMER = 'live';

function binPath() {
  return process.env.EZVIZ_VS_PATH || DEFAULT_BIN;
}

function ffmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

// The helper takes a region NAME; our .env carries a pyezviz-style API host
// (e.g. "apiisgp"). Map between them so one setting drives both.
const REGION_BY_CODE = {
  isgp: 'Asia',
  ieu: 'Europe',
  iindia: 'India',
  ius: 'NorthAmerica',
  isa: 'SouthAmerica',
};

function regionName() {
  if (process.env.EZVIZ_VS_REGION) return process.env.EZVIZ_VS_REGION;
  const code = String(process.env.EZVIZ_REGION || '')
    .trim()
    .replace(/^api/i, '')
    .replace(/\..*$/, '')
    .toLowerCase();
  return REGION_BY_CODE[code] || 'Europe';
}

function isConfigured() {
  return Boolean(process.env.EZVIZ_EMAIL && process.env.EZVIZ_PASSWORD && fs.existsSync(binPath()));
}

function hlsUrl(cameraId) {
  return `/streams/${cameraId}/stream.m3u8`;
}

/**
 * cameraId -> {
 *   vs, serial, startedAt, restarts, lastRestartAt, stopping, restartTimer,
 *   consumers: Map<consumerId, { makeSpec, ownsDir, proc, cwd }>
 * }
 */
const active = new Map();

function cleanDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  } catch (_) {}
}

function liveFfmpegArgs() {
  const height = process.env.EZVIZ_STREAM_HEIGHT || '720';
  const bitrate = process.env.EZVIZ_STREAM_BITRATE || '2000k';

  return [
    '-v', 'warning',
    // Raw Annex-B HEVC carries no timestamps and the demuxer assumes 25fps while
    // the camera sends ~15-20, so stream time would drift from wall time.
    '-use_wallclock_as_timestamps', '1',
    '-f', 'hevc',
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    // -2 keeps the aspect ratio and guarantees an even width (h264 requires it).
    '-vf', `scale=-2:${height}`,
    '-b:v', bitrate,
    '-maxrate', bitrate,
    '-bufsize', '4000k',
    '-g', '30',
    '-an',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '5',
    // append_list so a helper restart continues the same playlist instead of
    // resetting the player back to zero.
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', 'seg_%03d.ts',
    'stream.m3u8',
  ];
}

function spawnHelper(cameraId, serial) {
  const vs = spawn(
    binPath(),
    [
      `-email=${process.env.EZVIZ_EMAIL}`,
      `-password=${process.env.EZVIZ_PASSWORD}`,
      `-region=${regionName()}`,
      `-deviceSerial=${serial}`,
      '-pipe',
      '-logFile=false',
      '-stdout=false',
    ],
    // cwd is bin/: the helper persists a "featurecode" terminal id next to itself.
    { cwd: BIN_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let vsErr = '';
  vs.stderr.on('data', (c) => { vsErr = (vsErr + c.toString()).slice(-2000); });
  // Piping into a dead ffmpeg raises EPIPE; expected during teardown.
  vs.stdout.on('error', () => {});

  vs.on('close', (code) => {
    const state = active.get(cameraId);
    if (!state || state.stopping || state.vs !== vs) return;
    console.warn(`[ezvizCloud] helper exited (code ${code}) for ${serial}${vsErr ? `: ${vsErr.slice(-300)}` : ''}`);
    // The source is gone; every consumer's ffmpeg will EOF and exit. Tear them
    // down deliberately so the restart respawns a clean set.
    killConsumerProcs(state);
    scheduleRestart(cameraId);
  });

  return vs;
}

/** Spawn one consumer's ffmpeg and wire the shared helper stdout into it. */
function spawnConsumerProc(state, consumerId, consumer) {
  const spec = consumer.makeSpec();
  consumer.cwd = spec.cwd;
  fs.mkdirSync(spec.cwd, { recursive: true });

  const proc = spawn(ffmpegPath(), spec.args, { cwd: spec.cwd, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (c) => { err = (err + c.toString()).slice(-2000); });
  proc.stdin.on('error', () => {});

  proc.on('close', (code) => {
    const cur = active.get(state.cameraId);
    if (!cur || cur.stopping) return;
    const c = cur.consumers.get(consumerId);
    if (!c || c.proc !== proc) return;   // already replaced by a restart
    console.warn(`[ezvizCloud] consumer '${consumerId}' ffmpeg exited (code ${code}) for ${cur.serial}${err ? `: ${err.slice(-300)}` : ''}`);
    // ffmpeg died while the source is still alive — respawn just this consumer.
    if (cur.vs && !cur.vs.killed) {
      try { cur.vs.stdout.unpipe(proc.stdin); } catch (_) {}
      spawnConsumerProc(cur, consumerId, c);
    }
  });

  consumer.proc = proc;
  // Multiple pipe destinations: Node fans out and propagates backpressure, so a
  // slow consumer throttles the source instead of ballooning memory.
  if (state.vs) state.vs.stdout.pipe(proc.stdin);
  return proc;
}

function killConsumerProcs(state) {
  for (const c of state.consumers.values()) {
    if (!c.proc) continue;
    try { state.vs && state.vs.stdout.unpipe(c.proc.stdin); } catch (_) {}
    try { c.proc.stdin.end(); } catch (_) {}
    try { c.proc.kill('SIGTERM'); } catch (_) {}
    c.proc = null;
  }
}

/**
 * The helper is beta and its VTDU session can drop; respawn the helper and every
 * attached consumer so viewers see a stall rather than a dead stream.
 */
function scheduleRestart(cameraId) {
  const state = active.get(cameraId);
  if (!state || state.stopping) return;

  // Only count restarts that cluster together. A stream that ran fine for
  // minutes before dropping is a transient blip, not a failing stream, so it
  // must not consume the budget that guards against a rapid crash loop.
  const now = Date.now();
  if (state.lastRestartAt && now - state.lastRestartAt > STABLE_RESET_MS) {
    state.restarts = 0;
  }
  state.lastRestartAt = now;

  if (state.restarts >= MAX_RESTARTS) {
    console.warn(`[ezvizCloud] giving up on ${state.serial} after ${MAX_RESTARTS} restarts in quick succession`);
    teardown(cameraId);
    return;
  }
  state.restarts += 1;
  console.log(`[ezvizCloud] restarting ${state.serial} (attempt ${state.restarts}/${MAX_RESTARTS})`);

  state.restartTimer = setTimeout(() => {
    const cur = active.get(cameraId);
    if (!cur || cur.stopping) return;
    cur.vs = spawnHelper(cameraId, cur.serial);
    for (const [id, c] of cur.consumers) spawnConsumerProc(cur, id, c);
  }, RESTART_DELAY_MS);
}

/** Wait until a consumer has written a playable HLS segment. */
function waitForSegment(outDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let hasSegment = false;
      try {
        hasSegment = fs.readdirSync(outDir).some((f) => f.endsWith('.ts'));
      } catch (_) {}
      if (hasSegment) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`no HLS segment within ${Math.round(timeoutMs / 1000)}s`));
      }
    }, 250);
  });
}

/**
 * Attach a consumer to the camera's helper, starting the helper if needed.
 *
 * `makeSpec()` is called fresh on every (re)spawn and returns `{ args, cwd }`.
 * Regenerating rather than capturing lets a consumer vary its output per run —
 * the recorder uses this to mint a new run directory each restart, which keeps
 * segment filenames unique across runs.
 */
function attachConsumer(cameraId, serial, { id, makeSpec, ownsDir = false }) {
  const camId = String(cameraId);
  if (!isConfigured()) {
    throw new Error(
      'EZVIZ cloud streaming not configured: needs EZVIZ_EMAIL, EZVIZ_PASSWORD and the helper binary at backend/bin/',
    );
  }

  let state = active.get(camId);
  if (!state) {
    state = {
      cameraId: camId,
      serial,
      vs: null,
      consumers: new Map(),
      startedAt: new Date(),
      restarts: 0,
      lastRestartAt: 0,
      stopping: false,
      restartTimer: null,
    };
    active.set(camId, state);
    state.vs = spawnHelper(camId, serial);
  }

  if (state.consumers.has(id)) return state.consumers.get(id);

  const consumer = { makeSpec, ownsDir, proc: null, cwd: null };
  state.consumers.set(id, consumer);
  spawnConsumerProc(state, id, consumer);
  return consumer;
}

/**
 * Detach one consumer; the helper stops once the last consumer is gone.
 *
 * `graceMs` lets a consumer finish writing its container before being killed.
 * This matters for the recorder: closing stdin gives ffmpeg EOF on its input, at
 * which point it finalises the current MP4 and writes the moov — kill it first
 * and that segment is left unplayable. Note EOF, not a 'q' keystroke, is the
 * right signal here because for these consumers stdin *is* the video stream.
 */
function detachConsumer(cameraId, id, { graceMs = 0 } = {}) {
  const camId = String(cameraId);
  const state = active.get(camId);
  if (!state) return { already: true };
  const consumer = state.consumers.get(id);
  if (!consumer) return { already: true };

  if (consumer.proc) {
    const proc = consumer.proc;
    try { state.vs && state.vs.stdout.unpipe(proc.stdin); } catch (_) {}
    try { proc.stdin.end(); } catch (_) {}
    if (graceMs > 0) {
      setTimeout(() => { try { proc.kill('SIGTERM'); } catch (_) {} }, graceMs);
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, graceMs + 3000);
    } else {
      try { proc.kill('SIGTERM'); } catch (_) {}
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
  }
  state.consumers.delete(id);

  // Only the consumer that owns the directory may delete it — otherwise stopping
  // the live view would wipe the HLS dir out from under a still-running recorder.
  if (consumer.ownsDir && consumer.cwd) {
    try {
      for (const f of fs.readdirSync(consumer.cwd)) {
        try { fs.unlinkSync(path.join(consumer.cwd, f)); } catch (_) {}
      }
      fs.rmdirSync(consumer.cwd);
    } catch (_) {}
  }

  if (state.consumers.size === 0) teardown(camId);
  return { stopped: true, cloud: true };
}

function teardown(cameraId) {
  const camId = String(cameraId);
  const state = active.get(camId);
  if (!state) return;
  state.stopping = true;
  if (state.restartTimer) clearTimeout(state.restartTimer);
  killConsumerProcs(state);
  for (const c of state.consumers.values()) {
    if (c.proc) { try { c.proc.kill('SIGKILL'); } catch (_) {} }
  }
  if (state.vs) {
    try { state.vs.kill('SIGTERM'); } catch (_) {}
    try { state.vs.kill('SIGKILL'); } catch (_) {}
  }
  active.delete(camId);
  console.log(`[ezvizCloud] helper stopped for ${state.serial}`);
}

// ── Live-view API (unchanged surface, now implemented over consumers) ──────────

async function start(cameraId, serial) {
  const id = String(cameraId);
  if (isStreaming(id)) {
    return { already: true, hlsUrl: hlsUrl(id) };
  }

  const outDir = path.join(STREAMS_DIR, id);
  cleanDir(outDir);

  attachConsumer(id, serial, {
    id: LIVE_CONSUMER,
    ownsDir: true,
    makeSpec: () => ({ args: liveFfmpegArgs(), cwd: outDir }),
  });

  try {
    await waitForSegment(outDir, READY_TIMEOUT_MS);
  } catch (err) {
    detachConsumer(id, LIVE_CONSUMER);
    throw new Error(`EZVIZ cloud stream failed to start for ${serial}: ${err.message}`);
  }

  console.log(`[ezvizCloud] live for ${serial} → ${hlsUrl(id)}`);
  return { started: true, cloud: true, hlsUrl: hlsUrl(id), type: 'ezviz-cloud-p2p' };
}

function stop(cameraId) {
  return detachConsumer(cameraId, LIVE_CONSUMER);
}

/**
 * True only when a LIVE consumer is attached — deliberately not "is the helper
 * running". stream.js branches on this in startStream()/stopStream(); if it
 * returned true merely because recording was active, the live button would hand
 * back an hlsUrl for a stream nobody is producing.
 */
function isStreaming(cameraId) {
  const state = active.get(String(cameraId));
  return Boolean(state && state.consumers.has(LIVE_CONSUMER));
}

/** True when the shared helper is up for this camera, for any consumer. */
function isHelperRunning(cameraId) {
  return active.has(String(cameraId));
}

function getStatus() {
  return [...active.entries()]
    .filter(([, s]) => s.consumers.has(LIVE_CONSUMER))
    .map(([cameraId, s]) => ({
      cameraId,
      hlsUrl: hlsUrl(cameraId),
      cloud: true,
      serial: s.serial,
      startedAt: s.startedAt,
      restarts: s.restarts,
      consumers: [...s.consumers.keys()],
    }));
}

function stopAll() {
  for (const id of [...active.keys()]) teardown(id);
}

module.exports = {
  isConfigured,
  start,
  stop,
  stopAll,
  isStreaming,
  isHelperRunning,
  getStatus,
  hlsUrl,
  regionName,
  attachConsumer,
  detachConsumer,
};
