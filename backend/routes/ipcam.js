const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const fsp = fs.promises;
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const Camera = require('../models/Camera');
const Event = require('../models/Event');
const { analyzeImage } = require('../services/analyzer');
const { isIpWebcamAddress } = require('../utils/cameraAddress');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function getCamBaseUrl(camIpAddress) {
  const base = camIpAddress.startsWith('http')
    ? camIpAddress
    : `http://${camIpAddress}`;
  return base.replace(/\/$/, '');
}

function getSnapshotUrl(camIpAddress) {
  return `${getCamBaseUrl(camIpAddress)}/shot.jpg`;
}

router.post('/capture/:cameraId', async (req, res) => {
  const requestStart = Date.now();
  try {
    const camera = await Camera.findById(req.params.cameraId);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (!isIpWebcamAddress(camera.ipAddress)) {
      return res.status(400).json({ error: 'Camera EZVIZ (serial): dùng nút chụp EZVIZ / API ezviz/capture, không dùng IP Webcam.' });
    }

    const snapshotUrl = getSnapshotUrl(camera.ipAddress);

    const response = await fetch(snapshotUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Snapshot failed: HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const filename = `ipcam_${uuidv4()}.jpg`;
    const filepath = path.join(UPLOADS_DIR, filename);

    // Non-blocking write — fire and forget
    fs.writeFile(filepath, buffer, (err) => {
      if (err) console.warn(`[ipcam] File write error: ${err.message}`);
    });

    const thumbName = `thumb_${filename}`;
    const thumbPath = path.join(UPLOADS_DIR, thumbName);

    // Lưu event với _camera ghép tạm (không cần populate query)
    const event = new Event({
      cameraId: camera._id,
      capturedAt: new Date(),
      imagePath: filename,
      thumbnailPath: thumbName,
      analysis: { persons: [], vehicles: [], licensePlates: [] },
      tags: ['ipcam', 'pending-analysis'],
      notes: `IP Webcam capture from ${camera.name}`,
    });
    // Ghép camera info để frontend hiển thị ngay (tránh truy vấn thêm DB)
    event._camera = { _id: camera._id, name: camera.name, location: camera.location };

    // .save() bất đồng bộ — không chờ, nhưng vẫn cần để có _id cho processCapture
    const savedEvent = await event.save();
    // Ghép lại _camera sau save
    savedEvent._camera = event._camera;
    res.status(201).json(savedEvent);

    // Mọi thứ bên dưới chạy background — thumbnail, phân tích, cập nhật event
    processCapture(savedEvent._id.toString(), filepath, thumbPath, camera._id, camera.name).catch((err) => {
      console.warn(`[ipcam] Background capture process error: ${err.message}`);
    });

    console.log(`[ipcam] Capture response in ${Date.now() - requestStart}ms`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function processCapture(eventId, filepath, thumbPath, cameraId, cameraName) {
  const step1 = Date.now();
  try {
    // Tạo thumbnail ở background
    await sharp(filepath).resize(320, 240, { fit: 'inside' }).toFile(thumbPath);
    console.log(`[ipcam] Thumbnail created in ${Date.now() - step1}ms`);
  } catch (err) {
    console.warn(`[ipcam] Thumbnail failed: ${err.message}`);
  }

  try {
    // Cập nhật camera online status (không đợi)
    Camera.findByIdAndUpdate(cameraId, { status: 'online' }).catch(() => {});
  } catch (_) {}

  const step2 = Date.now();
  const result = await analyzeImage(filepath);
  console.log(`[ipcam] Analysis done in ${Date.now() - step2}ms (total since request: ${Date.now() - (Date.now() - step1 + step2)}ms)`);

  try {
    const event = await Event.findByIdAndUpdate(
      eventId,
      {
        analysis: result.analysis,
        tags: [...result.tags, 'ipcam'],
      },
      { new: true }
    );
    if (event) {
      console.log(`[ipcam] Event ${eventId} updated with tags: ${result.tags.join(',')}`);
    }
  } catch (err) {
    console.warn(`[ipcam] Event update failed: ${err.message}`);
  }
}

router.get('/snapshot/:cameraId', async (req, res) => {
  try {
    const camera = await Camera.findById(req.params.cameraId);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (!isIpWebcamAddress(camera.ipAddress)) {
      return res.status(400).json({ error: 'Stream/snapshot IP Webcam không áp dụng cho camera EZVIZ.' });
    }

    const snapshotUrl = getSnapshotUrl(camera.ipAddress);
    const response = await fetch(snapshotUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Snapshot failed: HTTP ${response.status}`);

    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stream/:cameraId', async (req, res) => {
  try {
    const camera = await Camera.findById(req.params.cameraId);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (!isIpWebcamAddress(camera.ipAddress)) {
      return res.status(400).json({ error: 'Live stream chỉ cho IP Webcam; EZVIZ xem trên app EZVIZ.' });
    }

    const streamUrl = `${getCamBaseUrl(camera.ipAddress)}/video`;

    const proxyReq = http.get(streamUrl, (proxyRes) => {
      res.writeHead(200, {
        'Content-Type': proxyRes.headers['content-type'] || 'multipart/x-mixed-replace',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
      });
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.end());
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Cannot connect to camera stream' });
      } else {
        res.end();
      }
    });

    req.on('close', () => {
      proxyReq.destroy();
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

router.get('/test', async (_req, res) => {
  const url = process.env.IP_WEBCAM_URL;
  if (!url) return res.json({ ok: false, error: 'IP_WEBCAM_URL not set in .env' });

  try {
    const response = await fetch(`${url}/shot.jpg`, { signal: AbortSignal.timeout(5000) });
    res.json({ ok: response.ok, status: response.status, url: `${url}/shot.jpg` });
  } catch (err) {
    res.json({ ok: false, error: err.message, url: `${url}/shot.jpg` });
  }
});

module.exports = router;
