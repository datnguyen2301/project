const express = require('express');
const Camera = require('../models/Camera');
const watcher = require('../services/watcher');
const { isIpWebcamAddress, isEzvizSerialAddress } = require('../utils/cameraAddress');

const router = express.Router();

router.post('/start/:cameraId', async (req, res) => {
  try {
    const camera = await Camera.findById(req.params.cameraId);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (!camera.ipAddress) return res.status(400).json({ error: 'Camera has no IP address' });
    if (!isIpWebcamAddress(camera.ipAddress) && !isEzvizSerialAddress(camera.ipAddress)) {
      return res.status(400).json({
        error: 'Auto-watch chỉ hỗ trợ IP Webcam hoặc camera EZVIZ (serial).',
      });
    }

    const result = await watcher.startWatch(camera._id.toString());

    camera.autoWatch = true;
    await camera.save();

    const status = await watcher.getStatus();

    res.json({ cameraId: camera._id, ...result, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stop/:cameraId', async (req, res) => {
  try {
    const result = await watcher.stopWatch(req.params.cameraId);

    const camera = await Camera.findById(req.params.cameraId);
    if (camera) {
      camera.autoWatch = false;
      await camera.save();
    }

    const status = await watcher.getStatus();

    res.json({ cameraId: req.params.cameraId, ...result, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', async (_req, res) => {
  try {
    const status = await watcher.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recording/status', async (_req, res) => {
  try {
    const status = await watcher.getRecordingStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recording/clips/:cameraId', async (req, res) => {
  try {
    const clips = await watcher.getClips(req.params.cameraId);
    res.json(clips);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recording/clips', async (_req, res) => {
  try {
    const clips = await watcher.getClips(null);
    res.json(clips);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/recording/clips/:clipId', async (req, res) => {
  try {
    const result = await watcher.deleteClip(req.params.clipId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/recording/clips/:clipId/reanalyze', async (req, res) => {
  try {
    const event = await watcher.reanalyzeClip(req.params.clipId);
    res.json(event);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
