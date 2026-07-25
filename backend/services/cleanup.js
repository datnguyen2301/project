const fs = require('fs');
const path = require('path');
const Event = require('../models/Event');
const Recording = require('../models/Recording');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const CLIPS_DIR = path.join(UPLOADS_DIR, 'clips');
const CACHE_DIR = path.join(UPLOADS_DIR, '.watcher_cache');
const RECORDINGS_DIR = path.join(UPLOADS_DIR, 'recordings');

const CLIP_RETENTION_DAYS = parseInt(process.env.CLIP_RETENTION_DAYS || '30', 10);
const CLIP_RETENTION_MS = CLIP_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Continuous recordings are far bulkier than clips (~6.5 GB/day/camera at
// 480p/600k) so they get their own, shorter retention plus a hard free-space
// floor. The floor is what actually caps usage: 14 days x 2 cameras exceeds the
// disk, so the oldest segments are evicted before the age limit is reached.
const RECORD_RETENTION_DAYS = parseInt(process.env.RECORD_RETENTION_DAYS || '14', 10);
const RECORD_MIN_FREE_GB = parseFloat(process.env.RECORD_MIN_FREE_GB || '15');
const RECORD_SWEEP_MIN = parseInt(process.env.RECORD_SWEEP_INTERVAL_MIN || '15', 10);

let cleanupTimer = null;
let recordingSweepTimer = null;

async function deleteFile(filePath) {
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[cleanup] Failed to delete ${filePath}: ${err.message}`);
    }
    return false;
  }
}

async function scanDirectory(dir, maxAgeMs) {
  const toDelete = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(dir, entry.name);
        const stat = await fs.promises.stat(subDir);
        if (now - stat.mtimeMs > maxAgeMs) {
          toDelete.push({ type: 'dir', path: subDir });
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[cleanup] scanDirectory error: ${err.message}`);
    }
  }
  return toDelete;
}

async function cleanUpOldClips() {
  console.log(`[cleanup] Running clip cleanup (retention: ${CLIP_RETENTION_DAYS} days)...`);
  const cutoff = Date.now() - CLIP_RETENTION_MS;

  try {
    const oldEvents = await Event.find({
      type: 'clip',
      recordingStart: { $lt: new Date(cutoff) },
    }).select('videoPath gifPath imagePath thumbnailPath _id');

    if (oldEvents.length === 0) {
      console.log('[cleanup] No old clips to remove');
      return { deletedClips: 0 };
    }

    let deletedFiles = 0;
    for (const event of oldEvents) {
      for (const relPath of [event.videoPath, event.gifPath, event.imagePath, event.thumbnailPath]) {
        if (relPath) {
          const fullPath = path.join(UPLOADS_DIR, relPath);
          if (await deleteFile(fullPath)) deletedFiles++;
        }
      }
      await Event.deleteOne({ _id: event._id });
    }

    console.log(`[cleanup] Deleted ${deletedFiles} clip files, ${oldEvents.length} event records`);
    return { deletedClips: oldEvents.length, deletedFiles };
  } catch (err) {
    console.error('[cleanup] Clip cleanup error:', err.message);
    return { error: err.message };
  }
}

async function cleanUpOrphanedClips() {
  try {
    const clipDirs = path.join(CLIPS_DIR);
    if (!fs.existsSync(clipDirs)) return { orphaned: 0 };

    const dbClips = await Event.find({ type: 'clip' }).select('videoPath gifPath').lean();
    const dbPaths = new Set(
      dbClips.flatMap((c) => [c.videoPath, c.gifPath].filter(Boolean))
    );

    let orphaned = 0;
    const dirs = await fs.promises.readdir(CLIPS_DIR).catch(() => []);
    for (const dateDir of dirs) {
      const datePath = path.join(CLIPS_DIR, dateDir);
      const stat = await fs.promises.stat(datePath).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      const files = await fs.promises.readdir(datePath).catch(() => []);
      for (const file of files) {
        const relPath = `clips/${dateDir}/${file}`;
        if (!dbPaths.has(relPath)) {
          const fullPath = path.join(CLIPS_DIR, dateDir, file);
          if (await deleteFile(fullPath)) orphaned++;
        }
      }

      const remaining = await fs.promises.readdir(datePath).catch(() => []);
      if (remaining.length === 0) {
        try { await fs.promises.rmdir(datePath); } catch (_) {}
      }
    }

    if (orphaned > 0) {
      console.log(`[cleanup] Removed ${orphaned} orphaned clip files`);
    }
    return { orphaned };
  } catch (err) {
    console.warn('[cleanup] Orphaned clip cleanup error:', err.message);
    return { error: err.message };
  }
}

async function cleanUpTempFiles() {
  try {
    const tmpFiles = await fs.promises.readdir(UPLOADS_DIR).catch(() => []);
    const now = Date.now();
    const MAX_AGE_MS = 6 * 60 * 60 * 1000;

    let removed = 0;
    for (const file of tmpFiles) {
      if (file.startsWith('watch_tmp_') || file.startsWith('tmp_')) {
        const fullPath = path.join(UPLOADS_DIR, file);
        const stat = await fs.promises.stat(fullPath).catch(() => null);
        if (stat && now - stat.mtimeMs > MAX_AGE_MS) {
          if (await deleteFile(fullPath)) removed++;
        }
      }
    }

    return { removedTempFiles: removed };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Continuous recordings ─────────────────────────────────────────────────────

/** Delete one indexed segment: file first, then its row. */
async function dropRecording(rec) {
  if (rec.filePath) await deleteFile(path.join(UPLOADS_DIR, rec.filePath));
  await Recording.deleteOne({ _id: rec._id });
}

/** Age-based retention for continuous recordings. */
async function cleanUpOldRecordings() {
  const cutoff = new Date(Date.now() - RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    const old = await Recording.find({ startedAt: { $lt: cutoff } })
      .select('filePath _id')
      .lean();
    for (const rec of old) await dropRecording(rec);
    if (old.length) {
      console.log(`[cleanup] Removed ${old.length} recording segment(s) older than ${RECORD_RETENTION_DAYS}d`);
    }
    await pruneEmptyRunDirs();
    return { deletedRecordings: old.length };
  } catch (err) {
    console.warn('[cleanup] Recording retention error:', err.message);
    return { error: err.message };
  }
}

/** Free bytes on the volume holding uploads/, or null if unavailable. */
async function freeBytes() {
  try {
    const st = await fs.promises.statfs(UPLOADS_DIR);
    return st.bavail * st.bsize;
  } catch (_) {
    return null;
  }
}

/**
 * Evict oldest-first until the free-space floor is satisfied. This runs on its
 * own short timer rather than the 24h cleanup cycle: at ~13 GB/day a daily sweep
 * would let the disk fill long before it fired.
 */
async function enforceDiskFloor() {
  const floor = RECORD_MIN_FREE_GB * 1024 ** 3;
  let free = await freeBytes();
  if (free === null) return { skipped: 'statfs unavailable' };
  if (free >= floor) return { evicted: 0, freeGb: +(free / 1024 ** 3).toFixed(1) };

  let evicted = 0;
  // Oldest first, in batches, re-checking free space as we go.
  while (free !== null && free < floor) {
    const batch = await Recording.find({}).sort({ startedAt: 1 }).limit(20).select('filePath _id sizeBytes').lean();
    if (!batch.length) break;
    for (const rec of batch) {
      await dropRecording(rec);
      evicted += 1;
    }
    free = await freeBytes();
  }
  if (evicted) {
    console.warn(`[cleanup] Disk floor (${RECORD_MIN_FREE_GB}GB): evicted ${evicted} oldest segment(s), free now ${(free / 1024 ** 3).toFixed(1)}GB`);
  }
  await pruneEmptyRunDirs();
  return { evicted, freeGb: free === null ? null : +(free / 1024 ** 3).toFixed(1) };
}

/** Remove run directories left empty after their segments were deleted. */
async function pruneEmptyRunDirs() {
  try {
    const cams = await fs.promises.readdir(RECORDINGS_DIR, { withFileTypes: true }).catch(() => []);
    for (const cam of cams) {
      if (!cam.isDirectory()) continue;
      const camDir = path.join(RECORDINGS_DIR, cam.name);
      const runs = await fs.promises.readdir(camDir, { withFileTypes: true }).catch(() => []);
      for (const run of runs) {
        if (!run.isDirectory()) continue;
        const runDir = path.join(camDir, run.name);
        const files = await fs.promises.readdir(runDir).catch(() => []);
        // Only the segment list left => the run is fully reaped.
        if (files.length === 0 || (files.length === 1 && files[0] === 'segments.csv')) {
          for (const f of files) await deleteFile(path.join(runDir, f));
          try { await fs.promises.rmdir(runDir); } catch (_) {}
        }
      }
    }
  } catch (_) { /* best effort */ }
}

async function runCleanup() {
  const result = {};
  result.clipCleanup = await cleanUpOldClips();
  result.orphanCleanup = await cleanUpOrphanedClips();
  result.tempCleanup = await cleanUpTempFiles();
  result.recordingCleanup = await cleanUpOldRecordings();
  result.diskFloor = await enforceDiskFloor();
  return result;
}

function startCleanupScheduler() {
  const intervalHours = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '24', 10);
  const intervalMs = intervalHours * 60 * 60 * 1000;

  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(async () => {
    console.log('[cleanup] Scheduled cleanup started');
    const result = await runCleanup();
    console.log('[cleanup] Scheduled cleanup completed:', JSON.stringify(result));
  }, intervalMs);

  console.log(`[cleanup] Scheduler started (interval: ${intervalHours}h)`);

  // Continuous recording fills disk far faster than the 24h cycle can react, so
  // the free-space floor gets its own short-interval sweep.
  if (recordingSweepTimer) clearInterval(recordingSweepTimer);
  recordingSweepTimer = setInterval(async () => {
    try {
      const r = await enforceDiskFloor();
      if (r.evicted) console.log('[cleanup] Recording sweep:', JSON.stringify(r));
    } catch (_) {}
  }, RECORD_SWEEP_MIN * 60 * 1000);
  console.log(`[cleanup] Recording disk-floor sweep every ${RECORD_SWEEP_MIN}m (floor ${RECORD_MIN_FREE_GB}GB)`);

  runCleanup().then((result) => {
    console.log('[cleanup] Initial cleanup done:', JSON.stringify(result));
  }).catch(() => {});
}

function stopCleanupScheduler() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.log('[cleanup] Scheduler stopped');
  }
  if (recordingSweepTimer) {
    clearInterval(recordingSweepTimer);
    recordingSweepTimer = null;
  }
}

module.exports = {
  runCleanup,
  startCleanupScheduler,
  stopCleanupScheduler,
  cleanUpOldClips,
  cleanUpOrphanedClips,
  cleanUpTempFiles,
  cleanUpOldRecordings,
  enforceDiskFloor,
  CLIP_RETENTION_DAYS,
  RECORD_RETENTION_DAYS,
};
