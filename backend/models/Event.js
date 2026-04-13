const mongoose = require('mongoose');

const bboxSchema = new mongoose.Schema({
  x: Number,
  y: Number,
  width: Number,
  height: Number,
}, { _id: false });

const personSchema = new mongoose.Schema({
  confidence: Number,
  bbox: bboxSchema,
}, { _id: false });

const vehicleSchema = new mongoose.Schema({
  type: String,
  confidence: Number,
  bbox: bboxSchema,
}, { _id: false });

const licensePlateSchema = new mongoose.Schema({
  plateNumber: String,
  confidence: Number,
  bbox: bboxSchema,
}, { _id: false });

const analysisSchema = new mongoose.Schema({
  persons: [personSchema],
  vehicles: [vehicleSchema],
  licensePlates: [licensePlateSchema],
}, { _id: false });

const eventSchema = new mongoose.Schema({
  cameraId: { type: mongoose.Schema.Types.ObjectId, ref: 'Camera', required: true },
  capturedAt: { type: Date, default: Date.now },
  imagePath: { type: String, required: true },
  thumbnailPath: { type: String, default: '' },
  analysis: { type: analysisSchema, default: () => ({}) },
  tags: [String],
  notes: { type: String, default: '' },
  type: { type: String, enum: ['image', 'clip'], default: 'image' },
  clipDuration: { type: Number, default: null },
  videoPath: { type: String, default: '' },
  gifPath: { type: String, default: '' },
  recordingStart: { type: Date, default: null },
  recordingEnd: { type: Date, default: null },
}, {
  timestamps: true,
});

eventSchema.index({ cameraId: 1 });
eventSchema.index({ capturedAt: -1 });
eventSchema.index({ tags: 1 });
eventSchema.index({ tags: 'text', notes: 'text' });
eventSchema.index({ type: 1 });
eventSchema.index({ recordingStart: -1 });

module.exports = mongoose.model('Event', eventSchema);
