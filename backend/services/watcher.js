const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const sharp = require('sharp');
const Camera = require('../models/Camera');
const Event = require('../models/Event');
const { analyzeImage, analyzeEventMedia } = require('./analyzer');
const { captureRtspJpegToFile, captureFromHlsSegment } = require('./rtspCapture');
const ezviz = require('./ezviz');
const { isIpWebcamAddress, isEzvizSerialAddress } = require('../utils/cameraAddress');
const { getBuffer, STOP_SIGNAL } = require('./ringBuffer');
const {
  startStreamBridge,
  stopStreamBridge,
} = require('./streamBridge');

const FETCH_IMAGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const CLIPS_DIR = path.join(UPLOADS_DIR, 'clips');

// ── Timing constants ─────────────────────────────────────────────────────────
const COOLDOWN_MS = 3000;
const DETECT_INTERVAL_MS = 1500;

// ── Recording constants (optimized) ────────────────────────────────────────
const CLIP_BEFORE_SEC = 10;
const MAX_CLIP_DURATION_SEC = 30;
const RECORDING_COOLDOWN_SEC = 8;
const RECORDING_MAX_IDLE_CYCLES = 10;
const MAX_PENDING_FRAMES = 300;
const MIN_CLIP_FRAMES = 3;

const watchers = new Map();
const cleanupInProgress = new Set();
const CACHE_DIR = path.join(UPLOADS_DIR, '.watcher_cache');

async function ensureCacheDir() {
  try { await fsp.mkdir(CACHE_DIR, { recursive: true }); } catch (_) { }
}

async function ensureClipsDir() {
  try { await fsp.mkdir(CLIPS_DIR, { recursive: true }); } catch (_) { }
}

function cachePath(cameraId) {
  return path.join(CACHE_DIR, `last_${cameraId}.jpg`);
}

function getSnapshotUrl(ipAddress) {
  const base = ipAddress.startsWith('http') ? ipAddress : `http://${ipAddress}`;
  return `${base.replace(/\/$/, '')}/shot.jpg`;
}

function bufferLooksLikeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  return false;
}

function getFfmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

const { sendWatcherEvent, sendWatcherStatus } = require('./sse');

function sendRecordingStart(cameraId, data) {
  const { broadcast } = require('./sse');
  broadcast('recording-start', { cameraId, ...data });
}

function sendRecordingStop(cameraId, data) {
  const { broadcast } = require('./sse');
  broadcast('recording-stop', { cameraId, ...data });
}

function sendRecordingComplete(cameraId, data) {
  const { broadcast } = require('./sse');
  broadcast('recording-complete', { cameraId, ...data });
}

// ── RTSP URL builder (reuse logic from streamBridge) ───────────────────────

function rtspBase(localIp, port, camKey) {
  const p = port || '554';
  if (camKey) {
    const user = encodeURIComponent('admin');
    const pass = encodeURIComponent(String(camKey));
    return `rtsp://${user}:${pass}@${localIp}:${p}`;
  }
  return `rtsp://${localIp}:${p}`;
}

function buildRtspCandidates({ localIp, rtspPort, camKey }) {
  const port = rtspPort || '554';
  const key = String(camKey || '').trim();
  const candidates = [];

  if (key) {
    candidates.push(
      { type: 'ezviz_h264_main', url: `${rtspBase(localIp, port, key)}/h264/ch1/main/av_stream` },
    );
    if (/^\d+$/.test(key)) {
      candidates.push(
        { type: 'ezviz_main', url: `${rtspBase(localIp, port, key)}/ch${key}/main/av_stream` },
      );
    }
  }

  candidates.push(
    { type: 'h264_main', url: `${rtspBase(localIp, port, key)}/h264/ch1/main/av_stream` },
    { type: 'h264_sub', url: `${rtspBase(localIp, port, key)}/h264/ch1/sub/av_stream` },
    { type: 'h265_main', url: `${rtspBase(localIp, port, key)}/h265/ch1/main/av_stream` },
    { type: 'chan101', url: `${rtspBase(localIp, port, key)}/Streaming/Channels/101` },
    { type: 'chan102', url: `${rtspBase(localIp, port, key)}/Streaming/Channels/102` },
  );

  const seen = new Set();
  return candidates.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
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

// ── RTSP Direct Recording ─────────────────────────────────────────────────

async function startRtspRecording(cameraId, state, camera) {
  if (state.rtspProc) return;

  try {
    const streamInfo = await getRtspInfoForCamera(camera);
    const candidates = buildRtspCandidates(streamInfo);

    const clipId = uuidv4();
    const dateStr = new Date().toISOString().slice(0, 10);
    const dir = path.join(CLIPS_DIR, dateStr);
    await fsp.mkdir(dir, { recursive: true });

    const mp4Name = `rtsp_${clipId}.mp4`;
    const mp4Path = path.join(dir, mp4Name);

    state.rtspClipId = clipId;
    state.rtspMp4Path = mp4Path;
    state.rtspMp4Name = mp4Name;
    state.rtspDateStr = dateStr;
    state.rtspStartedAt = Date.now();

    for (const candidate of candidates) {
      const success = await tryStartFfmpegRecord(cameraId, state, candidate.url, mp4Path, candidate.type);
      if (success) {
        console.log(`[watcher] [${cameraId}] RTSP recording started via ${candidate.type}`);
        return;
      }
    }

    console.warn(`[watcher] [${cameraId}] All RTSP recording candidates failed — will use JPEG fallback`);
    state.rtspProc = null;
    state.rtspClipId = null;
    state.rtspMp4Path = null;
  } catch (err) {
    console.warn(`[watcher] [${cameraId}] RTSP recording setup failed: ${err.message}`);
    state.rtspProc = null;
  }
}

function tryStartFfmpegRecord(cameraId, state, rtspUrl, outputPath, label) {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegPath();

    const args = [
      '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-timeout', '8000000',
      '-analyzeduration', '1000000',
      '-probesize', '524288',
      '-fflags', '+nobuffer+discardcorrupt+genpts',
      '-flags', '+low_delay',
      '-i', rtspUrl,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ];

    // Use pipe for stdin so we can send 'q' for graceful stop
    const proc = spawn(ffmpegBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let started = false;

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
      if (!started && (stderr.includes('Video:') || stderr.includes('Output #0') || stderr.includes('muxing'))) {
        started = true;
      }
    });

    const startTimer = setTimeout(() => {
      if (!started) {
        try { proc.kill('SIGTERM'); } catch (_) { }
        resolve(false);
      }
    }, 10000);

    const checkInterval = setInterval(() => {
      if (started) {
        clearInterval(checkInterval);
        clearTimeout(startTimer);
        state.rtspProc = proc;
        state.rtspLabel = label;
        console.log(`[watcher] [${cameraId}] RTSP recording confirmed started (${label})`);
        resolve(true);
      }
    }, 300);

    const fileCheck = setTimeout(() => {
      if (!started) {
        try {
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            started = true;
          }
        } catch (_) { }
      }
    }, 3000);

    proc.on('close', (code) => {
      clearInterval(checkInterval);
      clearTimeout(startTimer);
      clearTimeout(fileCheck);
      if (!started) {
        resolve(false);
        return;
      }
      console.log(`[watcher] [${cameraId}] FFmpeg recording ended (code ${code}), label=${label}`);
      if (state.rtspProc === proc) {
        state.rtspProc = null;
      }
    });

    proc.on('error', (err) => {
      clearInterval(checkInterval);
      clearTimeout(startTimer);
      clearTimeout(fileCheck);
      console.warn(`[watcher] [${cameraId}] FFmpeg record error: ${err.message}`);
      resolve(false);
    });
  });
}

function stopRtspRecording(state) {
  if (!state.rtspProc) return Promise.resolve();

  const proc = state.rtspProc;
  state.rtspProc = null;

  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    proc.on('close', () => done());
    proc.on('error', () => done());

    // Step 1: Send 'q' for graceful stop (FFmpeg finalizes MP4 container)
    try {
      proc.stdin?.write('q');
      proc.stdin?.end();
    } catch (_) { }

    // Step 2: SIGTERM after 3s if still running
    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) { }
    }, 3000);

    // Step 3: SIGKILL after 6s as last resort
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { }
    }, 6000);

    // Step 4: Force resolve after 8s no matter what
    setTimeout(() => done(), 8000);
  });
}

// ── Fast RTSP single-frame capture (real-time, via FFmpeg UDP) ─────────────

async function captureRtspFrame(camera, timeoutMs = 3000) {
  const cameraId = camera._id.toString();
  const hasRtsp = Boolean(String(camera.rtspHost || '').trim());
  const hasVerify = Boolean(String(camera.verifyCode || '').trim());

  if (!hasRtsp || !hasVerify) return null;

  // Skip if RTSP recently failed (cache for 60s)
  const failKey = `rtsp_fail_${cameraId}`;
  const lastFail = captureRtspFrame._failCache?.[failKey];
  if (lastFail && Date.now() - lastFail < 60000) return null;

  const raw = String(camera.rtspHost).trim();
  const [host, portPart] = raw.includes(':') ? raw.split(':') : [raw, '554'];
  const port = (portPart || '554').trim();
  const user = encodeURIComponent('admin');
  const pass = encodeURIComponent(String(camera.verifyCode).trim());
  const rtspUrl = `rtsp://${user}:${pass}@${host}:${port}/h264/ch1/main/av_stream`;

  const tmpPath = path.join(UPLOADS_DIR, `rtsp_snap_${uuidv4()}.jpg`);

  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegPath();
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-timeout', String(timeoutMs * 1000),
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-i', rtspUrl,
      '-frames:v', '1',
      '-q:v', '3',
      '-y', tmpPath,
    ];

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      resolve(null);
    }, timeoutMs);

    proc.on('close', async (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(tmpPath)) {
        try {
          const buf = await fsp.readFile(tmpPath);
          await fsp.unlink(tmpPath).catch(() => {});
          if (bufferLooksLikeImage(buf) && buf.length > 500) {
            await fsp.writeFile(cachePath(cameraId), buf).catch(() => {});
            console.log(`[watcher] [${cameraId}] RTSP frame OK (${buf.length} bytes)`);
            resolve(buf);
            return;
          }
        } catch (_) {}
      }
      try { if (fs.existsSync(tmpPath)) await fsp.unlink(tmpPath); } catch (_) {}
      if (stderr) {
        console.warn(`[watcher] [${cameraId}] RTSP snap failed: ${stderr.slice(0, 150)}`);
        // Cache failure to skip RTSP for 60s
        if (!captureRtspFrame._failCache) captureRtspFrame._failCache = {};
        captureRtspFrame._failCache[`rtsp_fail_${cameraId}`] = Date.now();
      }
      resolve(null);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// ── Single-frame capture ───────────────────────────────────────────────────

async function captureOneFrame(camera, opts = {}) {
  const {
    useCacheOnFail = true,
    fastMode = false,
    cloudTimeoutMs = 15000,
    hlsTimeoutMs = 5000,
    rtspTimeoutMs = 5000,
  } = opts;
  const cameraId = camera._id.toString();
  const tmpName = `watch_tmp_${uuidv4()}.jpg`;
  const tmpPath = path.join(UPLOADS_DIR, tmpName);

  let ok = false;
  let frameBuf = null;

  if (isEzvizSerialAddress(camera.ipAddress)) {
    try {
      const capturePromise = ezviz.captureImage(camera.ipAddress, { fastMode: true });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('EZVIZ captureImage timeout')), cloudTimeoutMs)
      );
      const captureData = await Promise.race([capturePromise, timeoutPromise]);
      const picUrl = captureData?.picUrl;
      if (picUrl) {
        const imgRes = await fetch(picUrl, {
          signal: AbortSignal.timeout(cloudTimeoutMs),
          headers: { 'User-Agent': FETCH_IMAGE_UA },
        });
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          if (bufferLooksLikeImage(buf)) {
            await fsp.writeFile(tmpPath, buf);
            ok = true;
            console.log(`[watcher] [${cameraId}] EZVIZ cloud OK (${buf.length} bytes)`);
          }
        }
      }
    } catch (cloudErr) {
      if (cloudErr.message) {
        console.warn(`[watcher] [${cameraId}] EZVIZ cloud failed: ${cloudErr.message}`);
      }
    }

    if (!ok) {
      const hlsResult = await captureFromHlsSegment(cameraId, tmpPath, hlsTimeoutMs);
      if (hlsResult.ok) {
        ok = true;
        console.log(`[watcher] [${cameraId}] HLS capture OK`);
      }
    }

    if (!ok) {
      const rtspOk = await captureRtspJpegToFile(camera, tmpPath, {
        timeoutPerUrlMs: Math.min(rtspTimeoutMs, 3000),
        parallel: true,
        parallelFallbackLimit: 2,
        fallbackTimeoutMs: Math.min(rtspTimeoutMs, 1500),
        totalBudgetMs: rtspTimeoutMs,
      });
      if (rtspOk) {
        ok = true;
        console.log(`[watcher] [${cameraId}] RTSP capture OK`);
      }
    }
  } else if (isIpWebcamAddress(camera.ipAddress)) {
    const url = getSnapshotUrl(camera.ipAddress);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': FETCH_IMAGE_UA },
      });
      if (response.ok) {
        frameBuf = Buffer.from(await response.arrayBuffer());
        if (bufferLooksLikeImage(frameBuf)) {
          await fsp.writeFile(tmpPath, frameBuf);
          ok = true;
          console.log(`[watcher] [${cameraId}] IP Webcam capture OK (${frameBuf.length} bytes)`);
        } else {
          console.warn(`[watcher] [${cameraId}] IP Webcam response not an image (${frameBuf.length} bytes)`);
        }
      } else {
        console.warn(`[watcher] [${cameraId}] IP Webcam HTTP ${response.status} from ${url}`);
      }
    } catch (err) {
      const code = err.cause?.code || err.cause?.message || '';
      console.warn(`[watcher] [${cameraId}] IP Webcam HTTP capture error: ${err.message} (${err.name}, cause: ${code})`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!ok && !frameBuf) {
    if (useCacheOnFail) {
      const cached = cachePath(cameraId);
      if (fs.existsSync(cached)) {
        try { frameBuf = await fsp.readFile(cached); ok = true; } catch (_) { }
      }
    }
    try { if (fs.existsSync(tmpPath)) await fsp.unlink(tmpPath); } catch (_) { }
    return null;
  }

  if (!frameBuf) {
    try { frameBuf = await fsp.readFile(tmpPath); } catch (_) { frameBuf = null; }
    try { if (fs.existsSync(tmpPath)) await fsp.unlink(tmpPath); } catch (_) { }
  }

  if (frameBuf) {
    try { await fsp.writeFile(cachePath(cameraId), frameBuf); } catch (_) { }
  }

  return frameBuf;
}

// ── Save clip ───────────────────────────────────────────────────────────────

async function saveClip(cameraId, state, camera) {
  const frames = state.pendingFrames;
  const hasRtspVideo = state.rtspMp4Path && fs.existsSync(state.rtspMp4Path);

  // Stop RTSP recording first — wait for FFmpeg to finalize MP4
  if (state.rtspProc) {
    console.log(`[watcher] [${cameraId}] Stopping RTSP recording gracefully...`);
    await stopRtspRecording(state);
    console.log(`[watcher] [${cameraId}] RTSP recording stopped`);
  }

  const rtspVideoExists = state.rtspMp4Path && fs.existsSync(state.rtspMp4Path);
  const rtspVideoSize = rtspVideoExists ? fs.statSync(state.rtspMp4Path).size : 0;
  const useRtspVideo = rtspVideoExists && rtspVideoSize > 1024;

  if (!useRtspVideo && (!frames || frames.length < MIN_CLIP_FRAMES)) {
    console.log(`[watcher] [${cameraId}] Skipping clip save — no RTSP video and only ${frames?.length || 0} frames`);
    return null;
  }

  const clipId = state.rtspClipId || uuidv4();
  const dateStr = state.rtspDateStr || new Date().toISOString().slice(0, 10);
  const dir = path.join(CLIPS_DIR, dateStr);
  await fsp.mkdir(dir, { recursive: true });

  const tmpDir = path.join(os.tmpdir(), `clip_${clipId}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  try {
    const mp4Name = useRtspVideo ? state.rtspMp4Name : `clip_${clipId}.mp4`;
    const gifName = `clip_${clipId}.gif`;
    const mp4Path = useRtspVideo ? state.rtspMp4Path : path.join(dir, mp4Name);
    const gifPath = path.join(dir, gifName);

    const durationSec = state.recordingStartTs
      ? Math.round((performance.now() - state.recordingStartTs) / 1000)
      : (frames && frames.length > 1
        ? Math.round((frames[frames.length - 1].ts - frames[0].ts) / 1000)
        : 0);

    if (useRtspVideo) {
      // Mode A: RTSP direct recording — optimize MP4 + generate GIF
      console.log(`[watcher] [${cameraId}] Using RTSP recording: ${state.rtspMp4Name} (${rtspVideoSize} bytes, ~${durationSec}s)`);

      const optimizedMp4Name = `clip_${clipId}.mp4`;
      const optimizedMp4Path = path.join(dir, optimizedMp4Name);

      const pyPath = path.join(__dirname, '..', 'scripts', 'generate_clip.py');
      await new Promise((resolve, reject) => {
        const args = [
          pyPath,
          '--input-video', mp4Path,
          '--output-mp4', optimizedMp4Path,
          '--output-gif', gifPath,
          '--fps', '10',
          '--max-duration', String(MAX_CLIP_DURATION_SEC),
        ];
        const proc = spawn(process.env.PYTHON_PATH || 'python', args);
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else {
            console.warn(`[watcher] generate_clip.py failed (${code}): ${stderr.slice(-300)}`);
            // Fallback: just use the raw RTSP file
            if (mp4Path !== optimizedMp4Path && fs.existsSync(mp4Path)) {
              try { fs.copyFileSync(mp4Path, optimizedMp4Path); } catch (_) { }
            }
            resolve();
          }
        });
        proc.on('error', (err) => {
          console.warn(`[watcher] generate_clip.py spawn error: ${err.message}`);
          if (mp4Path !== optimizedMp4Path && fs.existsSync(mp4Path)) {
            try { fs.copyFileSync(mp4Path, optimizedMp4Path); } catch (_) { }
          }
          resolve();
        });
      });

      // Clean up raw RTSP recording if we created an optimized version
      if (mp4Path !== optimizedMp4Path && fs.existsSync(mp4Path)) {
        try { await fsp.unlink(mp4Path); } catch (_) { }
      }

      const finalMp4Exists = fs.existsSync(optimizedMp4Path);
      const gifExists = fs.existsSync(gifPath);

      const thumbName = `thumb_clip_${clipId}.jpg`;
      const frameName = `frame_clip_${clipId}.jpg`;
      const thumbPath = path.join(UPLOADS_DIR, thumbName);
      const framePath = path.join(UPLOADS_DIR, frameName);

      // Extract thumbnail from the optimized MP4
      if (finalMp4Exists) {
        try {
          await extractThumbnailFromVideo(optimizedMp4Path, framePath, durationSec);
          await sharp(framePath).resize(320, 240, { fit: 'inside' }).toFile(thumbPath);
        } catch (thumbErr) {
          // Fallback to JPEG frames if available
          const midBuffer = frames && frames.length > 0 ? frames[Math.floor(frames.length / 2)].buffer : null;
          if (midBuffer) {
            try {
              await sharp(midBuffer).resize(320, 240, { fit: 'inside' }).toFile(thumbPath);
              await sharp(midBuffer).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 90 }).toFile(framePath);
            } catch (_) { }
          }
        }
      }

      const allTags = [...new Set([...(state.recordedTags || []), ...(state.pendingTags || [])])];

      let clipAnalysis = state.lastAnalysis || {};
      let clipAnalysisTags = [];
      if (fs.existsSync(framePath)) {
        try {
          const ar = await analyzeImage(framePath, { skipPlate: true });
          clipAnalysis = ar.analysis || clipAnalysis;
          clipAnalysisTags = ar.tags || [];
        } catch (_) { }
      }

      const event = await Event.create({
        cameraId: camera._id,
        capturedAt: state.recordingStart || new Date(),
        imagePath: fs.existsSync(framePath) ? frameName : (fs.existsSync(thumbPath) ? thumbName : ''),
        thumbnailPath: fs.existsSync(thumbPath) ? thumbName : '',
        analysis: clipAnalysis,
        tags: [...new Set([...allTags, ...clipAnalysisTags, 'auto-watch', 'recording', 'clip', 'rtsp-quality'])],
        notes: `Auto-recorded RTSP clip (${durationSec}s) by watcher on ${camera.name}`,
        type: 'clip',
        clipDuration: durationSec,
        videoPath: finalMp4Exists ? `clips/${dateStr}/${optimizedMp4Name}` : '',
        gifPath: gifExists ? `clips/${dateStr}/${gifName}` : '',
        recordingStart: state.recordingStart || new Date(),
        recordingEnd: new Date(),
      });

      await Camera.updateOne(
        { _id: camera._id },
        { $inc: { watchEventCount: 1 }, watchLastEventAt: new Date() }
      );

      sendRecordingComplete(String(cameraId), {
        eventId: String(event._id),
        clipDuration: durationSec,
        tags: allTags,
        cameraName: camera.name,
        videoPath: event.videoPath,
        gifPath: event.gifPath,
        thumbnailPath: event.thumbnailPath,
      });

      console.log(`[watcher] RTSP clip saved: ${optimizedMp4Name} (${durationSec}s, quality=rtsp-direct)`);
      return event;

    } else {
      // Mode B: JPEG frame concat (fallback for IP Webcam / when RTSP recording fails)
      if (!frames || frames.length < MIN_CLIP_FRAMES) {
        console.log(`[watcher] [${cameraId}] Skipping JPEG clip — only ${frames?.length || 0} frames`);
        return null;
      }

      // Write frames and build concat list with real timestamps
      const concatListPath = path.join(tmpDir, 'concat.txt');
      const concatLines = [];
      for (let i = 0; i < frames.length; i++) {
        const fname = `frame_${String(i).padStart(5, '0')}.jpg`;
        try { await fsp.writeFile(path.join(tmpDir, fname), frames[i].buffer); } catch (_) { }
        const absPath = path.join(tmpDir, fname).replace(/\\/g, '/');
        concatLines.push(`file '${absPath}'`);
        if (i < frames.length - 1) {
          // Use real time gap between this frame and next
          const gapSec = Math.max(0.04, (frames[i + 1].ts - frames[i].ts) / 1000);
          concatLines.push(`duration ${gapSec.toFixed(3)}`);
        } else {
          // Last frame: hold for 2 seconds
          concatLines.push(`duration 2.000`);
        }
      }
      // FFmpeg concat demuxer needs the last file repeated
      const lastFname = `frame_${String(frames.length - 1).padStart(5, '0')}.jpg`;
      concatLines.push(`file '${path.join(tmpDir, lastFname).replace(/\\/g, '/')}'`);
      await fsp.writeFile(concatListPath, concatLines.join('\n'));

      const mp4Name2 = `clip_${clipId}.mp4`;
      const gifName2 = `clip_${clipId}.gif`;
      const mp4Path2 = path.join(dir, mp4Name2);
      const gifPath2 = path.join(dir, gifName2);

      // Build clip directly with FFmpeg using concat list (real timing)
      await new Promise((resolve, reject) => {
        const ffmpegBin = getFfmpegPath();
        const args = [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', concatListPath,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '20',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          mp4Path2,
        ];
        const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else {
            console.warn(`[watcher] FFmpeg clip concat failed (${code}): ${stderr.slice(-300)}`);
            reject(new Error(`FFmpeg concat failed: ${code}`));
          }
        });
        proc.on('error', (err) => reject(err));
      });

      // Generate GIF from the MP4
      if (fs.existsSync(mp4Path2)) {
        try {
          await new Promise((resolve, reject) => {
            const pyPath = path.join(__dirname, '..', 'scripts', 'generate_clip.py');
            const args = [
              pyPath,
              '--input-video', mp4Path2,
              '--output-mp4', mp4Path2, // overwrite with same path (no-op for mp4)
              '--output-gif', gifPath2,
              '--fps', '5',
              '--max-duration', String(MAX_CLIP_DURATION_SEC),
            ];
            const proc = spawn(process.env.PYTHON_PATH || 'python', args);
            let stderr = '';
            proc.stderr.on('data', (d) => { stderr += d.toString(); });
            proc.on('close', (code) => {
              if (code === 0) resolve();
              else {
                console.warn(`[watcher] GIF generation failed (${code}): ${stderr.slice(-200)}`);
                resolve(); // Don't fail the whole clip save
              }
            });
            proc.on('error', () => resolve());
          });
        } catch (_) {}
      }

      const mp4Exists = fs.existsSync(mp4Path2);
      const gifExists = fs.existsSync(gifPath2);

      const thumbName = `thumb_clip_${clipId}.jpg`;
      const frameName = `frame_clip_${clipId}.jpg`;
      const thumbPath = path.join(UPLOADS_DIR, thumbName);
      const framePath = path.join(UPLOADS_DIR, frameName);
      const midBuffer = frames.length > 0 ? frames[Math.floor(frames.length / 2)].buffer : null;

      if (mp4Exists && midBuffer) {
        try {
          await sharp(midBuffer).resize(320, 240, { fit: 'inside' }).toFile(thumbPath);
        } catch (_) { }
        try {
          await sharp(midBuffer).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 90 }).toFile(framePath);
        } catch (_) { }
      }

      const allTags = [...new Set([...(state.recordedTags || []), ...(state.pendingTags || [])])];

      let clipAnalysis = state.lastAnalysis || {};
      let clipAnalysisTags = [];
      if (fs.existsSync(framePath)) {
        try {
          const ar = await analyzeImage(framePath, { skipPlate: true });
          clipAnalysis = ar.analysis || clipAnalysis;
          clipAnalysisTags = ar.tags || [];
        } catch (_) { }
      }

      const event = await Event.create({
        cameraId: camera._id,
        capturedAt: state.recordingStart || new Date(),
        imagePath: fs.existsSync(framePath) ? frameName : (fs.existsSync(thumbPath) ? thumbName : ''),
        thumbnailPath: fs.existsSync(thumbPath) ? thumbName : '',
        analysis: clipAnalysis,
        tags: [...new Set([...allTags, ...clipAnalysisTags, 'auto-watch', 'recording', 'clip'])],
        notes: `Auto-recorded clip (${durationSec}s) by watcher on ${camera.name}`,
        type: 'clip',
        clipDuration: durationSec,
        videoPath: mp4Exists ? `clips/${dateStr}/${mp4Name2}` : '',
        gifPath: gifExists ? `clips/${dateStr}/${gifName2}` : '',
        recordingStart: state.recordingStart || new Date(),
        recordingEnd: new Date(),
      });

      await Camera.updateOne(
        { _id: camera._id },
        { $inc: { watchEventCount: 1 }, watchLastEventAt: new Date() }
      );

      sendRecordingComplete(String(cameraId), {
        eventId: String(event._id),
        clipDuration: durationSec,
        tags: allTags,
        cameraName: camera.name,
        videoPath: event.videoPath,
        gifPath: event.gifPath,
        thumbnailPath: event.thumbnailPath,
      });

      console.log(`[watcher] Clip saved: ${mp4Name2} (${durationSec}s, ${frames.length} frames)`);
      return event;
    }
  } finally {
    for (const f of fs.readdirSync(tmpDir)) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) { }
    }
    try { fs.rmdirSync(tmpDir); } catch (_) { }
  }
}

// ── Extract thumbnail from video ─────────────────────────────────────────

function extractThumbnailFromVideo(videoPath, outputPath, durationSec) {
  return new Promise((resolve, reject) => {
    const ffmpegBin = getFfmpegPath();
    const dur = Number(durationSec);
    const mid = Number.isFinite(dur) && dur > 0
      ? Math.max(0.1, Math.min(dur * 0.4, dur - 0.1))
      : 0.5;
    const proc = spawn(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error',
      '-y', '-ss', String(mid),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      outputPath,
    ]);
    let errBuf = '';
    proc.stderr.on('data', (d) => { errBuf += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) resolve(outputPath);
      else reject(new Error(errBuf.slice(-200) || `ffmpeg exit ${code}`));
    });
    proc.on('error', reject);
  });
}

// ── Helper: detection tags with filtering ──────────────────────────────────

function detectionTags(result, camera = null) {
  const tags = result?.tags || [];
  const analysis = result?.analysis || {};
  const targets = camera?.watchDetectTargets || ['person', 'vehicle'];
  const minConf = camera?.watchMinConfidence || 0.4;
  const minSize = camera?.watchMinPersonSize || 0;

  const validTags = [];

  if (targets.includes('person') && tags.includes('person')) {
    const persons = analysis.persons || [];
    const qualified = persons.filter((p) => {
      if (p.confidence < minConf) return false;
      if (minSize > 0 && p.bbox) {
        const area = (p.bbox.width || 0) * (p.bbox.height || 0);
        if (area < minSize) return false;
      }
      return true;
    });
    if (qualified.length > 0) validTags.push('person');
  }

  if (targets.includes('vehicle') && tags.includes('vehicle')) {
    const vehicles = analysis.vehicles || [];
    const qualified = vehicles.filter((v) => v.confidence >= minConf);
    if (qualified.length > 0) validTags.push('vehicle');
  }

  return validTags;
}

function mergeTags(existing, incoming) {
  const merged = new Set(existing);
  for (const t of incoming) merged.add(t);
  return [...merged];
}

// ── EZVIZ unified watch cycle — capture + analyze + record in one loop ────

async function ezvizWatchCycle(cameraId) {
  const state = watchers.get(cameraId);
  if (!state || state.stopped === STOP_SIGNAL) return;

  const camera = state.camera;
  if (!camera) return;

  const cycleNum = (state._cycleNum = (state._cycleNum || 0) + 1);

  try {
    // 1. Capture frame — HLS/cloud (RTSP auto-skipped if recently failed)
    console.log(`[watcher] [${cameraId}] EZVIZ cycle #${cycleNum} — capturing...`);
    const captureStart = Date.now();

    // Try RTSP direct first (auto-skipped if cached failure)
    let frameBuf = await captureRtspFrame(camera, 2000);

    // Fallback to HLS/cloud
    if (!frameBuf) {
      frameBuf = await captureOneFrame(camera, {
        useCacheOnFail: true,
        fastMode: true,
        cloudTimeoutMs: 2000,
        hlsTimeoutMs: 2000,
        rtspTimeoutMs: 0,
      });
    }

    const captureMs = Date.now() - captureStart;

    if (!frameBuf) {
      console.log(`[watcher] [${cameraId}] EZVIZ cycle #${cycleNum} — no frame (${captureMs}ms)`);
      scheduleEzvizCycle(cameraId, state, COOLDOWN_MS);
      return;
    }

    console.log(`[watcher] [${cameraId}] EZVIZ cycle #${cycleNum} — frame captured (${frameBuf.length} bytes, ${captureMs}ms)`);
    const entry = { buffer: frameBuf, ts: performance.now() };
    state.ringBuffer.push(entry);
    state.lastFrameAt = Date.now();

    if (state.isRecording) {
      state.pendingFrames.push(entry);
      if (state.pendingFrames.length > MAX_PENDING_FRAMES) {
        state.pendingFrames = state.pendingFrames.slice(-MAX_PENDING_FRAMES);
      }
    }

    // 2. Analyze with YOLO
    const tmpPath = path.join(os.tmpdir(), `ezviz_cycle_${uuidv4()}.jpg`);
    await fsp.writeFile(tmpPath, frameBuf);
    let result;
    try {
      result = await analyzeImage(tmpPath, { skipPlate: true });
    } catch (analyzeErr) {
      console.warn(`[watcher] [${cameraId}] EZVIZ cycle #${cycleNum} analyze failed: ${analyzeErr.message}`);
      scheduleEzvizCycle(cameraId, state, COOLDOWN_MS);
      return;
    } finally {
      try { await fsp.unlink(tmpPath); } catch (_) {}
    }

    const detections = detectionTags(result, camera);
    console.log(`[watcher] [${cameraId}] EZVIZ cycle #${cycleNum} — detections: ${detections.join(',') || 'none'} (recording: ${state.isRecording})`);

    // 3. Handle recording state
    if (state.isRecording) {
      if (detections.length > 0) {
        state.lastDetectionAt = performance.now();
        state.consecutiveNoDetectionCycles = 0;
        state.pendingTags = mergeTags(state.pendingTags, detections);
        state.lastAnalysis = result.analysis || {};

        // Save snapshot photo on every detection
        await saveSnapshotEvent(cameraId, state, camera, frameBuf, result);

        const recordingDuration = (performance.now() - state.recordingStartTs) / 1000;
        if (recordingDuration >= MAX_CLIP_DURATION_SEC) {
          console.log(`[watcher] [${cameraId}] Max clip duration ${MAX_CLIP_DURATION_SEC}s — saving clip`);
          await saveClip(cameraId, state, camera);
          resetRecordingState(state);
        }
      } else {
        if (state.lastDetectionAt !== null) {
          const idleSec = (performance.now() - state.lastDetectionAt) / 1000;
          if (idleSec >= RECORDING_COOLDOWN_SEC) {
            console.log(`[watcher] [${cameraId}] Recording ended (cooldown ${RECORDING_COOLDOWN_SEC}s)`);
            await saveClip(cameraId, state, camera);
            resetRecordingState(state);
            sendRecordingStop(String(cameraId), { cameraName: camera.name });
          }
        } else {
          state.consecutiveNoDetectionCycles = (state.consecutiveNoDetectionCycles || 0) + 1;
          if (state.consecutiveNoDetectionCycles >= RECORDING_MAX_IDLE_CYCLES) {
            console.warn(`[watcher] [${cameraId}] Too many idle cycles — forcing stop`);
            if (state.pendingFrames.length >= MIN_CLIP_FRAMES || state.rtspMp4Path) {
              await saveClip(cameraId, state, camera);
            }
            resetRecordingState(state);
            sendRecordingStop(String(cameraId), { cameraName: camera.name });
          }
        }
      }
    } else {
      // Not recording — check if should start
      if (detections.length > 0) {
        console.log(`[watcher] [${cameraId}] Detection found — starting recording + saving snapshot`);
        const preFrames = state.ringBuffer.getRecent(CLIP_BEFORE_SEC);

        state.isRecording = true;
        state.recordingStart = new Date();
        state.recordingStartTs = performance.now();
        state.lastDetectionAt = performance.now();
        state.pendingFrames = [...preFrames, entry];
        state.pendingTags = [...detections];
        state.recordedTags = [];
        state.lastAnalysis = result.analysis || {};
        state.consecutiveNoDetectionCycles = 0;

        if (isEzvizSerialAddress(camera.ipAddress)) {
          startRtspRecording(cameraId, state, camera).catch((err) => {
            console.warn(`[watcher] [${cameraId}] RTSP recording start failed: ${err.message}`);
          });
        }

        sendRecordingStart(String(cameraId), { cameraName: camera.name, tags: detections });
        await saveSnapshotEvent(cameraId, state, camera, frameBuf, result);

        // Schedule next cycle quickly to keep tracking
        scheduleEzvizCycle(cameraId, state, 1000);
        return;
      }
    }
  } catch (err) {
    console.warn(`[watcher] [${cameraId}] EZVIZ cycle #${cycleNum} error: ${err.message}`);
  }

  // Shorter interval during active recording, normal interval otherwise
  scheduleEzvizCycle(cameraId, state, state.isRecording ? DETECT_INTERVAL_MS : COOLDOWN_MS);
}

function scheduleEzvizCycle(cameraId, state, delayMs) {
  if (!state || state.stopped === STOP_SIGNAL) return;
  state.captureTimer = setTimeout(() => {
    ezvizWatchCycle(cameraId).catch((err) => {
      console.warn(`[watcher] [${cameraId}] ezvizWatchCycle uncaught: ${err.message}`);
      scheduleEzvizCycle(cameraId, state, COOLDOWN_MS);
    });
  }, delayMs);
}

// ── Unified watch cycle — single loop for capture + analyze + record ────────

async function unifiedWatchCycle(cameraId) {
  const state = watchers.get(cameraId);
  if (!state || state.stopped === STOP_SIGNAL) return;

  const camera = state.camera;
  if (!camera) return;

  const cycleNum = (state._cycleNum = (state._cycleNum || 0) + 1);

  try {
    const captureStart = Date.now();
    const frameBuf = await captureOneFrame(camera, {
      useCacheOnFail: true,
      fastMode: false,
    });
    const captureMs = Date.now() - captureStart;

    if (!frameBuf) {
      if (cycleNum <= 3 || cycleNum % 20 === 1) {
        console.log(`[watcher] [${cameraId}] Cycle #${cycleNum} — no frame captured (${captureMs}ms)`);
      }
      scheduleUnifiedCycle(cameraId, state, COOLDOWN_MS);
      return;
    }

    const entry = { buffer: frameBuf, ts: performance.now() };
    state.ringBuffer.push(entry);
    state.lastFrameAt = Date.now();

    if (state.isRecording) {
      state.pendingFrames.push(entry);
      if (state.pendingFrames.length > MAX_PENDING_FRAMES) {
        state.pendingFrames = state.pendingFrames.slice(-MAX_PENDING_FRAMES);
      }
    }

    const tmpPath = path.join(os.tmpdir(), `unified_${uuidv4()}.jpg`);
    await fsp.writeFile(tmpPath, frameBuf);
    let result;
    try {
      result = await analyzeImage(tmpPath, { skipPlate: true });
    } catch (analyzeErr) {
      console.warn(`[watcher] [${cameraId}] Cycle #${cycleNum} analyze failed: ${analyzeErr.message}`);
      scheduleUnifiedCycle(cameraId, state, COOLDOWN_MS);
      return;
    } finally {
      try { await fsp.unlink(tmpPath); } catch (_) {}
    }

    const detections = detectionTags(result, camera);

    if (detections.length > 0) {
      if (cycleNum <= 3 || state._analyzeLogCount % 10 === 0) {
        console.log(`[watcher] [${cameraId}] Cycle #${cycleNum} — detections: ${detections.join(',')} (recording: ${state.isRecording})`);
      }
    } else if (cycleNum <= 3) {
      console.log(`[watcher] [${cameraId}] Cycle #${cycleNum} — no detections`);
    }
    if (!state._analyzeLogCount) state._analyzeLogCount = 0;
    state._analyzeLogCount++;

    if (state.isRecording) {
      if (detections.length > 0) {
        state.lastDetectionAt = performance.now();
        state.consecutiveNoDetectionCycles = 0;
        state.pendingTags = mergeTags(state.pendingTags, detections);
        state.lastAnalysis = result.analysis || {};
        await saveSnapshotEvent(cameraId, state, camera, frameBuf, result);

        const recordingDuration = (performance.now() - state.recordingStartTs) / 1000;
        if (recordingDuration >= MAX_CLIP_DURATION_SEC) {
          console.log(`[watcher] [${cameraId}] Max clip duration ${MAX_CLIP_DURATION_SEC}s — saving clip`);
          await saveClip(cameraId, state, camera);
          resetRecordingState(state);
        }
      } else {
        if (state.lastDetectionAt !== null) {
          const idleSec = (performance.now() - state.lastDetectionAt) / 1000;
          if (idleSec >= RECORDING_COOLDOWN_SEC) {
            console.log(`[watcher] [${cameraId}] Recording ended (cooldown ${RECORDING_COOLDOWN_SEC}s)`);
            await saveClip(cameraId, state, camera);
            resetRecordingState(state);
            sendRecordingStop(String(cameraId), { cameraName: camera.name });
          }
        } else {
          state.consecutiveNoDetectionCycles = (state.consecutiveNoDetectionCycles || 0) + 1;
          if (state.consecutiveNoDetectionCycles >= RECORDING_MAX_IDLE_CYCLES) {
            console.warn(`[watcher] [${cameraId}] Too many idle cycles — forcing stop`);
            if (state.pendingFrames.length >= MIN_CLIP_FRAMES) {
              await saveClip(cameraId, state, camera);
            }
            resetRecordingState(state);
            sendRecordingStop(String(cameraId), { cameraName: camera.name });
          }
        }
      }
      scheduleUnifiedCycle(cameraId, state, state.isRecording ? DETECT_INTERVAL_MS : COOLDOWN_MS);
      return;
    }

    if (detections.length > 0) {
      console.log(`[watcher] [${cameraId}] Detection found — starting recording`);
      const preFrames = state.ringBuffer.getRecent(CLIP_BEFORE_SEC);

      state.isRecording = true;
      state.recordingStart = new Date();
      state.recordingStartTs = performance.now();
      state.lastDetectionAt = performance.now();
      state.pendingFrames = [...preFrames, entry];
      state.pendingTags = [...detections];
      state.recordedTags = [];
      state.lastAnalysis = result.analysis || {};
      state.consecutiveNoDetectionCycles = 0;

      sendRecordingStart(String(cameraId), { cameraName: camera.name, tags: detections });
      await saveSnapshotEvent(cameraId, state, camera, frameBuf, result);

      scheduleUnifiedCycle(cameraId, state, DETECT_INTERVAL_MS);
      return;
    }
  } catch (err) {
    console.warn(`[watcher] [${cameraId}] Cycle #${cycleNum} error: ${err.message}`);
  }

  scheduleUnifiedCycle(cameraId, state, COOLDOWN_MS);
}

function scheduleUnifiedCycle(cameraId, state, delayMs) {
  if (!state || state.stopped === STOP_SIGNAL) return;
  state.captureTimer = setTimeout(() => {
    unifiedWatchCycle(cameraId).catch((err) => {
      console.warn(`[watcher] [${cameraId}] unifiedWatchCycle uncaught: ${err.message}`);
      scheduleUnifiedCycle(cameraId, state, COOLDOWN_MS);
    });
  }, delayMs);
}

// ── Save snapshot event ────────────────────────────────────────────────────

async function saveSnapshotEvent(cameraId, state, camera, frameBuf, result) {
  try {
    const snapFilename = `watch_${uuidv4()}.jpg`;
    const snapFilepath = path.join(UPLOADS_DIR, snapFilename);
    await fsp.writeFile(snapFilepath, frameBuf);

    const snapThumbName = `thumb_${snapFilename}`;
    const snapThumbPath = path.join(UPLOADS_DIR, snapThumbName);
    try {
      await sharp(snapFilepath).resize(320, 240, { fit: 'inside' }).toFile(snapThumbPath);
    } catch (_) { }

    // Save high-quality version
    try {
      await sharp(snapFilepath)
        .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 92 })
        .toFile(snapFilepath + '.hq.jpg');
      await fsp.rename(snapFilepath + '.hq.jpg', snapFilepath);
    } catch (_) { }

    const snapEvent = await Event.create({
      cameraId: camera._id,
      capturedAt: new Date(),
      imagePath: snapFilename,
      thumbnailPath: snapThumbName,
      analysis: result.analysis || {},
      tags: [...(result.tags || []), 'auto-watch'],
      notes: `Auto-detected by watcher on ${camera.name}`,
    });

    await Camera.updateOne(
      { _id: camera._id },
      { $inc: { watchEventCount: 1 }, watchLastEventAt: new Date() }
    );

    state.lastEventAt = new Date();

    const { sendWatcherEvent: swe } = require('./sse');
    swe(String(cameraId), {
      eventId: String(snapEvent._id),
      tags: snapEvent.tags,
      imagePath: snapFilename,
      thumbnailPath: snapThumbName,
      cameraName: camera.name,
      capturedAt: snapEvent.capturedAt,
      analysis: result.analysis || {},
    });
  } catch (snapErr) {
    console.warn(`[watcher] [${cameraId}] Failed to save snapshot: ${snapErr.message}`);
  }
}

// ── Reset recording state ────────────────────────────────────────────────────

function resetRecordingState(state) {
  if (state.rtspProc) {
    stopRtspRecording(state);
  }
  state.isRecording = false;
  state.pendingFrames = [];
  state.pendingTags = [];
  state.recordedTags = [];
  state.recordingStart = null;
  state.recordingStartTs = null;
  state.lastDetectionAt = null;
  state.recordingType = null;
  state.consecutiveNoDetectionCycles = 0;
  state.rtspProc = null;
  state.rtspClipId = null;
  state.rtspMp4Path = null;
  state.rtspMp4Name = null;
  state.rtspDateStr = null;
  state.rtspStartedAt = null;
  state.rtspLabel = null;
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

async function cleanupFile(filePath) {
  const key = filePath.toLowerCase();
  if (cleanupInProgress.has(key)) return;
  cleanupInProgress.add(key);
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[watcher] Failed to delete ${filePath}:`, err.message);
    }
  } finally {
    cleanupInProgress.delete(key);
  }
}

// ── Start / Stop ────────────────────────────────────────────────────────────

async function startWatch(cameraId, opts = {}) {
  if (watchers.has(cameraId)) {
    console.warn(`[watcher] Already watching camera ${cameraId}`);
    return { already: true };
  }

  ensureCacheDir();
  ensureClipsDir();

  const camera = await Camera.findById(cameraId).catch(() => null);
  if (!camera || !camera.ipAddress) {
    console.warn(`[watcher] Camera ${cameraId} not found or has no IP`);
    return { error: 'Camera not found or has no IP' };
  }

  const useIpWebcam = isIpWebcamAddress(camera.ipAddress);

  const buf = getBuffer(cameraId, { fps: 5, bufferSeconds: 30 });

  const state = {
    camera,
    ringBuffer: buf,
    startedAt: new Date(),
    stopped: undefined,
    isRecording: false,
    recordingStart: null,
    recordingStartTs: null,
    lastDetectionAt: null,
    pendingFrames: [],
    pendingTags: [],
    recordedTags: [],
    recordingType: null,
    lastAnalysis: null,
    consecutiveNoDetectionCycles: 0,
    captureTimer: null,
    lastFrameAt: Date.now(),
    // RTSP recording state
    rtspProc: null,
    rtspClipId: null,
    rtspMp4Path: null,
    rtspMp4Name: null,
    rtspDateStr: null,
    rtspStartedAt: null,
    rtspLabel: null,
  };

  watchers.set(cameraId, state);

  console.log(`[watcher] Starting for camera ${cameraId} (${camera.name}) — ${useIpWebcam ? 'IP Webcam' : 'EZVIZ'}`);
  console.log(`[watcher] Detection config: targets=${(camera.watchDetectTargets || ['person', 'vehicle']).join(',')}, minConf=${camera.watchMinConfidence || 0.4}, minSize=${camera.watchMinPersonSize || 0}`);

  if (!useIpWebcam) {
    // ── EZVIZ: unified watch cycle ──
    if (isEzvizSerialAddress(camera.ipAddress)) {
      const result = startStreamBridge(cameraId, camera);
      if (!result.already) {
        console.log(`[watcher] Stream bridge started for ${cameraId} (background, for live preview)`);
      }
    }

    const firstDelay = opts.skipImmediateCapture ? 5000 : 0;
    scheduleEzvizCycle(cameraId, state, firstDelay);
  } else {
    // ── IP Webcam: unified watch cycle (same as EZVIZ) ──
    console.log(`[watcher] Using unified cycle for IP Webcam (${camera.ipAddress})`);
    scheduleUnifiedCycle(cameraId, state, opts.skipImmediateCapture ? 5000 : 0);
  }

  return { started: true };
}

async function stopWatch(cameraId) {
  const state = watchers.get(cameraId);
  if (!state) return { already: true };

  state.stopped = STOP_SIGNAL;
  clearTimeout(state.captureTimer);

  // Stop RTSP recording if active
  if (state.rtspProc) {
    stopRtspRecording(state);
  }

  if (state.isRecording) {
    const camera = await Camera.findById(cameraId).catch(() => null);
    if (camera) {
      await saveClip(cameraId, state, camera);
    }
    sendRecordingStop(String(cameraId), {});
  }

  watchers.delete(cameraId);
  stopStreamBridge(cameraId);

  const tmpFiles = fs.readdirSync(UPLOADS_DIR).filter((f) => f.startsWith('watch_tmp_'));
  for (const f of tmpFiles) {
    cleanupFile(path.join(UPLOADS_DIR, f)).catch(() => { });
  }

  console.log(`[watcher] Stopped for camera ${cameraId}`);
  return { stopped: true };
}

async function getStatus() {
  const result = [];
  for (const [cameraId, state] of watchers) {
    const camera = await Camera.findById(cameraId).select('watchEventCount watchLastEventAt').catch(() => null);
    result.push({
      cameraId,
      startedAt: state.startedAt,
      eventCount: camera?.watchEventCount || 0,
      lastEventAt: camera?.watchLastEventAt || state.lastEventAt,
      isRecording: state.isRecording,
      recordingStart: state.recordingStart,
      recordingType: state.rtspProc ? 'rtsp-direct' : (state.isRecording ? 'jpeg-frames' : state.recordingType),
      rtspActive: Boolean(state.rtspProc),
    });
  }
  sendWatcherStatus(result);
  return result;
}

function isWatching(cameraId) {
  return watchers.has(cameraId);
}

async function getRecordingStatus() {
  const result = [];
  for (const [cameraId, state] of watchers) {
    if (state.isRecording) {
      const camera = await Camera.findById(cameraId).select('name').catch(() => null);
      result.push({
        cameraId,
        cameraName: camera?.name || cameraId,
        recordingStart: state.recordingStart,
        recordingType: state.rtspProc ? 'rtsp-direct' : 'jpeg-frames',
        pendingTags: state.pendingTags,
        frameCount: state.pendingFrames.length,
        durationSec: state.recordingStartTs
          ? Math.round((performance.now() - state.recordingStartTs) / 1000)
          : 0,
        rtspActive: Boolean(state.rtspProc),
      });
    }
  }
  return result;
}

async function getClips(cameraId) {
  const query = { type: 'clip' };
  if (cameraId) query.cameraId = cameraId;
  return Event.find(query)
    .sort({ capturedAt: -1 })
    .limit(100)
    .populate('cameraId', 'name location');
}

async function deleteClip(clipId) {
  const event = await Event.findById(clipId);
  if (!event) throw new Error('Clip not found');

  const toDelete = [event.videoPath, event.gifPath, event.imagePath, event.thumbnailPath].filter(Boolean);
  for (const relPath of toDelete) {
    const fullPath = path.join(UPLOADS_DIR, relPath);
    try { await fsp.unlink(fullPath); } catch (_) { }
  }

  await Event.deleteOne({ _id: clipId });
  return { deleted: true };
}

async function reanalyzeClip(clipId) {
  const event = await Event.findById(clipId);
  if (!event) throw new Error('Clip not found');
  const result = await analyzeEventMedia(event);
  event.analysis = result.analysis;
  event.tags = [...new Set([...event.tags.filter((t) => !['person', 'vehicle', 'plate'].includes(t)), ...result.tags])];
  await event.save();
  await event.populate('cameraId', 'name location');
  return event;
}

async function restoreWatchers() {
  try {
    ensureCacheDir();
    const cameras = await Camera.find({ autoWatch: true, ipAddress: { $ne: '' } });
    const supported = cameras.filter(
      (c) => isIpWebcamAddress(c.ipAddress) || isEzvizSerialAddress(c.ipAddress)
    );
    if (supported.length === 0) {
      console.log('[watcher] No auto-watch cameras to restore');
      return;
    }
    console.log(`[watcher] Restoring auto-watch for ${supported.length} camera(s)...`);
    for (let i = 0; i < supported.length; i++) {
      const cam = supported[i];
      const camId = cam._id.toString();
      if (!watchers.has(camId)) {
        const delay = 3000 + i * 2000;
        console.log(`[watcher] Will restore "${cam.name}" in ${delay}ms`);
        setTimeout(() => {
          if (!watchers.has(camId)) {
            console.log(`[watcher] Restoring auto-watch for "${cam.name}" (${cam._id})`);
            startWatch(camId, { skipImmediateCapture: true });
          }
        }, delay);
      }
    }
  } catch (err) {
    console.warn('[watcher] Failed to restore watchers:', err.message);
  }
}

module.exports = {
  startWatch,
  stopWatch,
  getStatus,
  isWatching,
  restoreWatchers,
  getRecordingStatus,
  getClips,
  deleteClip,
  reanalyzeClip,
};
