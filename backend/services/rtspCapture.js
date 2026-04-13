const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ezviz = require('./ezviz');

const STREAMS_DIR = path.join(__dirname, '..', 'streams');

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

function buildCandidates({ localIp, rtspPort, camKey }) {
  const port = rtspPort || '554';
  const key = String(camKey || '').trim();

  const suffixes = [];
  // Known-working path first (H.264 main stream)
  suffixes.push(
    { type: 'h264_main', path: '/h264/ch1/main/av_stream' },
    { type: 'h264_sub', path: '/h264/ch1/sub/av_stream' },
  );
  // EZVIZ-style paths — only if camKey looks like a channel index
  if (key && /^\d+$/.test(key)) {
    suffixes.push(
      { type: 'ezviz_main', path: `/ch${key}/main/av_stream` },
      { type: 'ezviz_sub', path: `/ch${key}/sub/av_stream` },
    );
  }
  suffixes.push(
    { type: 'h265_main', path: '/h265/ch1/main/av_stream' },
    { type: 'h265_sub', path: '/h265/ch1/sub/av_stream' },
    { type: 'chan101', path: '/Streaming/Channels/101' },
    { type: 'chan102', path: '/Streaming/Channels/102' },
    { type: 'dahua_main', path: '/cam/realmonitor?channel=1&subtype=0' },
    { type: 'dahua_sub', path: '/cam/realmonitor?channel=1&subtype=1' },
    { type: 'live', path: '/live' },
    { type: 'generic_stream', path: '/stream' },
  );

  const base = rtspBase(localIp, port, key);
  const seen = new Set();
  const out = [];
  for (const { type, path: p } of suffixes) {
    const url = `${base}${p}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ type, url });
  }
  return out;
}

function buildFastCandidates({ localIp, rtspPort, camKey }) {
  // Prioritized shortlist: sub streams first (faster), known-good paths for this camera
  const port = rtspPort || '554';
  const key = String(camKey || '').trim();

  const candidates = [];

  // Known-working path first (H.264 main stream)
  candidates.push(
    { type: 'h264_main', url: `${rtspBase(localIp, port, key)}/h264/ch1/main/av_stream` },
    { type: 'h264_sub', url: `${rtspBase(localIp, port, key)}/h264/ch1/sub/av_stream` },
  );

  // EZVIZ-style — only if camKey looks like a channel index
  if (key && /^\d+$/.test(key)) {
    candidates.push(
      { type: 'ezviz_main', url: `${rtspBase(localIp, port, key)}/ch${key}/main/av_stream` },
      { type: 'ezviz_sub', url: `${rtspBase(localIp, port, key)}/ch${key}/sub/av_stream` },
    );
  }

  candidates.push(
    { type: 'h265_main', url: `${rtspBase(localIp, port, key)}/h265/ch1/main/av_stream` },
    { type: 'h265_sub', url: `${rtspBase(localIp, port, key)}/h265/ch1/sub/av_stream` },
    { type: 'chan101', url: `${rtspBase(localIp, port, key)}/Streaming/Channels/101` },
    { type: 'chan102', url: `${rtspBase(localIp, port, key)}/Streaming/Channels/102` },
    { type: 'dahua_main', url: `${rtspBase(localIp, port, key)}/cam/realmonitor?channel=1&subtype=0` },
    { type: 'dahua_sub', url: `${rtspBase(localIp, port, key)}/cam/realmonitor?channel=1&subtype=1` },
    { type: 'live', url: `${rtspBase(localIp, port, key)}/live` },
    { type: 'generic_stream', url: `${rtspBase(localIp, port, key)}/stream` },
  );

  return candidates;
}

function tryFfmpegOneFrame(rtspUrl, destPath, timeoutMs, rtspTransport = 'tcp') {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegPath();
    // Try H.264/AVC first, then H.265/HEVC. Some FFmpeg builds lack H.265 support on Windows.
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-rtsp_transport', rtspTransport,
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-max_delay', '5000000',
      '-i', rtspUrl,
      '-frames:v', '1',
      '-q:v', '3',
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

async function tryUrlWithTransports(url, destPath, timeoutMs) {
  // Sequential: TCP then UDP, both H.264 then H.265 via libx265
  for (const transport of ['tcp', 'udp']) {
    const { ok, stderr } = await tryFfmpegOneFrame(url, destPath, timeoutMs, transport);
    if (ok) return { ok: true, stderr: '' };
    if (stderr && stderr !== 'timeout') {
      // Non-timeout error on TCP: likely codec issue, try H.265 software decode
      const hevcFallback = await tryFfmpegOneFrameH265(url, destPath, timeoutMs, transport);
      if (hevcFallback.ok) return { ok: true, stderr: '' };
    }
  }
  return { ok: false, stderr: 'all transports failed' };
}

function tryFfmpegOneFrameH265(rtspUrl, destPath, timeoutMs, rtspTransport = 'tcp') {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegPath();
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-rtsp_transport', rtspTransport,
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-max_delay', '5000000',
      '-i', rtspUrl,
      '-c:v', 'libx265',
      '-frames:v', '1',
      '-q:v', '3',
      '-y',
      destPath,
    ];
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      try { fs.unlinkSync(destPath); } catch (_) {}
      resolve({ ok: false, stderr: 'h265_timeout' });
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
          resolve({ ok: false, stderr: 'h265_empty_output' });
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

async function captureRtspJpegToFile(camera, destPath, opts = {}) {
  const {
    timeoutPerUrlMs = 8000,
    onAttempt,
    parallel = false,
    parallelFallbackLimit = 3,
    fallbackTimeoutMs = 2500,
    totalBudgetMs = 12000,
  } = opts;

  const serial = String(camera.ipAddress || '').trim();

  const hasLocalRtsp = Boolean(String(camera.rtspHost || '').trim());
  const hasVerify = Boolean(String(camera.verifyCode || '').trim());

  let streamInfo;
  if (hasLocalRtsp && hasVerify) {
    const raw = String(camera.rtspHost).trim();
    const [host, portPart] = raw.includes(':') ? raw.split(':') : [raw, '554'];
    streamInfo = {
      localIp: host.trim(),
      rtspPort: (portPart || '554').trim(),
      camKey: String(camera.verifyCode).trim(),
    };
    console.log(`[rtspCapture] Using DB rtspHost: ${streamInfo.localIp}:${streamInfo.rtspPort}`);
  } else {
    try {
      streamInfo = await ezviz.getRtspInfo(serial, { timeout: 12_000 });
      if (camera.verifyCode) streamInfo.camKey = String(camera.verifyCode).trim();
    } catch (err) {
      console.warn(`[rtspCapture] getRtspInfo(${serial}): ${err.message}`);
      return false;
    }
  }

  if (!streamInfo.camKey) {
    console.warn('[rtspCapture] No Verify Code — RTSP auth will fail for EZVIZ');
  }

  const candidates = buildFastCandidates(streamInfo);
  console.log(`[rtspCapture] Probing ${candidates.length} URLs → ${streamInfo.localIp}:${streamInfo.rtspPort || 554} (TCP+UDP each, sub-first)`);

  if (parallel) {
    const fastCandidates = candidates.slice(0, Math.min(candidates.length, 1 + parallelFallbackLimit));
    const runOne = async (c, idx) => {
      const timeout = idx === 0 ? timeoutPerUrlMs : fallbackTimeoutMs;
      const tmpDest = path.join(
        os.tmpdir(),
        `vg_rtsp_par_${process.pid}_${idx}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.jpg`
      );
      try {
        const r = await Promise.race([
          tryFfmpegOneFrame(c.url, tmpDest, timeout, 'tcp').then((res) => ({ ...res, type: c.type, tmpDest })),
          new Promise((resolve) =>
            setTimeout(() => resolve({ ok: false, stderr: 'timeout', type: c.type, tmpDest }), timeout)
          ),
        ]);
        return { ...r, tmpDest };
      } catch (e) {
        return { ok: false, stderr: String(e.message), type: c.type, tmpDest };
      }
    };

    const results = await Promise.all(fastCandidates.map((c, idx) => runOne(c, idx)));
    const winner = results.find((r) => r && r.ok && r.tmpDest);

    if (winner && winner.tmpDest) {
      try {
        fs.copyFileSync(winner.tmpDest, destPath);
      } catch (e) {
        console.warn(`[rtspCapture] parallel copy: ${e.message}`);
      }
    }

    for (const r of results) {
      if (!r.tmpDest) continue;
      try {
        if (fs.existsSync(r.tmpDest)) fs.unlinkSync(r.tmpDest);
      } catch (_) {}
    }

    if (winner && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      const size = fs.statSync(destPath).size;
      console.log(`[rtspCapture] Parallel OK via ${winner.type}, size=${size}`);
      return true;
    }

    const hasValidPath = streamInfo.localIp &&
      (streamInfo.localIp.startsWith('192.168.') || streamInfo.localIp.startsWith('10.') || streamInfo.localIp.startsWith('172.'));
    if (hasValidPath) {
      console.warn(`[rtspCapture] All parallel candidates failed for "${serial}"`);
    }
    return false;
  }

  // Full mode: try all candidates with TCP + UDP, long timeout
  const budgetStart = totalBudgetMs > 0 ? Date.now() : 0;
  for (const c of candidates) {
    if (totalBudgetMs > 0 && Date.now() - budgetStart >= totalBudgetMs) {
      console.log(`[rtspCapture] Total budget (${totalBudgetMs}ms) exceeded — giving up`);
      break;
    }
    if (onAttempt) onAttempt(c);
    const { ok: okTcp, stderr: errTcp } = await tryFfmpegOneFrame(c.url, destPath, timeoutPerUrlMs, 'tcp');
    if (okTcp) {
      const size = fs.statSync(destPath).size;
      console.log(`[rtspCapture] OK via ${c.type} (TCP), size=${size}`);
      return true;
    }
    if (errTcp === 'timeout') {
      console.log(`[rtspCapture] ${c.type} (TCP): timeout after ${timeoutPerUrlMs}ms`);
    } else if (errTcp) {
      console.warn(`[rtspCapture] ${c.type} (TCP): ${String(errTcp).slice(0, 200)}`);
    }

    if (totalBudgetMs > 0 && Date.now() - budgetStart >= totalBudgetMs) {
      console.log(`[rtspCapture] Budget exhausted after TCP for ${c.type}`);
      break;
    }
    const { ok: okUdp, stderr: errUdp } = await tryFfmpegOneFrame(c.url, destPath, timeoutPerUrlMs, 'udp');
    if (okUdp) {
      const size = fs.statSync(destPath).size;
      console.log(`[rtspCapture] OK via ${c.type} (UDP), size=${size}`);
      return true;
    }
    if (errUdp === 'timeout') {
      console.log(`[rtspCapture] ${c.type} (UDP): timeout after ${timeoutPerUrlMs}ms`);
    } else if (errUdp) {
      console.warn(`[rtspCapture] ${c.type} (UDP): ${String(errUdp).slice(0, 200)}`);
    }
  }

  const hasValidPath = streamInfo.localIp &&
    (streamInfo.localIp.startsWith('192.168.') || streamInfo.localIp.startsWith('10.') || streamInfo.localIp.startsWith('172.'));
  if (hasValidPath) {
    console.warn(`[rtspCapture] All ${candidates.length} candidates failed for "${serial}" (IP=${streamInfo.localIp}).`);
    console.warn(`[rtspCapture] Suggestions: 1) Verify camera RTSP is enabled in its web UI. 2) Check firewall allows port ${streamInfo.rtspPort || 554}. 3) Confirm verifyCode is correct. 4) Try opening rtsp://${streamInfo.localIp}:${streamInfo.rtspPort || 554} in VLC to validate.`);
  } else {
    console.warn(`[rtspCapture] All attempts failed for "${serial}" — IP "${streamInfo.localIp}" may not be reachable from this machine.`);
  }
  return false;
}

async function captureFromHlsSegment(cameraId, destPath, timeoutMs = 8000) {
  const { spawn } = require('child_process');
  const ffmpegBin = getFfmpegPath();
  const outDir = path.join(STREAMS_DIR, cameraId);
  const hlsM3u8 = path.join(outDir, 'stream.m3u8');

  return new Promise((resolve) => {
    // Check HLS manifest exists and has .ts files
    if (!fs.existsSync(hlsM3u8)) {
      resolve({ ok: false, stderr: 'no_hls_manifest' });
      return;
    }

    const tsFiles = fs.readdirSync(outDir).filter((f) => f.endsWith('.ts'));
    if (tsFiles.length === 0) {
      resolve({ ok: false, stderr: 'no_ts_segments' });
      return;
    }

    // Pick the most recent .ts segment (sorted by name, which is seg_XXX.ts with increasing numbers)
    const latestTs = tsFiles.sort().at(-1);
    const tsPath = path.join(outDir, latestTs);

    // Also check the m3u8 to know which .ts is the "current" one being written
    try {
      const m3u8 = fs.readFileSync(hlsM3u8, 'utf8');
      const segMatches = m3u8.match(/seg_\d+\.ts/g);
      if (segMatches && segMatches.length > 0) {
        const currentTs = segMatches[segMatches.length - 1];
        const currentTsPath = path.join(outDir, currentTs);
        if (fs.existsSync(currentTsPath)) {
          // Use the last segment referenced in the manifest (most recent)
        }
      }
    } catch (_) {}

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', tsPath,
      '-frames:v', '1',
      '-q:v', '3',
      '-y',
      destPath,
    ];

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      try { fs.unlinkSync(destPath); } catch (_) {}
      resolve({ ok: false, stderr: 'hls_timeout' });
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
          resolve({ ok: false, stderr: 'hls_empty_output' });
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

async function probeRtspSnapshot(camera, timeoutPerUrlMs = 16000) {
  const tmp = path.join(os.tmpdir(), `vg_rtsp_probe_${process.pid}_${Date.now()}.jpg`);
  try {
    return await captureRtspJpegToFile(camera, tmp, { timeoutPerUrlMs, parallel: true });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

module.exports = { captureRtspJpegToFile, probeRtspSnapshot, captureFromHlsSegment };
