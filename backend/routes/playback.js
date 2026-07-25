/**
 * Playback API — the timeline behind the "Xem lại" page.
 *
 * Media is deliberately NOT served through here. `<video>` cannot attach an
 * Authorization header, and server.js already mounts /uploads statically (with
 * HTTP Range support) before authMiddleware, so segments are fetched directly at
 * /uploads/<filePath>. These routes only return JSON describing what exists.
 */

const express = require('express');
const Camera = require('../models/Camera');
const Event = require('../models/Event');
const Recording = require('../models/Recording');
const recorder = require('../services/continuousRecorder');
const { localDayKey, localDayRange } = require('../utils/localDay');

const router = express.Router();

// Segments this far apart are treated as contiguous; keyframe alignment means a
// cut can land a second or two off its nominal boundary, and reporting that as a
// gap would litter the timeline with meaningless slivers.
const GAP_TOLERANCE_SEC = 3;
const MAX_EVENT_MARKERS = 500;

function segmentUrl(filePath) {
  return `/uploads/${filePath}`;
}

/** Cameras that can appear in the playback picker, with their footage extent. */
router.get('/cameras', async (_req, res) => {
  try {
    const cameras = await Camera.find().sort({ name: 1 }).lean();
    const stats = await Recording.aggregate([
      {
        $group: {
          _id: '$cameraId',
          segments: { $sum: 1 },
          sizeBytes: { $sum: '$sizeBytes' },
          firstAt: { $min: '$startedAt' },
          lastAt: { $max: '$endedAt' },
        },
      },
    ]);
    const byCam = new Map(stats.map((s) => [String(s._id), s]));

    res.json(
      cameras.map((c) => {
        const s = byCam.get(String(c._id));
        return {
          _id: c._id,
          name: c.name,
          location: c.location,
          autoRecord: Boolean(c.autoRecord),
          recording: recorder.isRecording(c._id),
          segments: s ? s.segments : 0,
          sizeBytes: s ? s.sizeBytes : 0,
          firstAt: s ? s.firstAt : null,
          lastAt: s ? s.lastAt : null,
        };
      }),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Days that have footage, for the date picker. */
router.get('/days/:cameraId', async (req, res) => {
  try {
    const days = await Recording.aggregate([
      { $match: { cameraId: new (require('mongoose').Types.ObjectId)(String(req.params.cameraId)) } },
      {
        $group: {
          _id: '$dayKey',
          segments: { $sum: 1 },
          recordedSec: { $sum: '$durationSec' },
          sizeBytes: { $sum: '$sizeBytes' },
          firstAt: { $min: '$startedAt' },
          lastAt: { $max: '$endedAt' },
        },
      },
      { $sort: { _id: -1 } },
      { $limit: 60 },
    ]);
    res.json({
      cameraId: req.params.cameraId,
      days: days.map((d) => ({
        day: d._id,
        segments: d.segments,
        recordedSec: Math.round(d.recordedSec),
        sizeBytes: d.sizeBytes,
        firstAt: d.firstAt,
        lastAt: d.lastAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** The main endpoint: segments + gaps + event markers for one camera-day. */
router.get('/timeline/:cameraId', async (req, res) => {
  try {
    const { cameraId } = req.params;
    const date = String(req.query.date || localDayKey(new Date()));
    const { start, end } = localDayRange(date);

    const segments = await Recording.find({
      cameraId,
      startedAt: { $gte: start, $lt: end },
    })
      .sort({ startedAt: 1 })
      .select('startedAt endedAt durationSec filePath sizeBytes')
      .lean();

    // Gaps are first-class: recording may have been off, or the camera offline.
    const gaps = [];
    for (let i = 1; i < segments.length; i++) {
      const prevEnd = new Date(segments[i - 1].endedAt).getTime();
      const curStart = new Date(segments[i].startedAt).getTime();
      const gapSec = (curStart - prevEnd) / 1000;
      if (gapSec > GAP_TOLERANCE_SEC) {
        gaps.push({ from: new Date(prevEnd), to: new Date(curStart), seconds: Math.round(gapSec) });
      }
    }

    const events = await Event.find({ cameraId, capturedAt: { $gte: start, $lt: end } })
      .sort({ capturedAt: 1 })
      .limit(MAX_EVENT_MARKERS)
      .select('capturedAt tags type thumbnailPath videoPath analysis')
      .lean();

    const recordedSec = segments.reduce((a, s) => a + s.durationSec, 0);

    res.json({
      cameraId,
      date,
      dayStart: start,
      dayEnd: end,
      recording: recorder.isRecording(cameraId),
      segments: segments.map((s) => ({
        id: s._id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationSec: s.durationSec,
        filePath: s.filePath,
        url: segmentUrl(s.filePath),
        sizeBytes: s.sizeBytes,
      })),
      gaps,
      events: events.map((e) => ({
        id: e._id,
        at: e.capturedAt,
        type: e.type,
        tags: e.tags || [],
        thumbnailPath: e.thumbnailPath || '',
        videoPath: e.videoPath || '',
        persons: e.analysis?.persons?.length || 0,
        vehicles: e.analysis?.vehicles?.length || 0,
        plates: (e.analysis?.licensePlates || []).map((p) => p.plateNumber).filter(Boolean),
      })),
      eventsTruncated: events.length >= MAX_EVENT_MARKERS,
      totals: {
        segmentCount: segments.length,
        recordedSec: Math.round(recordedSec),
        eventCount: events.length,
        coverage: +(recordedSec / 86400).toFixed(4),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Resolve an instant to a segment + offset. Used for jumps outside the loaded day. */
router.get('/seek/:cameraId', async (req, res) => {
  try {
    const { cameraId } = req.params;
    const at = new Date(String(req.query.at || ''));
    if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'invalid ?at' });

    const covering = await Recording.findOne({ cameraId, startedAt: { $lte: at } })
      .sort({ startedAt: -1 })
      .lean();

    if (covering && new Date(covering.endedAt) >= at) {
      return res.json({
        found: true,
        segment: { ...covering, url: segmentUrl(covering.filePath) },
        offsetSec: +((at - new Date(covering.startedAt)) / 1000).toFixed(3),
      });
    }

    // Inside a gap (or before any footage): offer the next segment forward.
    const next = await Recording.findOne({ cameraId, startedAt: { $gt: at } })
      .sort({ startedAt: 1 })
      .lean();
    res.json({
      found: false,
      segment: null,
      offsetSec: 0,
      nextSegment: next ? { ...next, url: segmentUrl(next.filePath) } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Toggle continuous recording; keeps the persisted flag and the process in step. */
router.post('/record/:cameraId', async (req, res) => {
  try {
    const { cameraId } = req.params;
    const enabled = Boolean(req.body?.enabled);
    const camera = await Camera.findByIdAndUpdate(cameraId, { autoRecord: enabled }, { new: true });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    if (enabled) {
      if (!recorder.isRecording(cameraId)) await recorder.start(cameraId);
    } else {
      recorder.stop(cameraId);
    }
    res.json({ cameraId, autoRecord: camera.autoRecord, recording: recorder.isRecording(cameraId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/record/status', (_req, res) => {
  res.json(recorder.getStatus());
});

module.exports = router;
