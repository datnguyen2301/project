require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const connectDB = require('./db');

// ── Global error handlers — keep server alive on unexpected errors ──
process.on('uncaughtException', (err, origin) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error('[FATAL] Stack:', err.stack);
  console.error('[FATAL] Origin:', origin);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[WARN] Unhandled Rejection at:', promise);
  console.error('[WARN] Reason:', reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error && reason.stack) {
    console.error('[WARN] Stack:', reason.stack);
  }
});

const camerasRouter = require('./routes/cameras');
const eventsRouter = require('./routes/events');
const ezvizRouter = require('./routes/ezviz');
const ipcamRouter = require('./routes/ipcam');
const watcherRouter = require('./routes/watcher');
const authMiddleware = require('./middleware/auth');
const authRouter = require('./routes/auth');
const blacklistRouter = require('./routes/blacklist');
const streamRouter = require('./routes/stream');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/streams', express.static(path.join(__dirname, 'streams'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.m3u8')) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-cache, no-store');
    } else if (filePath.endsWith('.ts')) {
      res.set('Content-Type', 'video/mp2t');
      res.set('Cache-Control', 'no-cache');
    } else if (filePath.endsWith('.mp4')) {
      res.set('Content-Type', 'video/mp4');
      res.set('Cache-Control', 'no-cache');
    } else if (filePath.endsWith('.gif')) {
      res.set('Content-Type', 'image/gif');
      res.set('Cache-Control', 'no-cache');
    }
  },
}));

app.get('/api/health', (_req, res) => {
  res.json({ message: 'Backend is running', timestamp: new Date().toISOString() });
});

app.get('/api/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(keepAlive); }
  }, 25000);

  const id = addClient(res);
  req.on('close', () => {
    clearInterval(keepAlive);
    removeClient(id);
  });
});

app.use('/api/auth', authRouter);

app.use('/api/cameras', authMiddleware, camerasRouter);
app.use('/api/events', authMiddleware, eventsRouter);
app.use('/api/ezviz', authMiddleware, ezvizRouter);
app.use('/api/ipcam', authMiddleware, ipcamRouter);
app.use('/api/watcher', authMiddleware, watcherRouter);
app.use('/api/blacklist', authMiddleware, blacklistRouter);
app.use('/api/stream', authMiddleware, streamRouter);

// ── Express global error handler — catches all unhandled route errors ──
app.use((err, _req, res, _next) => {
  console.error('[ERROR] Unhandled route error:', err.message);
  console.error('[ERROR] Stack:', err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const { restoreWatchers } = require('./services/watcher');
const { checkFfmpeg } = require('./services/stream');
const { addClient, removeClient } = require('./services/sse');
const { startCleanupScheduler } = require('./services/cleanup');

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    const raw = String(process.env.RESTORE_AUTOWATCH_ON_START || '').trim().toLowerCase();
    const restoreOnStart = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
    if (restoreOnStart) {
      restoreWatchers();
    } else {
      console.log('[watcher] Skipping restore on startup. Set RESTORE_AUTOWATCH_ON_START=true to re-enable.');
    }
    checkFfmpeg();
    startCleanupScheduler();
  });
});
