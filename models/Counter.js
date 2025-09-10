// models/Counter.js
const mongoose = require('mongoose');

const CounterSchema = new mongoose.Schema({
  key: { type: String, unique: true }, // z.B. "invoice:FO:2025" oder "cancel:K:2024"
  seq: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Counter', CounterSchema);
