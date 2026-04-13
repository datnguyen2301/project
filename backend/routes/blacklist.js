const express = require('express');
const Blacklist = require('../models/Blacklist');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const items = await Blacklist.find().sort({ addedAt: -1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { plateNumber, reason } = req.body;
    if (!plateNumber) return res.status(400).json({ error: 'plateNumber is required' });
    const item = await Blacklist.create({ plateNumber: plateNumber.toUpperCase().trim(), reason });
    res.status(201).json(item);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Plate already in blacklist' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await Blacklist.findByIdAndDelete(req.params.id);
    res.json({ message: 'Removed from blacklist' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/check/:plate', async (req, res) => {
  try {
    const item = await Blacklist.findOne({
      plateNumber: { $regex: req.params.plate, $options: 'i' },
    });
    res.json({ blacklisted: !!item, item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
