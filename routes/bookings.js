// routes/bookings.js
const express = require('express');
const crypto = require('crypto');

const Booking = require('../models/Booking');
const adminAuth = require('../middleware/adminAuth');
const { bookingPdfBuffer } = require('../utils/pdf');
const { sendMail } = require('../utils/mailer');

const router = express.Router();

/* ----------------------------- Helpers ------------------------------ */
function validate(payload) {
  const errors = {};
  if (!payload.firstName?.trim()) errors.firstName = 'Required';
  if (!payload.lastName?.trim()) errors.lastName = 'Required';
  if (!/^\S+@\S+\.\S+$/.test(payload.email || '')) errors.email = 'Invalid email';
  const age = Number(payload.age);
  if (!age || age < 5 || age > 19) errors.age = 'Age 5–19';
  if (!payload.date) errors.date = 'Pick a date'; // yyyy-mm-dd
  if (!['U8','U10','U12','U14','U16','U18'].includes(payload.level)) errors.level = 'Invalid level';
  return errors;
}
const ALLOWED_STATUS = ['pending','processing','confirmed','cancelled','deleted'];
const fmtDE = (isoDate) => {
  // "2025-09-01" -> "01.09.2025" (robust, kein TZ-Shift)
  const [y,m,d] = String(isoDate || '').split('-').map(n => parseInt(n,10));
  if (!y || !m || !d) return String(isoDate || '');
  return `${String(d).padStart(2,'0')}.${String(m).padStart(2,'0')}.${y}`;
};

/* ------------------------------ Routes ------------------------------ */

// Create (PUBLIC)
router.post('/', async (req, res) => {
  try {
    const errors = validate(req.body);
    if (Object.keys(errors).length) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', errors });
    }

    const created = await Booking.create({
      ...req.body,
      status: 'pending',
      adminNote: req.body.adminNote || '',
    });

    // Optional: Eingangsbestätigung (ohne PDF) – für später
    // await sendMail({ to: created.email, subject: 'Eingangsbestätigung …', text: '…' });

    return res.status(201).json({ ok: true, booking: created });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

// List (ADMIN)
router.get('/', adminAuth, async (req, res) => {
  try {
    const { status, limit = 200 } = req.query;
    const q = status && ALLOWED_STATUS.includes(status) ? { status } : {};
    const cap = Math.min(Number(limit) || 200, 500);
    const items = await Booking.find(q).sort({ createdAt: -1 }).limit(cap);
    return res.json({ ok: true, bookings: items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});




// Change status (ADMIN)  ✅ send cancellation mail on first switch to "cancelled"
router.patch('/:id/status', adminAuth, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', error: 'Invalid status' });
    }

    // Vorherigen Status laden, um Dopplungs-Mails zu vermeiden
    const prev = await Booking.findById(req.params.id);
    if (!prev) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

    const updated = await Booking.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!updated) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

    // Nur wenn jetzt "cancelled" und vorher NICHT "cancelled": Storno-Mail senden
    if (status === 'cancelled' && prev.status !== 'cancelled') {
      const fullName = updated.fullName || `${updated.firstName} ${updated.lastName}`.trim();
      const program  = updated.program  || updated.level;
      const dateDE   = fmtDE(updated.date);

      try {
        await sendMail({
          to: updated.email,
          subject: `Stornierung – ${program} am ${dateDE}${updated.confirmationCode ? ` (${updated.confirmationCode})` : ''}`,
          text: `
Hallo ${fullName},

leider müssen wir deine Buchung stornieren.

Programm: ${program}
Datum: ${dateDE}${updated.confirmationCode ? `\nBestätigungsnummer: ${updated.confirmationCode}` : ''}

Wenn du Fragen hast, antworte einfach auf diese E-Mail.

Sportliche Grüße
KickStart Academy
          `.trim(),
          html: `
            <p>Hallo ${fullName},</p>
            <p>leider müssen wir deine Buchung stornieren.</p>
            <ul>
              <li><strong>Programm:</strong> ${program}</li>
              <li><strong>Datum:</strong> ${dateDE}</li>
              ${updated.confirmationCode ? `<li><strong>Bestätigungsnummer:</strong> ${updated.confirmationCode}</li>` : ''}
            </ul>
            <p>Wenn du Fragen hast, antworte einfach auf diese E-Mail.</p>
            <p>Sportliche Grüße<br/>KickStart Academy</p>
          `,
        });
        console.log('MAIL SENT: cancellation →', updated.email);
      } catch (mailErr) {
        console.warn('Cancellation mail failed:', mailErr?.message || mailErr);
        // Wir antworten trotzdem 200, damit die UI nicht hängen bleibt
      }
    }

    return res.json({ ok: true, booking: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});






// Admin Notiz (ADMIN)
router.patch('/:id/note', adminAuth, async (req, res) => {
  try {
    const { adminNote = '' } = req.body || {};
    const updated = await Booking.findByIdAndUpdate(req.params.id, { adminNote }, { new: true });
    if (!updated) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });
    return res.json({ ok: true, booking: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});


// Soft delete (ADMIN)
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const updated = await Booking.findByIdAndUpdate(req.params.id, { status: 'deleted' }, { new: true });
    if (!updated) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });
    return res.json({ ok: true, booking: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});


// Confirm + send PDF (ADMIN) — idempotent, Resend via ?resend=1
router.post('/:id/confirm', adminAuth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ ok:false, error:'Not found' });

    const fullName = booking.fullName || `${booking.firstName} ${booking.lastName}`.trim();
    const program  = booking.program  || booking.level;
    const dateDE   = fmtDE(booking.date);
    const forceResend = String(req.query.resend || '') === '1';

    const alreadyConfirmed = booking.status === 'confirmed';

    // Sicherstellen, dass Code existiert
    if (!booking.confirmationCode) {
      booking.confirmationCode = 'KS-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    }

    // Nur beim ersten Bestätigen das Datum setzen
    if (!alreadyConfirmed) {
      booking.status = 'confirmed';
      booking.confirmedAt = new Date();
      await booking.save();
    }

    // Idempotenz: wenn bereits bestätigt und kein Resend, keine Mail nochmal senden
    if (alreadyConfirmed && !forceResend) {
      return res.json({ ok: true, booking, info: 'already confirmed (no email sent)' });
    }

    const pdf = await bookingPdfBuffer(booking);

    await sendMail({
      to: booking.email,
      subject: `Bestätigung – ${program} am ${dateDE} (${booking.confirmationCode})`,
      text: `
Hallo ${fullName},

deine Buchung wurde bestätigt.

Programm: ${program}
Datum: ${dateDE}
Bestätigungsnummer: ${booking.confirmationCode}

Die Bestätigung findest du im Anhang als PDF.

Sportliche Grüße
KickStart Academy
      `.trim(),
      html: `
        <p>Hallo ${fullName},</p>
        <p>deine Buchung wurde bestätigt.</p>
        <ul>
          <li><strong>Programm:</strong> ${program}</li>
          <li><strong>Datum:</strong> ${dateDE}</li>
          <li><strong>Bestätigungsnummer:</strong> ${booking.confirmationCode}</li>
        </ul>
        <p>Die Bestätigung findest du im Anhang als PDF.</p>
        <p>Sportliche Grüße<br/>KickStart Academy</p>
      `,
      attachments: [{ filename: `Bestaetigung-${program}-${dateDE}-${booking.confirmationCode}.pdf`, content: pdf }],
    });

    return res.json({ ok:true, booking });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
});

module.exports = router;