const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ezviz = require('./ezviz');
const { getBuffer, removeBuffer, STOP_SIGNAL } = require('./ringBuffer');

const FFMPEG_INTERVAL_MS = 200;
const CAPTURE_TIMEOUT_MS = 8000;
const FRAME_EXTRACT_TIMEOUT_MS = 3000;
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const activeStreams = new Map();

function getFfmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function rtspBase(localIp, port, camKey) {
  const p = port || '554';
  if (camKey) {
    const user = encodeURIComponent('admin');
    const pass = encodeURIComponent(String(camKey));
    return `rtsp://${user}:${pass}@${localIp}:${p}`;
  }
  return `rtsp://${localIp}:${p}`;
}

function buildFastCandidates({ localIp, rtspPort, camKey }) {
  const port = rtspPort || '554';
  const key = String(camKey || '').trim();
  const candidates = [];

  if (key) {
    candidates.push(
      { type: 'ezviz_h265_sub', url: `${rtspBase(localIp, port, key)}/ch${key}/sub/av_stream` },
      { type: 'ezviz_h265_main', url: `${rtspBase(localIp, port, key)}/ch${key}/main/av_stream` },
    );
  }

  candidates.push(
    { type: 'h264_main', url: `${rtspBase(localIp, port, key)}/h264/ch1/main/av_stream` },
    { type: 'h264_sub', url: `${rtspBase(localIp, port, key)}/h264/ch1/sub/av_stream` },
    { type: 'h265_sub', url: `${rtspBase(localIp, port, key)}/h265/ch1/sub/av_stream` },
    { type: 'h265_main', url: `${rtspBase(localIp, port, key)}/h265/ch1/main/av_stream` },
    { type: 'chan102', url: `${rtspBase(localIp, port, key)}/Streaming/Channels/102` },
    { type: 'chan101', url: `${rtspBase(localIp, port, key)}/Streaming/Channels/101` },
    { type: 'dahua_sub', url: `${rtspBase(localIp, port, key)}/cam/realmonitor?channel=1&subtype=1` },
    { type: 'dahua_main', url: `${rtspBase(localIp, port, key)}/cam/realmonitor?channel=1&subtype=0` },
    { type: 'live', url: `${rtspBase(localIp, port, key)}/live` },
    { type: 'generic_stream', url: `${rtspBase(localIp, port, key)}/stream` },
  );

  return candidates;
}

async function getRtspInfoForCamera(camera) {
  const hasLocalRtsp = Boolean(String(camera.rtspHost || '').trim());
  const hasVerify = Boolean(String(camera.verifyCode || '').trim());

  if (hasLocalRtsp && hasVerify) {
    const raw = String(camera.rtspHost).trim();
    const [host, portPart] = raw.includes(':') ? raw.split(':') : [raw, '554'];
    return {
      localIp: host.trim(),
      rtspPort: (portPart || '554').trim(),
      camKey: String(camera.verifyCode).trim(),
    };
  }

  const serial = String(camera.ipAddress || '').trim();
  try {
    const streamInfo = await ezviz.getRtspInfo(serial, { timeout: 12000 });
    if (camera.verifyCode) streamInfo.camKey = String(camera.verifyCode).trim();
    return streamInfo;
  } catch (err) {
    throw new Error(`getRtspInfo failed for ${serial}: ${err.message}`);
  }
}

async function extractOneFrame(rtspUrl, destPath, timeoutMs, transport = 'tcp') {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegPath();
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-rtsp_transport', transport,
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-max_delay', '5000000',
      '-probesize', '2000000',
      '-analyzeduration', '2000000',
      '-i', rtspUrl,
      '-frames:v', '1',
      '-q:v', '2',
      '-y',
      destPath,
    ];

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      try { fs.unlinkSync(destPath); } catch (_) {}
      resolve({ ok: false, stderr: 'timeout' });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try { fs.unlinkSync(destPath); } catch (_) {}
        resolve({ ok: false, stderr });
        return;
      }
      try {
        const st = fs.statSync(destPath);
        if (st.size > 0) {
          resolve({ ok: true, stderr: '' });
        } else {
          try { fs.unlinkSync(destPath); } catch (_) {}
          resolve({ ok: false, stderr: 'empty_output' });
        }
      } catch (_) {
        resolve({ ok: false, stderr });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      try { fs.unlinkSync(destPath); } catch (_) {}
      resolve({ ok: false, stderr: err.message });
    });
  });
}

async function captureRtspFrame(camera, destPath, timeoutMs = FRAME_EXTRACT_TIMEOUT_MS) {
  try {
    const streamInfo = await getRtspInfoForCamera(camera);
    const candidates = buildFastCandidates(streamInfo);

    const fastCandidates = candidates.slice(0, 3);
    for (const c of fastCandidates) {
      const { ok, stderr } = await extractOneFrame(c.url, destPath, timeoutMs, 'tcp');
      if (ok) return { ok: true, type: c.type };
      if (stderr === 'timeout') {
        const { ok: okUdp } = await extractOneFrame(c.url, destPath, timeoutMs, 'udp');
        if (okUdp) return { ok: true, type: c.type + '(UDP)' };
      }
    }
    return { ok: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function startStreamBridge(cameraId, camera) {
  if (activeStreams.has(cameraId)) {
    return { already: true };
  }

  const tmpDir = path.join(UPLOADS_DIR, '.stream_bridge');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}

  const tmpPath = path.join(tmpDir, `bridge_${cameraId}_${Date.now()}.jpg`);

  const state = {
    cameraId,
    camera,
    tmpPath,
    intervalId: null,
    stopped: undefined,
    lastFrameAt: null,
    framesExtracted: 0,
    errors: 0,
  };

  const extractAndPush = async () => {
    if (state.stopped === STOP_SIGNAL) return;

    const buf = getBuffer(cameraId);
    if (buf && buf.stopped === STOP_SIGNAL) return;

    try {
      const result = await captureRtspFrame(camera, tmpPath, FRAME_EXTRACT_TIMEOUT_MS);
      if (result.ok && fs.existsSync(tmpPath)) {
        const frameBuf = fs.readFileSync(tmpPath);
        if (frameBuf.length > 0) {
          if (buf) buf.push(frameBuf);
          state.framesExtracted++;
          state.lastFrameAt = Date.now();
        }
      } else {
        state.errors++;
      }
    } catch (err) {
      state.errors++;
    }
  };

  state.intervalId = setInterval(extractAndPush, FFMPEG_INTERVAL_MS);
  extractAndPush();

  activeStreams.set(cameraId, state);
  console.log(`[streamBridge] Started for camera ${cameraId} (extract every ${FFMPEG_INTERVAL_MS}ms)`);
  return { started: true };
}

async function stopStreamBridge(cameraId) {
  const state = activeStreams.get(cameraId);
  if (!state) return { already: true };

  state.stopped = STOP_SIGNAL;
  clearInterval(state.intervalId);

  if (state.tmpPath && fs.existsSync(state.tmpPath)) {
    try { fs.unlinkSync(state.tmpPath); } catch (_) {}
  }

  activeStreams.delete(cameraId);
  removeBuffer(cameraId);
  console.log(`[streamBridge] Stopped for camera ${cameraId}`);
  return { stopped: true };
}

function isStreaming(cameraId) {
  return activeStreams.has(cameraId);
}

function getStreamStatus() {
  const out = [];
  for (const [cameraId, state] of activeStreams) {
    out.push({
      cameraId,
      framesExtracted: state.framesExtracted,
      errors: state.errors,
      lastFrameAt: state.lastFrameAt ? new Date(state.lastFrameAt) : null,
      isActive: state.stopped !== STOP_SIGNAL,
    });
  }
  return out;
}

function getBufferForCamera(cameraId) {
  return getBuffer(cameraId) || null;
}

module.exports = {
  startStreamBridge,
  stopStreamBridge,
  isStreaming,
  getStreamStatus,
  getBufferForCamera,
  captureRtspFrame,
  FFMPEG_INTERVAL_MS,
};
