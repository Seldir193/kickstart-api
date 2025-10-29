// models/Coach.js
const mongoose = require('mongoose');

const CoachSchema = new mongoose.Schema({
  slug:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  firstName:   { type: String, default: '' },
  lastName:    { type: String, default: '' },
  name:        { type: String, default: '' },   // optional Gesamtname
  position:    { type: String, default: 'Trainer' },
  degree:      { type: String, default: '' },
  since:       { type: String, default: '' },
  dfbLicense:  { type: String, default: '' },
  mfsLicense:  { type: String, default: '' },
  favClub:     { type: String, default: '' },
  favCoach:    { type: String, default: '' },
  favTrick:    { type: String, default: '' },
  photoUrl:    { type: String, default: '' },
}, { timestamps: true });

CoachSchema.index({ slug: 1 }, { unique: true });
CoachSchema.index({ name: 'text', firstName: 'text', lastName: 'text', position: 'text' });

module.exports = mongoose.model('Coach', CoachSchema);
