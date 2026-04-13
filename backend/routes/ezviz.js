const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const Camera = require('../models/Camera');
const Event = require('../models/Event');
const ezviz = require('../services/ezviz');
const { analyzeImage } = require('../services/analyzer');
const { captureRtspJpegToFile } = require('../services/rtspCapture');
const { isIpWebcamAddress } = require('../utils/cameraAddress');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const FETCH_IMAGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function bufferLooksLikeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return true;
  }
  return false;
}

const ezvizFrameCache = new Map();

router.get('/frame/:cameraId', async (req, res) => {
  try {
    const camera = await Camera.findById(req.params.cameraId);
    if (!camera?.ipAddress) {
      return res.status(404).type('text/plain').send('Camera not found');
    }
    if (isIpWebcamAddress(camera.ipAddress)) {
      return res.status(400).type('text/plain').send('Not an EZVIZ camera');
    }

    const id = camera._id.toString();
    const now = Date.now();
    const cached = ezvizFrameCache.get(id);
    if (cached && now - cached.at < 5000) {
      res.set('Content-Type', cached.ct);
      res.set('Cache-Control', 'no-store');
      return res.send(cached.buf);
    }

    let buf;
    let ct = 'image/jpeg';

    try {
      const captureData = await ezviz.captureImage(camera.ipAddress);
      const picUrl = captureData.picUrl;
      if (!picUrl) throw new Error('No image URL from EZVIZ bridge');
      const imgRes = await fetch(picUrl, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': FETCH_IMAGE_UA },
      });
      if (!imgRes.ok) throw new Error(`Image download HTTP ${imgRes.status}`);
      ct = imgRes.headers.get('content-type') || 'image/jpeg';
      buf = Buffer.from(await imgRes.arrayBuffer());
      if (!bufferLooksLikeImage(buf)) throw new Error('Cloud frame body is not a valid image');
    } catch (cloudErr) {
      const tmp = path.join(os.tmpdir(), `vg_ezviz_frame_${id}_${now}.jpg`);
      try {
        const ok = await captureRtspJpegToFile(camera, tmp, 10000);
        if (!ok) throw cloudErr;
        buf = await fs.promises.readFile(tmp);
      } finally {
        try { await fs.promises.unlink(tmp); } catch (_) {}
      }
    }

    ezvizFrameCache.set(id, { at: now, buf, ct });
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    console.warn('[ezviz/frame]', err.message);
    res.status(502).type('text/plain').send(err.message || 'EZVIZ frame error');
  }
});

function findCameraByEzvizSerial(serial) {
  const s = String(serial || '').trim();
  if (!s) return null;
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Camera.findOne({ ipAddress: new RegExp(`^${escaped}$`, 'i') });
}

router.post('/sync-cameras', async (req, res) => {
  try {
    const devices = await ezviz.getDeviceList();
    const results = [];

    for (const device of devices) {
      const serial = String(device.deviceSerial || '').trim();
      if (!serial) continue;

      const existing = await findCameraByEzvizSerial(serial);

      if (existing) {
        existing.name = device.deviceName || existing.name;
        existing.status = device.status === 1 ? 'online' : 'offline';
        await existing.save();
        results.push({ serial, action: 'updated' });
      } else {
        await Camera.create({
          name: device.deviceName || `EZVIZ ${serial}`,
          location: '',
          type: 'ip',
          ipAddress: serial,
          status: device.status === 1 ? 'online' : 'offline',
        });
        results.push({ serial, action: 'created' });
      }
    }

    res.json({ synced: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function cloudCapture(deviceSerial, destPath) {
  // Ưu tiên HTTP server (ezviz_server.py), fallback sang execFile bridge
  const tryServer = async () => {
    try {
      return await ezviz.captureImage(deviceSerial, { fastMode: true });
    } catch (_) {
      return null;
    }
  };

  const tryBridge = async () => {
    try {
      return await ezviz.captureImageViaBridge(deviceSerial, { fastMode: true });
    } catch (_) {
      return null;
    }
  };

  const captureData = await tryServer() || await tryBridge();
  if (!captureData?.picUrl) {
    return { ok: false, err: 'no picUrl from EZVIZ' };
  }

  try {
    const imgRes = await fetch(captureData.picUrl, {
      signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': FETCH_IMAGE_UA },
    });
    if (!imgRes.ok) return { ok: false, err: `HTTP ${imgRes.status}` };
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (!bufferLooksLikeImage(buf)) return { ok: false, err: 'not a valid image' };
    fs.writeFileSync(destPath, buf);
    return { ok: true, source: 'cloud', size: buf.length };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

async function rtspCapture(camera, destPath) {
  const start = Date.now();
  const ok = await captureRtspJpegToFile(camera, destPath, {
    timeoutPerUrlMs: 8000,
    parallel: true,
    parallelFallbackLimit: 3,
    fallbackTimeoutMs: 3000,
    totalBudgetMs: 0,
  });
  if (ok) {
    const size = fs.statSync(destPath).size;
    return { ok: true, source: 'rtsp', size, ms: Date.now() - start };
  }
  return { ok: false, source: 'rtsp', ms: Date.now() - start };
}

// ── capture route ─────────────────────────────────────────────────────────────

router.post('/capture/:deviceSerial', async (req, res) => {
  const requestStart = Date.now();
  try {
    const { deviceSerial } = req.params;

    let dbCamera = await findCameraByEzvizSerial(deviceSerial);

    if (!dbCamera) {
      dbCamera = await Camera.create({
        name: `EZVIZ ${deviceSerial}`,
        type: 'ip',
        ipAddress: String(deviceSerial).trim(),
        status: 'online',
      });
    } else {
      Camera.findByIdAndUpdate(dbCamera._id, { status: 'online' }).catch(() => {});
    }

    // 两路并发竞速：谁先拿到有效图片谁赢
    const cloudPath = path.join(os.tmpdir(), `vg_ezviz_cloud_${process.pid}_${Date.now()}.jpg`);
    const rtspPath = path.join(os.tmpdir(), `vg_ezviz_rtsp_${process.pid}_${Date.now()}.jpg`);

    const cloudPromise = cloudCapture(deviceSerial, cloudPath);
    const rtspPromise = rtspCapture(dbCamera, rtspPath);

    // 等待先完成的那路（最久等 20s）
    let winner;
    try {
      winner = await Promise.race([cloudPromise, rtspPromise]);
    } catch (e) {
      winner = { ok: false };
    }

    const cloudResult = await cloudPromise.catch(r => r);
    const rtspResult = await rtspPromise.catch(r => r);

    let filename, usedCloud, usedRtsp;
    if (winner?.ok && winner.source === 'cloud') {
      filename = `ezviz_${uuidv4()}.jpg`;
      const destPath = path.join(UPLOADS_DIR, filename);
      fs.copyFileSync(cloudPath, destPath);
      usedCloud = true; usedRtsp = false;
      try { fs.unlinkSync(cloudPath); } catch (_) {}
      try { fs.unlinkSync(rtspPath); } catch (_) {}
    } else if (winner?.ok && winner.source === 'rtsp') {
      filename = `ezviz_${uuidv4()}.jpg`;
      const destPath = path.join(UPLOADS_DIR, filename);
      fs.copyFileSync(rtspPath, destPath);
      usedCloud = false; usedRtsp = true;
      try { fs.unlinkSync(cloudPath); } catch (_) {}
      try { fs.unlinkSync(rtspPath); } catch (_) {}
    } else {
      const alt = cloudResult?.ok ? cloudResult : rtspResult;
      const altPath = alt?.source === 'cloud' ? cloudPath : rtspPath;
      filename = `ezviz_${uuidv4()}.jpg`;
      const destPath = path.join(UPLOADS_DIR, filename);
      if (alt?.ok && fs.existsSync(altPath)) {
        fs.copyFileSync(altPath, destPath);
        usedCloud = alt.source === 'cloud';
        usedRtsp = alt.source === 'rtsp';
      } else {
        usedCloud = false;
        usedRtsp = false;
      }
      try { fs.unlinkSync(cloudPath); } catch (_) {}
      try { fs.unlinkSync(rtspPath); } catch (_) {}
    }

    const filepath = path.join(UPLOADS_DIR, filename);
    const thumbName = `thumb_${filename}`;
    const thumbPath = path.join(UPLOADS_DIR, thumbName);

    const captureOk = usedCloud || usedRtsp;
    const notes = captureOk
      ? usedCloud
        ? `EZVIZ cloud capture (${deviceSerial})`
        : `EZVIZ RTSP capture (${deviceSerial})`
      : `EZVIZ capture failed — cloud: ${cloudResult?.err || '?'} | rtsp: ${rtspResult?.ok === false ? 'failed' : '?'}`;

    const event = new Event({
      cameraId: dbCamera._id,
      capturedAt: new Date(),
      imagePath: filename,
      thumbnailPath: thumbName,
      analysis: { persons: [], vehicles: [], licensePlates: [] },
      tags: usedCloud ? ['ezviz', 'pending-analysis'] : ['ezviz'],
      notes,
    });
    event._camera = { _id: dbCamera._id, name: dbCamera.name, location: dbCamera.location };

    const savedEvent = await event.save();
    savedEvent._camera = event._camera;
    res.status(201).json(savedEvent);

    if (captureOk) {
      processEzvizCapture(savedEvent._id.toString(), filepath, thumbPath, dbCamera._id).catch((err) => {
        console.warn(`[ezviz] Background process error: ${err.message}`);
      });
    }

    console.log(
      `[ezviz] Captured via ${usedCloud ? 'cloud' : usedRtsp ? 'rtsp' : 'FAILED'} ` +
      `(${Date.now() - requestStart}ms) | cloud=${cloudResult?.ok} rtsp=${rtspResult?.ok}`
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function processEzvizCapture(eventId, filepath, thumbPath, cameraId) {
  if (!fs.existsSync(filepath)) {
    console.warn('[ezviz] Skip thumbnail/analysis — image file missing');
    return;
  }
  const step1 = Date.now();
  try {
    await sharp(filepath).resize(320, 240, { fit: 'inside' }).toFile(thumbPath);
    console.log(`[ezviz] Thumbnail created in ${Date.now() - step1}ms`);
  } catch (err) {
    console.warn(`[ezviz] Thumbnail failed: ${err.message}`);
  }

  const step2 = Date.now();
  const result = await analyzeImage(filepath);
  console.log(`[ezviz] Analysis done in ${Date.now() - step2}ms`);

  try {
    await Event.findByIdAndUpdate(eventId, {
      analysis: result.analysis,
      tags: [...result.tags, 'ezviz'],
    });
  } catch (err) {
    console.warn(`[ezviz] Event update failed: ${err.message}`);
  }
}

router.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('EZVIZ webhook received:', JSON.stringify(payload).slice(0, 500));

    if (payload.header && payload.body) {
      const { deviceSerial } = payload.header;
      const alarmPicUrl = payload.body.alarmPicUrl || payload.body.picUrl;

      if (deviceSerial && alarmPicUrl) {
        const filename = await ezviz.downloadImage(alarmPicUrl, UPLOADS_DIR);
        const filepath = path.join(UPLOADS_DIR, filename);

        const thumbName = `thumb_${filename}`;
        await sharp(filepath).resize(320, 240, { fit: 'inside' }).toFile(path.join(UPLOADS_DIR, thumbName));

        const analysisResult = await analyzeImage(filepath);

        let camera = await findCameraByEzvizSerial(deviceSerial);
        if (!camera) {
          camera = await Camera.create({
            name: `EZVIZ ${deviceSerial}`,
            type: 'ip',
            ipAddress: String(deviceSerial).trim(),
            status: 'online',
          });
        }

        await Event.create({
          cameraId: camera._id,
          capturedAt: new Date(),
          imagePath: filename,
          thumbnailPath: thumbName,
          analysis: analysisResult.analysis,
          tags: [...analysisResult.tags, 'ezviz', 'alarm'],
          notes: `Alarm from ${deviceSerial}: ${payload.header.alarmType || 'motion'}`,
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('EZVIZ webhook error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

router.get('/devices', async (req, res) => {
  try {
    const devices = await ezviz.getDeviceList();
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
