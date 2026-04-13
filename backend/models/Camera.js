const mongoose = require('mongoose');

const cameraSchema = new mongoose.Schema({
  name: { type: String, required: true },
  location: { type: String, default: '' },
  type: { type: String, enum: ['ip', 'webhook', 'manual'], default: 'manual' },
  ipAddress: { type: String, default: '' },
  status: { type: String, enum: ['online', 'offline'], default: 'offline' },
  autoWatch: { type: Boolean, default: false },
  verifyCode: { type: String, default: '' },
  rtspHost: { type: String, default: '' },
  watchEventCount: { type: Number, default: 0 },
  watchLastEventAt: { type: Date, default: null },
  autoRecord: { type: Boolean, default: false },
  recordingBufferSeconds: { type: Number, default: 30 },
  recordingCooldown: { type: Number, default: 10 },
  recordingMaxDuration: { type: Number, default: 300 },
  watchMinConfidence: { type: Number, default: 0.4 },
  watchMinPersonSize: { type: Number, default: 0 },
  watchDetectTargets: { type: [String], default: ['person', 'vehicle'] },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Camera', cameraSchema);
