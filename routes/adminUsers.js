// routes/adminUsers.js
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const AdminUser = require('../models/AdminUser');

const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

const { sendPasswordResetMail } = require('../utils/mailer');

const { Types } = require('mongoose');
const isValidId = (s) => typeof s === 'string' && Types.ObjectId.isValid(s);

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











router.get('/profile', adminAuth, async (req, res) => {
  try {
    const q = req.query || {};
    const effId = (q.id || req.providerId || '').toString().trim();
    const email = (q.email || '').toString().trim().toLowerCase();

    let user = null;
    if (effId) {
      if (!isValidId(effId)) {
        return res.status(400).json({ ok: false, error: 'Invalid id format' });
      }
      user = await AdminUser.findById(effId).lean();
    } else if (email) {
      user = await AdminUser.findOne({ email }).lean();
    } else {
      return res.status(400).json({ ok: false, error: 'id or email required' });
    }

    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    return res.json({
      ok: true,
      user: {
        id: String(user._id),
        fullName: user.fullName,
        email: user.email,
        avatarUrl: user.avatarUrl || null,
      },
    });
  } catch (e) {
    console.error('[GET /profile] error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// --- POST /api/admin/auth/profile ---
router.post('/profile', adminAuth, async (req, res) => {
  try {
    const { id: bodyId, email, fullName, avatar } = req.body || {};
    const effId = (bodyId || req.providerId || '').toString().trim();

    let user = null;
    if (effId) {
      if (!isValidId(effId)) {
        return res.status(400).json({ ok: false, error: 'Invalid id format' });
      }
      user = await AdminUser.findById(effId);
    } else if (email) {
      user = await AdminUser.findOne({ email: String(email).trim().toLowerCase() });
    } else {
      return res.status(400).json({ ok: false, error: 'id or email required' });
    }

    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    if (typeof fullName === 'string') user.fullName = fullName.trim();

    if (typeof email === 'string' && email.trim()) {
      const next = String(email).trim().toLowerCase();
      if (next !== user.email) {
        const exists = await AdminUser.findOne({ email: next });
        if (exists) return res.status(409).json({ ok: false, error: 'Email already in use' });
        user.email = next;
      }
    }

    if (typeof avatar === 'string' && avatar.startsWith('data:')) {
      user.avatarUrl = avatar; // dev: Data-URL speichern
    }

    await user.save();
    return res.json({
      ok: true,
      user: {
        id: String(user._id),
        fullName: user.fullName,
        email: user.email,
        avatarUrl: user.avatarUrl || null,
      },
    });
  } catch (e) {
    console.error('[POST /profile] error:', e);
    return res.status(500).json({ ok: false, error: 'Update failed' });
  }
});




















router.post('/forgot', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email' });
    }

    const user = await AdminUser.findOne({ email }).exec();

    // Generate token (plain) – for production prefer hashing the token
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      user.resetToken = token;
      user.resetTokenExp = new Date(Date.now() + 60 * 60 * 1000); // 1h
      await user.save();

      const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
      const link = `${base}/admin/new-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

      // send email (non-blocking)
      sendPasswordResetMail(email, link).catch(err =>
        console.error('[mailer] reset mail failed:', err?.message || err)
      );
    }

    // Always OK (so attackers can't probe which emails exist)
    return res.json({ ok: true, message: 'If the email exists, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/auth/reset
 * Body: { token, password }
 */
router.post('/reset', async (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password too short' });

    const user = await AdminUser.findOne({
      resetToken: token,
      resetTokenExp: { $gt: new Date() },
    }).exec();

    if (!user) {
      return res.status(400).json({ ok: false, error: 'Invalid or expired token' });
    }

    // hash new password
    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(password, salt);

    // clear reset fields
    user.resetToken = undefined;
    user.resetTokenExp = undefined;

    await user.save();
    return res.json({ ok: true, message: 'Password updated' });
  } catch (err) {
    next(err);
  }
});












// Wer bin ich?  → /api/admin/auth/me
router.get('/me', adminAuth, async (req, res) => {
  try {
    const u = req.user || {};
    // Versuch: anhand id oder email den Datensatz laden (damit Name immer aktuell ist)
    let doc = null;
    if (u._id || u.id) {
      const id = String(u._id || u.id);
      doc = await AdminUser.findById(id).lean();
    }
    if (!doc && u.email) {
      doc = await AdminUser.findOne({ email: String(u.email).toLowerCase() }).lean();
    }

    const fullName =
      (doc && doc.fullName) ||
      u.fullName ||
      u.name ||
      '';

    const email = (doc && doc.email) || u.email || '';

    return res.json({
      ok: true,
      user: {
        id: String((doc && doc._id) || u._id || u.id || ''),
        email,
        fullName,
        displayName: fullName || email || 'Admin',
      },
    });
  } catch (e) {
    console.error('[adminUsers/me] failed:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});







module.exports = router;
