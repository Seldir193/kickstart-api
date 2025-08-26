// routes/bookings.js
const express = require('express');
const crypto = require('crypto');

const Booking = require('../models/Booking');
const adminAuth = require('../middleware/adminAuth');
const { bookingPdfBuffer } = require('../utils/pdf');
const { sendMail } = require('../utils/mailer');
const Offer = require('../models/Offer');   

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

    // OPTIONAL: look up offer for email summary (does NOT block booking if missing)
    let offerDoc = null;
    if (req.body.offerId) {
      try {
        offerDoc = await Offer.findById(String(req.body.offerId)).lean();
      } catch (_) { /* ignore invalid id */ }
    }

    // ⬇⬇⬇ DUPLICATE CHECK: same offer + same first/last name (case-insensitive)
    if (offerDoc) {
      const first = String(req.body.firstName || '').trim();
      const last  = String(req.body.lastName  || '').trim();

      if (first && last) {
        const exists = await Booking.findOne({
          offerId:  offerDoc._id,
          firstName:{ $regex: `^${escapeRegex(first)}$`, $options: 'i' },
          lastName: { $regex: `^${escapeRegex(last)}$`,  $options: 'i' },
          status:   { $ne: 'deleted' },  // allow rebook after soft-delete
        }).lean();

        if (exists) {
          return res.status(409).json({
            ok: false,
            code: 'DUPLICATE',
            errors: {
              firstName: 'A booking with this first/last name already exists for this offer.',
              lastName:  'Please use different names or contact us.',
            },
          });
        }
      }
    }
    // ⬆⬆⬆ END DUPLICATE CHECK

    const created = await Booking.create({
      ...req.body,
      ...(offerDoc ? { offerId: offerDoc._id } : {}),
      status: 'pending',
      adminNote: req.body.adminNote || '',
    });

    // fire-and-forget acknowledgment email
    (async () => {
      try {
        const offerLine = offerDoc
          ? (offerDoc.title || `${offerDoc.type ?? ''} • ${offerDoc.location ?? ''}`)
          : 'Ohne konkretes Angebot';

        const subject = 'Eingangsbestätigung – deine Buchungsanfrage';
        const text = [
          `Hallo ${created.firstName},`,
          ``,
          `vielen Dank für deine Buchungsanfrage bei der KickStart Academy.`,
          `Wir haben deine Anfrage erhalten und melden uns zeitnah per E-Mail.`,
          ``,
          `Zusammenfassung:`,
          `- Angebot: ${offerLine}`,
          `- Datum: ${created.date}`,
          `- Level: ${created.level}`,
          `- Alter: ${created.age}`,
          created.message ? `- Nachricht: ${created.message}` : '',
          ``,
          `Bei Rückfragen kannst du einfach auf diese E-Mail antworten.`,
          `Sportliche Grüße`,
          `KickStart Academy`,
        ].filter(Boolean).join('\n');

        const html = `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif">
            <h2 style="margin:0 0 8px">Danke für deine Buchungsanfrage, ${escapeHtml(created.firstName)}!</h2>
            <p>Wir haben deine Anfrage erhalten und melden uns zeitnah per E-Mail.</p>
            <h3 style="margin:16px 0 8px">Zusammenfassung</h3>
            <ul>
              <li><strong>Angebot:</strong> ${escapeHtml(offerLine)}</li>
              <li><strong>Datum:</strong> ${escapeHtml(created.date)}</li>
              <li><strong>Level:</strong> ${escapeHtml(created.level)}</li>
              <li><strong>Alter:</strong> ${created.age}</li>
            </ul>
            ${created.message ? `<p><strong>Nachricht:</strong><br>${nl2br(escapeHtml(created.message))}</p>` : ''}
            <p style="margin-top:16px">Bei Rückfragen kannst du einfach auf diese E-Mail antworten.</p>
            <p>Sportliche Grüße<br/>KickStart Academy</p>
          </div>
        `.trim();

        await sendMail({ to: created.email, subject, text, html });
      } catch (mailErr) {
        console.warn('[bookings] ack email failed:', mailErr?.message || mailErr);
      }
    })();

    return res.status(201).json({ ok: true, booking: created });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

// helpers (falls noch nicht vorhanden)
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function nl2br(s) {
  return String(s).replace(/\n/g, '<br>');
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}











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





// Change status (ADMIN) — sends emails on first transition to "cancelled" or "processing"
router.patch('/:id/status', adminAuth, async (req, res) => {
  try {
    const { status } = req.body || {};
    const forceMail = String(req.query.force || '') === '1';

    if (!ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', error: 'Invalid status' });
    }

    // Vorherigen Datensatz laden (für Idempotenz & Mail-Infos)
    const prev = await Booking.findById(req.params.id);
    if (!prev) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

    // Status aktualisieren
    const updated = await Booking.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!updated) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

    // Hilfswerte für Mails
    const fullName = updated.fullName || `${updated.firstName} ${updated.lastName}`.trim();
    const program  = updated.program  || updated.level;
    const dateDE   = fmtDE(updated.date);

    let mailSentProcessing = false;
    let mailSentCancelled  = false;

    /* ------------------------ CANCELLED → Storno-Mail ------------------------ */
    if (status === 'cancelled' && prev.status !== 'cancelled') {
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
        mailSentCancelled = true;
        console.log('MAIL SENT: cancellation →', updated.email);
      } catch (mailErr) {
        console.warn('Cancellation mail failed:', mailErr?.message || mailErr);
        // UI nicht blockieren
      }
    }

    /* -------------------- PROCESSING → Mail (idempotent) -------------------- */
    // Beim ersten Wechsel auf "processing" E-Mail senden; mit ?force=1 auch erneut (für Tests)
    if (status === 'processing' && (prev.status !== 'processing' || forceMail)) {
      console.log('[BOOKINGS] processing-mail enter', {
        id: updated._id.toString(),
        prev: prev.status,
        next: status,
        email: updated.email,
        forceMail,
      });

      try {
        await sendMail({
          to: updated.email,
          subject: `In Bearbeitung – ${program} am ${dateDE}${updated.confirmationCode ? ` (${updated.confirmationCode})` : ''}`,
          html: `
            <p>Hallo ${fullName},</p>
            <p>deine Buchung ist aktuell <b>in Bearbeitung</b>.</p>
            <ul>
              <li><strong>Programm:</strong> ${program}</li>
              <li><strong>Datum:</strong> ${dateDE}</li>
              ${updated.confirmationCode ? `<li><strong>Referenz:</strong> ${updated.confirmationCode}</li>` : '' }
            </ul>
            <p>Wir melden uns, sobald es ein Update gibt.</p>
            <p>Sportliche Grüße<br/>KickStart Academy</p>
          `,
          text: `
Hallo ${fullName},

deine Buchung ist aktuell in Bearbeitung.

Programm: ${program}
Datum: ${dateDE}${updated.confirmationCode ? `\nReferenz: ${updated.confirmationCode}` : ''}

Wir melden uns, sobald es ein Update gibt.

Sportliche Grüße
KickStart Academy
          `.trim(),
        });

        mailSentProcessing = true;
        console.log('MAIL SENT: processing →', updated.email);
      } catch (mailErr) {
        console.error('[BOOKINGS] processing-mail FAILED:', mailErr?.message || mailErr);
        // UI nicht blockieren
      }
    }

    return res.json({
      ok: true,
      booking: updated,
      mailSentProcessing,
      mailSentCancelled,
    });
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