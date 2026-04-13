const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const Event = require('../models/Event');
const { analyzeImage, analyzeEventMedia } = require('../services/analyzer');

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  },
});

async function createThumbnail(srcPath) {
  const ext = path.extname(srcPath);
  const thumbName = `thumb_${path.basename(srcPath, ext)}${ext}`;
  const thumbPath = path.join(path.dirname(srcPath), thumbName);
  await sharp(srcPath).resize(320, 240, { fit: 'inside' }).toFile(thumbPath);
  return thumbName;
}

router.post('/capture', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const thumbName = await createThumbnail(req.file.path);
    const result = await analyzeImage(req.file.path);

    const event = await Event.create({
      cameraId: req.body.cameraId,
      capturedAt: req.body.capturedAt || new Date(),
      imagePath: req.file.filename,
      thumbnailPath: thumbName,
      analysis: result.analysis,
      tags: result.tags,
    });

    res.status(201).json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const thumbName = await createThumbnail(req.file.path);
    const result = await analyzeImage(req.file.path);

    const event = await Event.create({
      cameraId: req.body.cameraId,
      capturedAt: req.body.capturedAt || new Date(),
      imagePath: req.file.filename,
      thumbnailPath: thumbName,
      analysis: result.analysis,
      tags: result.tags,
      notes: req.body.notes || '',
    });

    res.status(201).json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { cameraId, dateFrom, dateTo, tag, search, plate, minPersons, hasVehicle, type, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (cameraId) filter.cameraId = cameraId;
    if (dateFrom || dateTo) {
      filter.capturedAt = {};
      if (dateFrom) filter.capturedAt.$gte = new Date(dateFrom);
      if (dateTo) filter.capturedAt.$lte = new Date(dateTo);
    }
    if (tag) filter.tags = tag;
    if (search) filter.$text = { $search: search };
    if (plate) {
      filter['analysis.licensePlates.plateNumber'] = { $regex: plate, $options: 'i' };
    }
    if (minPersons) {
      filter[`analysis.persons.${parseInt(minPersons) - 1}`] = { $exists: true };
    }
    if (hasVehicle === 'true') {
      filter['analysis.vehicles.0'] = { $exists: true };
    }
    if (type === 'image') {
      filter.videoPath = { $exists: false };
      filter.type = { $ne: 'clip' };
    } else if (type === 'clip') {
      filter.$or = [
        { type: 'clip' },
        { videoPath: { $regex: /\.(mp4|gif|webm|avi|mov)$/i } },
      ];
    }
    // type=all: lấy tất cả (image + video), không lọc theo type

    const baseFilter = { ...filter };
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [events, total] = await Promise.all([
      Event.find(filter)
        .populate('cameraId', 'name location')
        .sort({ capturedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Event.countDocuments(filter),
    ]);

    res.json({
      events,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const [totalEvents, todayEvents, personEvents, vehicleEvents] = await Promise.all([
      Event.countDocuments(),
      Event.countDocuments({
        capturedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      }),
      Event.countDocuments({ tags: 'person' }),
      Event.countDocuments({ tags: 'vehicle' }),
    ]);
    res.json({ totalEvents, todayEvents, personEvents, vehicleEvents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate('cameraId', 'name location');
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/analyze', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const result = await analyzeEventMedia(event);

    event.analysis = result.analysis;
    const tagKeys = ['person', 'vehicle', 'plate'];
    event.tags = [...new Set([
      ...event.tags.filter((t) => !tagKeys.includes(t)),
      ...result.tags,
    ])];
    await event.save();
    await event.populate('cameraId', 'name location');

    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
