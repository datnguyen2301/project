const fs = require('fs');
const path = require('path');
const Event = require('../models/Event');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const CLIPS_DIR = path.join(UPLOADS_DIR, 'clips');
const CACHE_DIR = path.join(UPLOADS_DIR, '.watcher_cache');

const CLIP_RETENTION_DAYS = parseInt(process.env.CLIP_RETENTION_DAYS || '30', 10);
const CLIP_RETENTION_MS = CLIP_RETENTION_DAYS * 24 * 60 * 60 * 1000;

let cleanupTimer = null;

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

async function runCleanup() {
  const result = {};
  result.clipCleanup = await cleanUpOldClips();
  result.orphanCleanup = await cleanUpOrphanedClips();
  result.tempCleanup = await cleanUpTempFiles();
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
}

module.exports = {
  runCleanup,
  startCleanupScheduler,
  stopCleanupScheduler,
  cleanUpOldClips,
  cleanUpOrphanedClips,
  cleanUpTempFiles,
  CLIP_RETENTION_DAYS,
};
