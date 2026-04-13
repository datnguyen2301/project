const { performance } = require('perf_hooks');

const STOP_SIGNAL = {};

class RingBuffer {
  constructor(cameraId, opts = {}) {
    this.cameraId = cameraId;
    this.fps = opts.fps || 5;
    this.bufferSeconds = opts.bufferSeconds || 30;
    this.maxFrames = this.bufferSeconds * this.fps;
    this.frames = [];
    this.stopped = undefined;
    this.stats = {
      pushedFrames: 0,
      droppedFrames: 0,
      memoryEstimateBytes: 0,
    };
  }

  push(buffer, timestamp) {
    if (this.stopped === STOP_SIGNAL) return;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return;

    const ts = timestamp || performance.now();
    const frameSize = buffer.length;

    if (this.frames.length >= this.maxFrames) {
      this.frames.shift();
      this.stats.droppedFrames++;
    }

    this.frames.push({ buffer, ts, frameSize });
    this.stats.pushedFrames++;
    this.stats.memoryEstimateBytes = this.frames.reduce((acc, f) => acc + f.frameSize, 0);
  }

  getRecent(seconds) {
    const cutoff = performance.now() - seconds * 1000;
    return this.frames.filter((f) => f.ts >= cutoff);
  }

  getWindow(centerTs, beforeSeconds, afterSeconds) {
    const beforeMs = beforeSeconds * 1000;
    const afterMs = afterSeconds * 1000;
    const startTs = centerTs - beforeMs;
    const endTs = centerTs + afterMs;
    return this.frames.filter((f) => f.ts >= startTs && f.ts <= endTs);
  }

  getFrameCount() {
    return this.frames.length;
  }

  getOldestTs() {
    return this.frames.length > 0 ? this.frames[0].ts : null;
  }

  getNewestTs() {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1].ts : null;
  }

  getMemoryMB() {
    return (this.stats.memoryEstimateBytes / 1024 / 1024).toFixed(2);
  }

  clear() {
    this.frames = [];
    this.stats.memoryEstimateBytes = 0;
  }

  stop() {
    this.stopped = STOP_SIGNAL;
    this.clear();
  }

  destroy() {
    this.stop();
  }
}

const buffers = new Map();

function getBuffer(cameraId, opts = {}) {
  if (buffers.has(cameraId)) {
    return buffers.get(cameraId);
  }
  const buf = new RingBuffer(cameraId, opts);
  buffers.set(cameraId, buf);
  return buf;
}

function hasBuffer(cameraId) {
  return buffers.has(cameraId);
}

function removeBuffer(cameraId) {
  const buf = buffers.get(cameraId);
  if (buf) {
    buf.destroy();
    buffers.delete(cameraId);
  }
}

function stopBuffer(cameraId) {
  const buf = buffers.get(cameraId);
  if (buf) {
    buf.stop();
    buffers.delete(cameraId);
  }
}

function getAllBufferStats() {
  const out = [];
  for (const [cameraId, buf] of buffers) {
    out.push({
      cameraId,
      frameCount: buf.getFrameCount(),
      oldestTs: buf.getOldestTs(),
      newestTs: buf.getNewestTs(),
      memoryMB: buf.getMemoryMB(),
      stats: { ...buf.stats },
    });
  }
  return out;
}

module.exports = {
  RingBuffer,
  getBuffer,
  hasBuffer,
  removeBuffer,
  stopBuffer,
  getAllBufferStats,
  STOP_SIGNAL,
};
