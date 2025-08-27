// routes/adminUsers.js
const express = require('express');
const bcrypt = require('bcryptjs');
const AdminUser = require('../models/AdminUser');

const router = express.Router();

// routes/adminUsers.js
router.post('/signup', async (req, res) => {
  try {
    const { fullName, email, password } = req.body || {};
    const errors = {};
    const normalizedEmail = String(email || '').trim().toLowerCase();

    if (!fullName?.trim()) errors.fullName = 'Required';
    if (!/.+@.+\..+/.test(normalizedEmail)) errors.email = 'Invalid email';
    if (!password || password.length < 6) errors.password = 'Min. 6 characters';
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, errors });

    // Optional: ENV-Admin für Signup sperren, damit es nicht wie ein „Bug“ wirkt
    const reserved = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (reserved && normalizedEmail === reserved) {
      return res.status(409).json({ ok: false, errors: { email: 'This email is reserved for system admin' } });
    }

    const existing = await AdminUser.findOne({ email: normalizedEmail });
    if (existing) return res.status(409).json({ ok: false, errors: { email: 'Email already registered' } });

    const passwordHash = await bcrypt.hash(password, 12); // 12 statt 10 (ok in Dev)
    const user = await AdminUser.create({
      fullName: fullName.trim(),
      email: normalizedEmail,
      passwordHash,
    });

    return res.status(201).json({
      ok: true,
      user: { id: user._id, fullName: user.fullName, email: user.email }
    });
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({ ok: false, errors: { email: 'Email already registered' } });
    }
    if (e?.name === 'ValidationError') {
      return res.status(400).json({ ok: false, error: 'Validation failed', details: e.errors });
    }
    console.error('signup error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Missing credentials' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await AdminUser.findOne({ email: normalizedEmail });
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    return res.json({ ok: true, user: { id: user._id, fullName: user.fullName, email: user.email } });
  } catch (e) {
    console.error('login error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/auth  (simple list)
router.get('/', async (_req, res) => {
  const users = await AdminUser
    .find()
    .select('_id fullName email createdAt')
    .sort({ createdAt: -1 });
  res.json({ ok: true, users });
});

module.exports = router;
