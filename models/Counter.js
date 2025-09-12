



// models/Counter.js
'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const CounterSchema = new Schema({
  _id: { type: String, required: true }, // z.B. "customer:<ownerId>" oder "invoice:AT:2025"
  seq: { type: Number, default: 0 },
}, { versionKey: false });

module.exports = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);

