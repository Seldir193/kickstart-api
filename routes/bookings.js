const express = require('express');
const Booking = require('../models/Booking');

const router = express.Router();

function validate(payload) {
  const errors = {};
  if (!payload.firstName?.trim()) errors.firstName = 'Required';
  if (!payload.lastName?.trim()) errors.lastName = 'Required';
  if (!/^\S+@\S+\.\S+$/.test(payload.email || '')) errors.email = 'Invalid email';
  const age = Number(payload.age);
  if (!age || age < 5 || age > 19) errors.age = 'Age 5–19';
  if (!payload.date) errors.date = 'Pick a date';
  if (!['U8','U10','U12','U14','U16','U18'].includes(payload.level)) errors.level = 'Invalid level';
  return errors;
}

// Create
router.post('/', async (req, res) => {
  try {
    const errors = validate(req.body);
    if (Object.keys(errors).length) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', errors });
    }
    const created = await Booking.create(req.body);
    return res.status(201).json({ ok: true, booking: created });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

// List (latest 100)
router.get('/', async (_req, res) => {
  try {
    const items = await Booking.find().sort({ createdAt: -1 }).limit(100);
    return res.json({ ok: true, bookings: items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

module.exports = router;
