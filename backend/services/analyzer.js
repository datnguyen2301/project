const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const ANALYZER_URL = `http://127.0.0.1:${process.env.ANALYZER_PORT || 5100}`;
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function extractClipRepresentativeFrame(videoAbsPath, clipDurationSec) {
  const outPath = path.join(os.tmpdir(), `clip_an_${uuidv4()}.jpg`);
  const dur = Number(clipDurationSec);
  const mid = Number.isFinite(dur) && dur > 0
    ? Math.max(0.05, Math.min(dur * 0.5, dur - 0.04))
    : 0.5;
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-ss', String(mid),
      '-i', videoAbsPath,
      '-vframes', '1',
      '-q:v', '2',
      outPath,
    ]);
    let errBuf = '';
    proc.stderr.on('data', (d) => { errBuf += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
      else reject(new Error(errBuf.slice(-200) || `ffmpeg exit ${code}`));
    });
    proc.on('error', reject);
  });
}

let analyzerAvailable = null;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 30000;

async function checkHealth() {
  const now = Date.now();
  if (analyzerAvailable === true && now - lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) {
    return true;
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${ANALYZER_URL}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      lastHealthCheck = now;
      if (analyzerAvailable !== true) {
        analyzerAvailable = true;
        console.log(`[analyzer] Health OK — warmed_up=${json.warmed_up}, model_loaded=${json.model_loaded}`);
      }
      return true;
    }
  } catch (_) {}
  if (analyzerAvailable !== false) {
    analyzerAvailable = false;
    console.warn('[analyzer] Health check failed — server may be offline');
  }
  return false;
}

async function analyzeImageImmediate(imagePath, opts = {}) {
  const { skipPlate = false } = opts;
  // No health check — call analyzer server directly with a short timeout
  // This is for the "immediate" path where we want speed over robustness
  const ANALYZER_TIMEOUT_MS = 15000;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ANALYZER_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(ANALYZER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imagePath, skip_plate: skipPlate }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      return fallback();
    }

    const json = await res.json().catch(() => null);
    if (!json || !json.ok || !json.data?.analysis) {
      return fallback();
    }
    return json.data;
  } catch (err) {
    return fallback();
  }
}

async function analyzeImage(imagePath, opts = {}) {
  const { skipPlate = false } = opts;

  if (analyzerAvailable === null) {
    await checkHealth();
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    let res;
    try {
      res = await fetch(ANALYZER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imagePath, skip_plate: skipPlate }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      console.warn(`[analyzer] HTTP ${res.status}, using fallback`);
      return fallback();
    }

    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      console.warn(`[analyzer] Response error: ${json?.error || 'invalid JSON or ok=false'}`);
      return fallback();
    }

    const data = json.data;
    if (!data || !data.analysis) {
      console.warn(`[analyzer] Missing analysis data in response`);
      return fallback();
    }

    // Empty analysis results are valid — don't treat as failure
    if (analyzerAvailable !== true) {
      analyzerAvailable = true;
      console.log('[analyzer] Connected successfully');
    }

    return data;
  } catch (err) {
    if (analyzerAvailable !== false) {
      console.warn('[analyzer] Unavailable, using fallback:', err.message);
      analyzerAvailable = false;
    }
    return fallback();
  }
}

function fallback() {
  return {
    analysis: { persons: [], vehicles: [], licensePlates: [] },
    tags: [],
  };
}

async function analyzeEventMedia(event) {
  if (event.type === 'clip' && event.videoPath) {
    const vp = path.join(UPLOADS_DIR, event.videoPath);
    if (fs.existsSync(vp)) {
      let tmp;
      try {
        tmp = await extractClipRepresentativeFrame(vp, event.clipDuration);
        const out = await analyzeImage(tmp);
        return out;
      } catch (err) {
        console.warn('[analyzer] clip frame extract failed:', err.message);
      } finally {
        if (tmp) {
          try { fs.unlinkSync(tmp); } catch (_) {}
        }
      }
    }
  }
  if (!event.imagePath) return fallback();
  return analyzeImage(path.join(UPLOADS_DIR, event.imagePath));
}

module.exports = { analyzeImage, analyzeImageImmediate, analyzeEventMedia, checkHealth };
