const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const Camera = require('../models/Camera');
const ezviz = require('./ezviz');
const { isIpWebcamAddress } = require('../utils/cameraAddress');

function getFfmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function getFfprobePath() {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

const STREAMS_DIR = path.join(__dirname, '..', 'streams');
if (!fs.existsSync(STREAMS_DIR)) fs.mkdirSync(STREAMS_DIR, { recursive: true });

const streams = new Map();

function hlsUrl(cameraId) {
  return `/streams/${cameraId}/stream.m3u8`;
}

function checkTcpReachable(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.connect(Number(port), host, () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => { clearTimeout(timer); sock.destroy(); resolve(false); });
  });
}

function hlsManifestExists(m3u8Path) {
  return fs.existsSync(m3u8Path);
}

async function startStream(cameraId) {
  if (streams.has(cameraId)) {
    return { already: true, hlsUrl: hlsUrl(cameraId) };
  }

  const camera = await Camera.findById(cameraId);
  if (!camera?.ipAddress) throw new Error('Camera not found or has no address');

  if (isIpWebcamAddress(camera.ipAddress)) {
    throw new Error('IP Webcam đã hỗ trợ MJPEG stream; không cần FFmpeg HLS.');
  }

  let streamInfo;
  if (camera.rtspHost) {
    const [host, port] = camera.rtspHost.split(':');
    streamInfo = { localIp: host, rtspPort: port || '554', camKey: camera.verifyCode || '' };
    console.log(`[stream] Using local rtspHost: ${host}:${streamInfo.rtspPort}`);
  } else {
    console.log(`[stream] Fetching stream info from EZVIZ cloud for ${camera.ipAddress}...`);
    streamInfo = await ezviz.getRtspInfo(camera.ipAddress);
    if (streamInfo.isLocalIpValid === false) {
      console.warn(`[stream] WARNING: EZVIZ returned local_ip="${streamInfo.localIp}" for ${camera.ipAddress}. Camera may be unreachable.`);
    }
    if (camera.verifyCode) streamInfo.camKey = camera.verifyCode;
  }

  console.log(`[stream] Info: ip=${streamInfo.localIp} port=${streamInfo.rtspPort} camKey=${streamInfo.camKey ? `${streamInfo.camKey.slice(0, 2)}***` : '(none)'}`);

  const candidates = buildCandidates(streamInfo);

  const tcpCheckStart = Date.now();
  const reachable = await checkTcpReachable(streamInfo.localIp, Number(streamInfo.rtspPort || 554), 2000);
  console.log(`[stream] TCP ${streamInfo.localIp}:${streamInfo.rtspPort || 554} → ${reachable ? 'OPEN' : 'REFUSED'} (${Date.now() - tcpCheckStart}ms)`);

  if (!reachable) {
    console.warn(`[stream] TCP port check failed — proceeding anyway (some cameras reject raw TCP but accept RTSP)`);
  }

  // ── Direct FFmpeg — skip ffprobe for fastest startup ───────────────
  const streamStart = Date.now();
  console.log(`[stream] Starting FFmpeg directly (${candidates.length} candidates, no ffprobe)...`);

  for (const candidate of candidates) {
    console.log(`[stream] Trying: ${candidate.type}`);
    try {
      const result = await startFfmpegHls(cameraId, candidate);
      console.log(`[stream] HLS ready in ${Date.now() - streamStart}ms total`);
      return result;
    } catch (err) {
      console.warn(`[stream] ${candidate.type} failed: ${err.message}`);
    }
  }

  throw new Error(
    `Không kết nối được camera RTSP.\n` +
    `Kiểm tra Verify Code và RTSP đã bật trong EZVIZ App.`
  );
}

function buildCandidates(info) {
  const { localIp, rtspPort, camKey } = info;
  const port = rtspPort || '554';
  const auth = camKey ? `admin:${camKey}@` : '';
  const base = `rtsp://${auth}${localIp}:${port}`;
  const candidates = [];

  candidates.push({ type: 'h264_main_udp', url: `${base}/h264/ch1/main/av_stream` });

  if (camKey && /^\d+$/.test(camKey)) {
    candidates.push({ type: 'ezviz_main', url: `${base}/ch${camKey}/main/av_stream` });
    candidates.push({ type: 'ezviz_sub', url: `${base}/ch${camKey}/sub/av_stream` });
  }

  const genericPaths = [
    '/h264/ch1/sub/av_stream',
    '/h265/ch1/main/av_stream',
    '/h265/ch1/sub/av_stream',
    '/Streaming/Channels/101',
    '/Streaming/Channels/102',
    '/cam/realmonitor?channel=1&subtype=0',
    '/cam/realmonitor?channel=1&subtype=1',
  ];
  for (const p of genericPaths) {
    candidates.push({ type: `generic${p}`, url: `${base}${p}` });
  }

  return candidates;
}

function probeWithFfprobe(rtspUrl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ffprobeBin = getFfprobePath();
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-rtsp_transport', 'tcp',
      '-timeout', String(timeoutMs * 1000),
      rtspUrl,
    ];
    const proc = spawn(ffprobeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutData = '';
    let stderrData = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGTERM'); } catch (_) {}
      reject(new Error('ffprobe timeout'));
    }, timeoutMs + 1000);

    proc.stdout.on('data', (chunk) => { stdoutData += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code === 0) {
        try {
          const info = JSON.parse(stdoutData);
          const videoStream = info.streams?.find((s) => s.codec_type === 'video');
          if (!videoStream) {
            reject(new Error('No video stream found'));
            return;
          }
          const codec = videoStream.codec_name || '';
          const hasHevc = ['hevc', 'h265'].includes(codec.toLowerCase());
          console.log(`[stream] ffprobe OK — codec=${codec}, hevc=${hasHevc}`);
          resolve({ codec, hasHevc });
        } catch (parseErr) {
          reject(new Error(`ffprobe JSON parse error: ${parseErr.message}`));
        }
      } else {
        const err = extractFfprobeError(stderrData, stdoutData, code);
        reject(new Error(err));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (err.code === 'ENOENT') {
        reject(new Error('ffprobe not found. Install ffmpeg (includes ffprobe) and add to PATH.'));
      } else {
        reject(new Error(`ffprobe error: ${err.message}`));
      }
    });
  });
}

function extractFfprobeError(stderr, stdout, exitCode) {
  const s = (stderr + stdout).toLowerCase();
  if (s.includes('connection refused')) return 'Connection refused — port không mở hoặc sai port';
  if (s.includes('no route to host')) return 'No route to host — camera không truy cập được từ server';
  if (s.includes('connection timed out') || s.includes('timeout')) return 'Connection timeout — firewall chặn hoặc camera không phản hồi';
  if (s.includes('401') || s.includes('unauthorized')) return 'Unauthorized — Verify Code sai';
  if (s.includes('403')) return 'Forbidden — không có quyền truy cập';
  if (s.includes('name resolution') || s.includes('dns')) return 'DNS resolution failed';
  if (exitCode === 2880417800) return 'Connection refused (WSAECONNREFUSED) — camera từ chối kết nối trên port 554';
  if (exitCode === 2869122292) return 'Connection refused — kiểm tra camera đã bật RTSP và port 554 không bị chặn';
  const last = (stderr + stdout).slice(-200).trim();
  return last || `ffprobe exited with code ${exitCode}`;
}

function startFfmpegHls(cameraId, candidate) {
  const { type, url } = candidate;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const outDir = path.join(STREAMS_DIR, cameraId);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    try { fs.readdirSync(outDir).forEach((f) => { try { fs.unlinkSync(path.join(outDir, f)); } catch (_) {} }); } catch (_) {}
    const redactedUrl = url.replace(/:[^:@]+@/, ':***@');
    const transport = 'tcp';

    function buildArgs(copy) {
      const enc = copy
        ? ['-c:v', 'copy', '-an']
        : [
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30',
            '-b:v', '2000k', '-maxrate', '2500k', '-bufsize', '5000k', '-an',
          ];
      return [
        '-loglevel', 'warning',
        '-timeout', '10000000',
        '-analyzeduration', '2000000',
        '-probesize', '1048576',
        '-fflags', '+nobuffer+discardcorrupt+genpts',
        '-flags', '+low_delay',
        '-rtsp_transport', transport,
        '-i', url,
        ...enc,
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '5',
        '-hls_flags', 'delete_segments+append_list+omit_endlist+split_by_time',
        '-hls_segment_filename', 'seg_%03d.ts',
        'stream.m3u8',
      ];
    }

    function launch(copy, isFallback) {
      const args = buildArgs(copy);
      const label = `${type} [${transport}${isFallback ? ' fallback' : ''}]`;
      console.log(`[stream] FFmpeg (${copy ? 'copy' : 'transcode'}) ${label}`);

      const proc = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: outDir });
      let started = false;
      let stderrBuf = '';

      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-2000);
      });

      const timeoutMs = isFallback ? 12000 : 8000;
      const failTimer = setTimeout(() => {
        if (!started) {
          console.warn(`[stream] FFmpeg timeout (${timeoutMs / 1000}s) on ${label}`);
          if (stderrBuf) console.warn(`[stream] FFmpeg stderr: ${stderrBuf.slice(-500)}`);
          try { proc.kill('SIGTERM'); } catch (_) {}
          finish(() => reject(new Error(`${label}: timeout ${timeoutMs / 1000}s`)));
        }
      }, timeoutMs);

      const hlsCheck = setInterval(() => {
        if (started || settled) { clearInterval(hlsCheck); return; }
        try {
          const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.ts'));
          if (files.length > 0) {
            clearInterval(hlsCheck);
            clearTimeout(failTimer);
            started = true;
            streams.set(cameraId, { proc, url, startedAt: new Date(), outDir });
            console.log(`[stream] HLS ready via ${label} (${copy ? 'copy' : 'transcode'}), url=${hlsUrl(cameraId)}`);
            finish(() => resolve({ started: true, hlsUrl: hlsUrl(cameraId), url: redactedUrl, type: label }));
          }
        } catch (_) {}
      }, 200);

      proc.on('close', (code) => {
        clearTimeout(failTimer);
        clearInterval(hlsCheck);
        if (!started) {
          if (stderrBuf) console.warn(`[stream] FFmpeg stderr (${label}, code=${code}): ${stderrBuf.slice(-500)}`);
          if (copy && !isFallback) {
            console.warn(`[stream] Copy failed (code ${code}), trying transcode...`);
            launch(false, true);
            return;
          }
          finish(() => reject(new Error(`${label}: FFmpeg exited (code ${code})`)));
          return;
        }
        const state = streams.get(cameraId);
        if (state && state.proc === proc) {
          console.log(`[stream] FFmpeg stopped (code ${code}), cleaning up stream for ${cameraId}`);
          streams.delete(cameraId);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(failTimer);
        clearInterval(hlsCheck);
        if (!started) {
          if (err.code === 'ENOENT') {
            finish(() => reject(new Error('FFmpeg not found. Install FFmpeg and add to PATH.')));
          } else {
            finish(() => reject(new Error(`FFmpeg error: ${err.message}`)));
          }
        }
      });
    }

    launch(true, false);
  });
}

function stopStream(cameraId) {
  const state = streams.get(cameraId);
  if (!state) return { already: true };

  try { state.proc.kill('SIGTERM'); } catch (_) {}
  try { state.proc.kill('KILL'); } catch (_) {}
  cleanupStream(cameraId);
  return { stopped: true };
}

function cleanupStream(cameraId) {
  streams.delete(cameraId);
  const outDir = path.join(STREAMS_DIR, cameraId);
  try {
    if (fs.existsSync(outDir)) {
      fs.readdirSync(outDir).forEach((f) => {
        try { fs.unlinkSync(path.join(outDir, f)); } catch (_) {}
      });
      fs.rmdirSync(outDir);
    }
  } catch (_) {}
}

function getStatus() {
  const result = [];
  for (const [cameraId, state] of streams) {
    result.push({
      cameraId,
      hlsUrl: hlsUrl(cameraId),
      startedAt: state.startedAt,
      url: state.url ? state.url.replace(/:[^:@]+@/, ':***@') : 'unknown',
    });
  }
  return result;
}

function isStreaming(cameraId) {
  return streams.has(cameraId);
}

function checkFfmpeg() {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegPath();
    const proc = spawn(ffmpegBin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        const ver = out.split('\n')[0] || 'unknown';
        console.log(`[stream] FFmpeg OK: ${ver}`);
        resolve(true);
      } else {
        console.warn('[stream] FFmpeg exited with code', code);
        resolve(false);
      }
    });
    proc.on('error', () => {
      console.warn(`[stream] FFmpeg not found at "${ffmpegBin}". HLS streaming disabled.`);
      resolve(false);
    });
  });
}

function checkFfprobe() {
  return new Promise((resolve) => {
    const ffprobeBin = getFfprobePath();
    const proc = spawn(ffprobeBin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        const ver = out.split('\n')[0] || 'unknown';
        console.log(`[stream] FFprobe OK: ${ver}`);
        resolve(true);
      } else {
        console.warn('[stream] FFprobe exited with code', code);
        resolve(false);
      }
    });
    proc.on('error', () => {
      console.warn(`[stream] FFprobe not found at "${ffprobeBin}". Stream detection may fail.`);
      resolve(false);
    });
  });
}

module.exports = {
  startStream,
  stopStream,
  getStatus,
  isStreaming,
  hlsUrl,
  checkFfmpeg,
  checkFfprobe,
  buildRtspUrlCandidates: buildCandidates,
};
