const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const KnownPerson = require('../models/KnownPerson');
const Event = require('../models/Event');
const { extractFaces } = require('../services/analyzer');
const { invalidateCache, MATCH_THRESHOLD } = require('../services/faceMatch');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const FACES_DIR = path.join(UPLOADS_DIR, 'faces');
fs.mkdirSync(FACES_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: FACES_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Chỉ chấp nhận file ảnh'));
  },
});

// List known persons (never expose raw embeddings to the UI).
router.get('/', async (_req, res) => {
  try {
    const people = await KnownPerson.find().sort({ name: 1 }).lean();
    res.json(people.map((p) => ({
      _id: p._id,
      name: p.name,
      imagePaths: p.imagePaths || [],
      photoCount: (p.embeddings || []).length,
      createdAt: p.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enroll: name + photo. If the name already exists, the photo is ADDED to that
// person (more photos → more robust matching).
router.post('/', upload.single('image'), async (req, res) => {
  const filePath = req.file ? req.file.path : null;
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Thiếu tên người' });
    if (!req.file) return res.status(400).json({ error: 'Thiếu ảnh' });

    const faces = await extractFaces(filePath);
    if (faces.length === 0) {
      fs.unlink(filePath, () => {});
      return res.status(422).json({
        error: 'Không tìm thấy khuôn mặt trong ảnh. Dùng ảnh rõ mặt, chụp thẳng, đủ sáng.',
      });
    }
    if (faces.length > 1) {
      fs.unlink(filePath, () => {});
      return res.status(422).json({
        error: `Ảnh có ${faces.length} khuôn mặt — dùng ảnh chỉ có MỘT người để đăng ký.`,
      });
    }

    // Normalize the stored photo (privacy + size): crop is not required, but cap size.
    try {
      const tmp = `${filePath}.norm.jpg`;
      await sharp(filePath).rotate().resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 88 }).toFile(tmp);
      fs.renameSync(tmp, filePath);
    } catch (_) { /* keep original on failure */ }

    const relPath = `faces/${path.basename(filePath)}`;
    const person = await KnownPerson.findOneAndUpdate(
      { name },
      {
        $push: {
          embeddings: faces[0].embedding,
          imagePaths: relPath,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    invalidateCache();
    res.status(201).json({
      _id: person._id,
      name: person.name,
      imagePaths: person.imagePaths,
      photoCount: person.embeddings.length,
    });
  } catch (err) {
    if (filePath) fs.unlink(filePath, () => {});
    res.status(500).json({ error: err.message });
  }
});

/**
 * Enroll from an image already in the database (a captured event) — the common
 * case being "this 'stranger' is actually my brother, add him".
 *
 * The chosen face is CROPPED INTO faces/ rather than referenced in place: the
 * event keeps its own image, and deleting the person later (which unlinks every
 * imagePaths entry) can never delete an event's photo.
 *
 * Body: { name, eventId, faceIndex? }
 * When the frame holds several faces and faceIndex is omitted, responds 409 with
 * the face boxes so the UI can ask which person to enroll.
 */
router.post('/from-event', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const { eventId } = req.body;
    if (!name) return res.status(400).json({ error: 'Thiếu tên người' });
    if (!eventId) return res.status(400).json({ error: 'Thiếu sự kiện' });

    const event = await Event.findById(eventId).lean();
    if (!event) return res.status(404).json({ error: 'Không tìm thấy sự kiện' });
    if (!event.imagePath) return res.status(422).json({ error: 'Sự kiện này không có ảnh' });

    // Keep the resolved path inside uploads/ — imagePath comes from the DB, but
    // a traversal-looking value must never let us read outside the folder.
    const absPath = path.resolve(UPLOADS_DIR, event.imagePath);
    if (!absPath.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
      return res.status(400).json({ error: 'Đường dẫn ảnh không hợp lệ' });
    }
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'File ảnh của sự kiện không còn tồn tại' });
    }

    const faces = await extractFaces(absPath);
    if (faces.length === 0) {
      return res.status(422).json({
        error: 'Không tìm thấy khuôn mặt đủ rõ trong ảnh này. Chọn ảnh khác có mặt gần và rõ hơn.',
      });
    }

    let idx = req.body.faceIndex;
    if (idx === undefined || idx === null || idx === '') {
      if (faces.length > 1) {
        return res.status(409).json({
          error: `Ảnh có ${faces.length} khuôn mặt — chọn người cần đăng ký.`,
          needsSelection: true,
          faces: faces.map((f, i) => ({ index: i, bbox: f.bbox, score: f.score })),
        });
      }
      idx = 0;
    }
    idx = parseInt(idx, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= faces.length) {
      return res.status(400).json({ error: 'Khuôn mặt đã chọn không hợp lệ' });
    }

    // Crop the face (with margin) so the stored photo is a portrait, not the
    // whole scene — better as an avatar and stores less of the surroundings.
    const outName = `${uuidv4()}.jpg`;
    const outPath = path.join(FACES_DIR, outName);
    const b = faces[idx].bbox;
    let cropped = false;
    try {
      const meta = await sharp(absPath).metadata();
      const mx = Math.round(b.width * 0.4);
      const my = Math.round(b.height * 0.4);
      const left = Math.max(0, b.x - mx);
      const top = Math.max(0, b.y - my);
      const width = Math.min(meta.width - left, b.width + mx * 2);
      const height = Math.min(meta.height - top, b.height + my * 2);
      if (width > 0 && height > 0) {
        await sharp(absPath)
          .extract({ left, top, width, height })
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 88 })
          .toFile(outPath);
        cropped = true;
      }
    } catch (_) { /* fall through to full-frame copy */ }
    if (!cropped) {
      await sharp(absPath).resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 88 }).toFile(outPath);
    }

    const person = await KnownPerson.findOneAndUpdate(
      { name },
      { $push: { embeddings: faces[idx].embedding, imagePaths: `faces/${outName}` } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    invalidateCache();
    res.status(201).json({
      _id: person._id,
      name: person.name,
      imagePaths: person.imagePaths,
      photoCount: person.embeddings.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Candidate event images for enrollment (frames that contain a person). */
router.get('/candidates', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '40', 10), 100);
    const events = await Event.find({
      tags: { $in: ['person', 'stranger'] },
      imagePath: { $ne: '' },
    })
      .sort({ capturedAt: -1 })
      .limit(limit)
      .populate('cameraId', 'name')
      .select('imagePath thumbnailPath capturedAt tags cameraId')
      .lean();
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a person and their enrollment photos.
router.delete('/:id', async (req, res) => {
  try {
    const person = await KnownPerson.findByIdAndDelete(req.params.id);
    if (!person) return res.status(404).json({ error: 'Không tìm thấy' });
    for (const rel of person.imagePaths || []) {
      fs.unlink(path.join(UPLOADS_DIR, rel), () => {});
    }
    invalidateCache();
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recent stranger events for the Faces page.
router.get('/strangers/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const events = await Event.find({ tags: 'stranger' })
      .sort({ capturedAt: -1 })
      .limit(limit)
      .populate('cameraId', 'name location');
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/config', (_req, res) => {
  res.json({ matchThreshold: MATCH_THRESHOLD });
});

module.exports = router;
