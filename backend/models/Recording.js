const mongoose = require('mongoose');

/**
 * One continuously-recorded video segment.
 *
 * Kept separate from Event on purpose. An Event is a detection — sparse, one per
 * motion, and carries a `required` imagePath. Segments are a dense time index
 * (~288 rows per camera per day at 5-minute segments), and GET /api/events,
 * getStats(), SearchPage and the Events page's default tab all query without a
 * `type` filter — folding segments in would drown the events feed in recording
 * noise. Separation also lets recordings retain for 14 days while clips keep 30.
 */
const recordingSchema = new mongoose.Schema(
  {
    cameraId: { type: mongoose.Schema.Types.ObjectId, ref: 'Camera', required: true },

    // Wall-clock start, reconstructed from the -strftime filename in LOCAL time
    // (see utils/localDay.js — parsing it as ISO would treat it as UTC).
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
    durationSec: { type: Number, required: true },

    // POSIX-relative to backend/uploads/, e.g.
    // "recordings/<cameraId>/<runId>/2026-07-24_143000.mp4".
    // Must use forward slashes: this becomes a URL, and path.join would emit
    // backslashes on Windows which 404 through express.static.
    filePath: { type: String, required: true, unique: true },
    sizeBytes: { type: Number, default: 0 },

    // Denormalised LOCAL day. The filesystem no longer encodes the date as a
    // directory, and deriving local-day boundaries inside a query would need
    // timezone aggregation on every request.
    dayKey: { type: String, required: true },

    source: { type: String, enum: ['mjpeg', 'rtsp', 'ezviz-cloud'], required: true },

    // Groups segments produced by a single ffmpeg run; also the directory name,
    // which is what keeps filenames unique across restarts.
    runId: { type: String, default: '' },
  },
  { timestamps: true },
);

// Serves both "segments for camera C in range" and "segment covering T".
recordingSchema.index({ cameraId: 1, startedAt: 1 });
// Day-availability strip.
recordingSchema.index({ cameraId: 1, dayKey: 1 });
// Global oldest-first retention / disk-floor sweeps.
recordingSchema.index({ startedAt: 1 });

module.exports = mongoose.model('Recording', recordingSchema);
