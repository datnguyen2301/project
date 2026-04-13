const express = require('express');
const Camera = require('../models/Camera');
const watcher = require('../services/watcher');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const cameras = await Camera.find().sort({ createdAt: -1 });
    res.json(cameras);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const camera = await Camera.create(req.body);
    res.status(201).json(camera);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const camera = await Camera.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (camera.autoWatch === false) {
      await watcher.stopWatch(req.params.id);
    }
    res.json(camera);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await watcher.stopWatch(req.params.id);
    const camera = await Camera.findByIdAndDelete(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    res.json({ message: 'Camera deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
