// routes/bookings.js
const express = require('express');
const crypto = require('crypto');

const Booking = require('../models/Booking');
const Offer = require('../models/Offer');
const adminAuth = require('../middleware/adminAuth'); // behalten (Auth), plus Owner-Scope via Header
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
  const [y,m,d] = String(isoDate || '').split('-').map(n => parseInt(n,10));
  if (!y || !m || !d) return String(isoDate || '');
  return `${String(d).padStart(2,'0')}.${String(m).padStart(2,'0')}.${y}`;
};
// owner aus Header
function getProviderId(req) {
  const v = req.get('x-provider-id');
  return v ? String(v).trim() : null;
}
function requireProvider(req, res) {
  const pid = getProviderId(req);
  if (!pid) {
    res.status(401).json({ ok: false, error: 'Unauthorized: missing provider' });
    return null;
  }
  return pid;
}
// helpers
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function nl2br(s) { return String(s).replace(/\n/g, '<br>'); }
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ------------------------------ Routes ------------------------------ */

/** PUBLIC/ADMIN: Create booking
 * POST /api/bookings
 * Body: { offerId, firstName, lastName, email, age, date, level, message? }
 * - Setzt owner automatisch via offerId→Offer.owner
 * - Falls Admin-UI (Header gesetzt), validiert, dass Offer zum Provider gehört
 */
router.post('/', async (req, res) => {
  try {
    const errors = validate(req.body);
    if (Object.keys(errors).length) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', errors });
    }

    if (!req.body.offerId) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', error: 'offerId is required' });
    }

    // Offer suchen (bestimmt Owner + Buchbarkeit)
    const offer = await Offer.findById(String(req.body.offerId)).select('_id owner title type location onlineActive').lean();
    if (!offer) return res.status(400).json({ ok: false, error: 'Offer not found' });
    if (offer.onlineActive === false) return res.status(400).json({ ok: false, error: 'Offer not bookable' });

    // Wenn Admin-UI (Provider-Header gesetzt), Konsistenz sicherstellen
    const pidHeader = getProviderId(req);
    if (pidHeader && String(offer.owner) !== pidHeader) {
      return res.status(403).json({ ok: false, error: 'Offer does not belong to this provider' });
    }

    // DUPLICATE: gleiches Offer + gleicher Name (case-insensitive), außer status=deleted
    const first = String(req.body.firstName || '').trim();
    const last  = String(req.body.lastName  || '').trim();
    if (first && last) {
      const exists = await Booking.findOne({
        offerId:  offer._id,
        firstName:{ $regex: `^${escapeRegex(first)}$`, $options: 'i' },
        lastName: { $regex: `^${escapeRegex(last)}$`,  $options: 'i' },
        status:   { $ne: 'deleted' },
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

    const created = await Booking.create({
      owner:   offer.owner,                      // <— OWNER setzen
      offerId: offer._id,
      firstName: first,
      lastName:  last,
      email:     String(req.body.email).trim().toLowerCase(),
      age:       Number(req.body.age),
      date:      String(req.body.date),
      level:     String(req.body.level),
      message:   req.body.message ? String(req.body.message) : '',
      status:    'pending',
      adminNote: req.body.adminNote || '',
    });

    // fire-and-forget acknowledgment email (nicht blockierend)
    (async () => {
      try {
        const offerLine = offer.title || `${offer.type ?? ''} • ${offer.location ?? ''}`;
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

/** ADMIN: List bookings (scoped)
 * GET /api/bookings?status=&q=&date=&page=&limit=
 */
router.get('/', adminAuth, async (req, res) => {
  try {
    const providerId = requireProvider(req, res);
    if (!providerId) return;

    const { status, q, date, page = 1, limit = 200 } = req.query;

    const filter = { owner: providerId };
    if (status && ALLOWED_STATUS.includes(String(status))) filter.status = String(status);
    if (date) filter.date = String(date);

    if (q && String(q).trim().length >= 2) {
      const needle = String(q).trim();
      filter.$or = [
        { firstName: { $regex: needle, $options: 'i' } },
        { lastName:  { $regex: needle, $options: 'i' } },
        { email:     { $regex: needle, $options: 'i' } },
        { message:   { $regex: needle, $options: 'i' } },
      ];
    }

    const p = Math.max(1, Number(page));
    const l = Math.max(1, Math.min(500, Number(limit)));
    const skip = (p - 1) * l;

    const [items, total] = await Promise.all([
      Booking.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l).lean(),
      Booking.countDocuments(filter),
    ]);

    return res.json({ ok: true, bookings: items, total });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

/** ADMIN: Change status (scoped) – mails on transitions */
router.patch('/:id/status', adminAuth, async (req, res) => {
  try {
    const providerId = requireProvider(req, res);
    if (!providerId) return;

    const { status } = req.body || {};
    const forceMail = String(req.query.force || '') === '1';

    if (!ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', error: 'Invalid status' });
    }

    // Vorherigen Datensatz im Scope laden
    const prev = await Booking.findOne({ _id: req.params.id, owner: providerId });
    if (!prev) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

    // Update im Scope
    const updated = await Booking.findOneAndUpdate(
      { _id: req.params.id, owner: providerId },
      { status },
      { new: true }
    );
    if (!updated) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

    const fullName = updated.fullName || `${updated.firstName} ${updated.lastName}`.trim();
    const program  = updated.program  || updated.level;
    const dateDE   = fmtDE(updated.date);

    let mailSentProcessing = false;
    let mailSentCancelled  = false;

    // CANCELLED → E-Mail
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
      } catch (mailErr) {
        console.warn('Cancellation mail failed:', mailErr?.message || mailErr);
      }
    }

    // PROCESSING → E-Mail (idempotent, ?force=1 erlaubt erneut)
    if (status === 'processing' && (prev.status !== 'processing' || forceMail)) {
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
      } catch (mailErr) {
        console.error('[BOOKINGS] processing-mail FAILED:', mailErr?.message || mailErr);
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

/** ADMIN: Note (scoped) */
router.patch('/:id/note', adminAuth, async (req, res) => {
  try {
    const providerId = requireProvider(req, res);
    if (!providerId) return;

    const { adminNote = '' } = req.body || {};
    const updated = await Booking.findOneAndUpdate(
      { _id: req.params.id, owner: providerId },
      { adminNote },
      { new: true }
    );
    if (!updated) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });
    return res.json({ ok: true, booking: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

/** ADMIN: Soft delete (scoped) */
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const providerId = requireProvider(req, res);
    if (!providerId) return;

    const updated = await Booking.findOneAndUpdate(
      { _id: req.params.id, owner: providerId },
      { status: 'deleted' },
      { new: true }
    );
    if (!updated) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });
    return res.json({ ok: true, booking: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

/** ADMIN: Confirm + send PDF (scoped, idempotent, ?resend=1) */
router.post('/:id/confirm', adminAuth, async (req, res) => {
  try {
    const providerId = requireProvider(req, res);
    if (!providerId) return;

    const booking = await Booking.findOne({ _id: req.params.id, owner: providerId });
    if (!booking) return res.status(404).json({ ok:false, error:'Not found' });

    const fullName = booking.fullName || `${booking.firstName} ${booking.lastName}`.trim();
    const program  = booking.program  || booking.level;
    const dateDE   = fmtDE(booking.date);
    const forceResend = String(req.query.resend || '') === '1';

    const alreadyConfirmed = booking.status === 'confirmed';

    if (!booking.confirmationCode) {
      booking.confirmationCode = 'KS-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    }

    if (!alreadyConfirmed) {
      booking.status = 'confirmed';
      booking.confirmedAt = new Date();
      await booking.save();
    }

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
