const express = require('express');
const Camera = require('../models/Camera');
const stream = require('../services/stream');

const router = express.Router();

router.post('/start/:cameraId', async (req, res) => {
  const camId = req.params.cameraId;
  try {
    const camera = await Camera.findById(camId);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (!camera.ipAddress) return res.status(400).json({ error: 'Camera has no address' });

    const result = await stream.startStream(camera._id.toString());
    res.json({ cameraId: camera._id, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/stop/:cameraId', async (req, res) => {
  try {
    const result = stream.stopStream(req.params.cameraId);
    res.json({ cameraId: req.params.cameraId, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', async (_req, res) => {
  try {
    res.json(stream.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/is-streaming/:cameraId', async (req, res) => {
  res.json({ cameraId: req.params.cameraId, streaming: stream.isStreaming(req.params.cameraId) });
});

module.exports = router;
