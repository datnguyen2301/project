/**
 * EZVIZ cloud live streaming via the consumer (app) protocol.
 *
 * Why this exists: the EZVIZ Open Platform live-address API refuses to serve
 * video on accounts whose streaming package is exhausted (it returns a manifest
 * pointing at /ErrCode/9053_0.ts), and the camera's own LAN RTSP is unreachable
 * when the camera isn't on the server's network. This path avoids both:
 *
 *   - It authenticates with the ACCOUNT email/password (the same credentials the
 *     EZVIZ mobile app uses), not an Open Platform appKey, so the streaming
 *     quota does not apply.
 *   - It pulls video over an OUTBOUND TCP connection to EZVIZ's VTM/VTDU relay
 *     servers, so it works from behind symmetric NAT where UDP hole-punching
 *     fails.
 *
 * The helper binary emits raw Annex-B HEVC on stdout; we pipe that straight into
 * FFmpeg, which transcodes to H.264 HLS (browsers cannot play H.265 natively).
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

// cameraId -> { vs, ff, outDir, serial, startedAt, restarts, stopping }
const active = new Map();

function cleanDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  } catch (_) {}
}

function ffmpegArgs() {
  // The camera sends 2880x1620 HEVC at ~10Mbps. Re-encoding that at full size
  // is wasteful for a browser preview and makes segments multi-megabyte, which
  // stalls playback. Scale down and cap the bitrate; override via env if you
  // genuinely want full resolution.
  const height = process.env.EZVIZ_STREAM_HEIGHT || '720';
  const bitrate = process.env.EZVIZ_STREAM_BITRATE || '2000k';

  return [
    '-v', 'warning',
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

/** Spawn the helper->ffmpeg chain. Returns the two child processes. */
function spawnChain(cameraId, serial, outDir) {
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

  const ff = spawn(ffmpegPath(), ffmpegArgs(), { cwd: outDir, stdio: ['pipe', 'ignore', 'pipe'] });

  vs.stdout.pipe(ff.stdin);

  let vsErr = '';
  vs.stderr.on('data', (c) => {
    vsErr = (vsErr + c.toString()).slice(-2000);
  });
  vs.on('close', (code) => {
    const state = active.get(cameraId);
    if (state && !state.stopping) {
      console.warn(`[ezvizCloud] helper exited (code ${code}) for ${serial}${vsErr ? `: ${vsErr.slice(-300)}` : ''}`);
    }
    try { ff.stdin.end(); } catch (_) {}
  });

  let ffErr = '';
  ff.stderr.on('data', (c) => {
    ffErr = (ffErr + c.toString()).slice(-2000);
  });
  ff.on('close', (code) => {
    const state = active.get(cameraId);
    if (!state || state.stopping || state.ff !== ff) return;
    console.warn(`[ezvizCloud] ffmpeg exited (code ${code}) for ${serial}${ffErr ? `: ${ffErr.slice(-300)}` : ''}`);
    scheduleRestart(cameraId);
  });

  // Piping into a dead ffmpeg raises EPIPE; it is expected during teardown.
  vs.stdout.on('error', () => {});
  ff.stdin.on('error', () => {});

  return { vs, ff };
}

/**
 * The helper is beta and its VTDU session can drop; respawn the chain so the
 * viewer sees a brief stall rather than a dead stream.
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
    stop(cameraId);
    return;
  }
  state.restarts += 1;
  console.log(`[ezvizCloud] restarting ${state.serial} (attempt ${state.restarts}/${MAX_RESTARTS})`);

  state.restartTimer = setTimeout(() => {
    const cur = active.get(cameraId);
    if (!cur || cur.stopping) return;
    const { vs, ff } = spawnChain(cameraId, cur.serial, cur.outDir);
    cur.vs = vs;
    cur.ff = ff;
  }, RESTART_DELAY_MS);
}

/** Wait until FFmpeg has written a playable segment. */
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

async function start(cameraId, serial) {
  const id = String(cameraId);
  if (active.has(id)) {
    return { already: true, hlsUrl: hlsUrl(id) };
  }
  if (!isConfigured()) {
    throw new Error(
      'EZVIZ cloud streaming not configured: needs EZVIZ_EMAIL, EZVIZ_PASSWORD and the helper binary at backend/bin/',
    );
  }

  const outDir = path.join(STREAMS_DIR, id);
  cleanDir(outDir);

  const { vs, ff } = spawnChain(id, serial, outDir);
  active.set(id, { vs, ff, outDir, serial, startedAt: new Date(), restarts: 0, stopping: false });

  try {
    await waitForSegment(outDir, READY_TIMEOUT_MS);
  } catch (err) {
    stop(id);
    throw new Error(`EZVIZ cloud stream failed to start for ${serial}: ${err.message}`);
  }

  console.log(`[ezvizCloud] live for ${serial} → ${hlsUrl(id)}`);
  return { started: true, cloud: true, hlsUrl: hlsUrl(id), type: 'ezviz-cloud-p2p' };
}

function stop(cameraId) {
  const id = String(cameraId);
  const state = active.get(id);
  if (!state) return { already: true };

  state.stopping = true;
  if (state.restartTimer) clearTimeout(state.restartTimer);
  for (const proc of [state.vs, state.ff]) {
    try { proc.kill('SIGTERM'); } catch (_) {}
    try { proc.kill('SIGKILL'); } catch (_) {}
  }
  active.delete(id);

  try {
    for (const f of fs.readdirSync(state.outDir)) {
      try { fs.unlinkSync(path.join(state.outDir, f)); } catch (_) {}
    }
    fs.rmdirSync(state.outDir);
  } catch (_) {}

  console.log(`[ezvizCloud] stopped ${state.serial}`);
  return { stopped: true, cloud: true };
}

function isStreaming(cameraId) {
  return active.has(String(cameraId));
}

function getStatus() {
  return [...active.entries()].map(([cameraId, s]) => ({
    cameraId,
    hlsUrl: hlsUrl(cameraId),
    cloud: true,
    serial: s.serial,
    startedAt: s.startedAt,
    restarts: s.restarts,
  }));
}

function stopAll() {
  for (const id of [...active.keys()]) stop(id);
}

module.exports = {
  isConfigured,
  start,
  stop,
  stopAll,
  isStreaming,
  getStatus,
  hlsUrl,
  regionName,
};