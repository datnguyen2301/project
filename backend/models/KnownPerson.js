const mongoose = require('mongoose');

// One enrolled ("known") person. Each enrollment photo contributes one 128-d
// SFace embedding; matching compares a detected face against every embedding
// of every person and takes the best cosine similarity.
const knownPersonSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  embeddings: { type: [[Number]], default: [] },
  imagePaths: { type: [String], default: [] }, // relative to uploads/, e.g. faces/<uuid>.jpg
  notes: { type: String, default: '' },
}, {
  timestamps: true,
});

module.exports = mongoose.model('KnownPerson', knownPersonSchema);
