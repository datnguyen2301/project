const mongoose = require('mongoose');

const blacklistSchema = new mongoose.Schema({
  plateNumber: { type: String, required: true, unique: true },
  reason: { type: String, default: '' },
  addedAt: { type: Date, default: Date.now },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Blacklist', blacklistSchema);
