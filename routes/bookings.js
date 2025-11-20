

// routes/bookings.js
'use strict';

const express  = require('express');
const crypto   = require('crypto');
const mongoose = require('mongoose');

const Booking   = require('../models/Booking');
const Offer     = require('../models/Offer');
const Customer  = require('../models/Customer');
const adminAuth = require('../middleware/adminAuth');

const { createHolidayInvoiceForBooking } = require('../utils/holidayInvoices');





//const { buildParticipationPdf } = require('../utils/pdf');
//const { normalizeInvoiceNo } = require('../utils/pdfData');




const {
  sendBookingAckEmail,
  sendBookingProcessingEmail,
  sendBookingCancelledEmail,
  sendBookingConfirmedEmail,
  sendBookingCancelledConfirmedEmail,
 sendParticipationEmail,
 sendStornoEmail,
} = require('../utils/mailer');

const router = express.Router();

const ALLOWED_STATUS = ['pending','processing','confirmed','cancelled','deleted'];




// ProgramFilter-Keys aus dem Frontend
const PROGRAM_FILTERS = [
  'weekly_foerdertraining',
  'weekly_kindergarten',
  'weekly_goalkeeper',
  'weekly_development_athletik',
  'ind_1to1',
  'ind_1to1_athletik',
  'ind_1to1_goalkeeper',
  'club_rentacoach',
  'club_trainingcamps',
  'club_coacheducation',
];

// Mapping: ProgramFilter -> Offer-Query
function buildOfferFilterForProgram(programKey) {
  switch (programKey) {
    // ==== Weekly Courses ====
    case 'weekly_foerdertraining':
      return { category: 'Weekly', type: 'Foerdertraining' };

    case 'weekly_kindergarten':
      return { category: 'Weekly', type: 'Kindergarten' };

    case 'weekly_goalkeeper':
      // Torwarttraining als Weekly-Kurs
      return { category: 'Weekly', sub_type: 'Torwarttraining' };

    case 'weekly_development_athletik':
      // dein DB-Wert: Foerdertraining_Athletik
      return { category: 'Weekly', sub_type: 'Foerdertraining_Athletik' };

    // ==== Individual Courses ====
    case 'ind_1to1':
      // "normales" PersonalTraining ohne spezielles sub_type
      return { category: 'Individual', type: 'PersonalTraining', sub_type: '' };

    case 'ind_1to1_athletik':
      return {
        category: 'Individual',
        sub_type: 'Einzeltraining_Athletik',
      };

    case 'ind_1to1_goalkeeper':
      return {
        category: 'Individual',
        sub_type: 'Einzeltraining_Torwart',
      };

    // ==== Club Programs ====
    case 'club_rentacoach':
      // Kategorie RentACoach mit Generic-Subtyp
      return {
        category: 'RentACoach',
        sub_type: 'RentACoach_Generic',
      };

    case 'club_trainingcamps':
      // generische Club-Programme (Training Camps)
      return {
        category: 'ClubPrograms',
        sub_type: 'ClubProgram_Generic',
      };

    case 'club_coacheducation':
      return {
        category: 'ClubPrograms',
        sub_type: 'CoachEducation',
      };

    default:
      return null;
  }
}






function normalizeStatus(s) { return s === 'canceled' ? 'cancelled' : s; }
function escapeRegex(s) { return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }



const NON_TRIAL_PROGRAMS = ['RentACoach', 'ClubProgram', 'CoachEducation'];

function isNonTrialProgram(offer) {
  if (!offer) return false;
  const cat  = String(offer.category || '').trim();
  const type = String(offer.type || '').trim();
  const sub  = String(offer.sub_type || '').trim();
  return NON_TRIAL_PROGRAMS.includes(cat)
      || NON_TRIAL_PROGRAMS.includes(type)
      || NON_TRIAL_PROGRAMS.includes(sub);
}





// robust Holiday-Erkennung (Camp + Powertraining)
const HOLIDAY_KEYWORDS = ['camp', 'feriencamp', 'holiday', 'powertraining', 'power training'];

function isHolidayProgram(offer) {
  if (!offer) return false;

  const cat  = String(offer.category || '').toLowerCase().replace(/\s+/g, '');
  const type = String(offer.type || '').toLowerCase();
  const sub  = String(offer.sub_type || '').toLowerCase();

  // 1) saubere Kategorie
  if (cat === 'holiday' || cat === 'holidayprograms') return true;

  // 2) Keywords in type/sub
  const text = `${type} ${sub}`;
  return HOLIDAY_KEYWORDS.some((kw) => text.includes(kw));
}






// Confirm
router.post('/:id/confirm', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res
        .status(500)
        .json({ ok: false, error: 'DEFAULT_OWNER_ID missing/invalid' });
    }

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid booking id' });
    }

    const booking = await Booking.findOne({ _id: id, owner: ownerId });
    if (!booking) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }

    const forceResend      = String(req.query.resend || '') === '1';
    const withInvoice      = String(req.query.withInvoice || '') === '1'; // 🔹 NEU
    const alreadyConfirmed = booking.status === 'confirmed';

    // Bestätigungscode + Status setzen
    if (!booking.confirmationCode) {
      booking.confirmationCode =
        'KS-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    }
    if (!alreadyConfirmed) {
      booking.status      = 'confirmed';
      booking.confirmedAt = new Date();
      await booking.save();
    }

    // wenn schon bestätigt und kein ?resend=1 -> nichts senden
    if (alreadyConfirmed && !forceResend) {
      return res.json({
        ok: true,
        booking,
        info: 'already confirmed (no email sent)',
      });
    }

    // Offer holen
    const offer = booking.offerId
      ? await Offer.findOne({ _id: booking.offerId, owner: ownerId }).lean()
      : null;

    const isNonTrial = isNonTrialProgram(offer);
    const isHoliday  = isHolidayProgram(offer);

    try {
      // 1) Normale Terminbestätigung → IMMER
      await sendBookingConfirmedEmail({
        to: booking.email,
        booking,
        offer,
        isNonTrial,
      });

      // 2) Teilnahme/Rechnung NUR, wenn explizit angefordert (withInvoice=1)
      if (withInvoice) {
        if (isHoliday) {
          // Holiday: spezielle Holiday-Rechnung + Teilnahme-Mail (mit PDF)
          await createHolidayInvoiceForBooking({
            ownerId,
            offer,
            booking,
          });
        } else {
          // Andere Programme: Standard-Teilnahme-Mail (mit PDF-Rechnung)
          const customer = await Customer.findOne({
            owner: ownerId,
            'bookings.bookingId': booking._id,
          });

          if (customer) {
            await sendParticipationEmail({
              to: booking.email,
              customer,
              booking,
              offer,
              // pdfBuffer weglassen -> buildParticipationPdf kümmert sich darum
            });
          } else {
            console.warn(
              '[bookings:confirm] no customer found for participation email',
              String(booking._id)
            );
          }
        }
      }

      return res.json({ ok: true, booking, mailSent: true, withInvoice });
    } catch (mailErr) {
      console.error(
        '[bookings:confirm] mail/pdf failed:',
        mailErr?.message || mailErr
      );
      return res.status(200).json({
        ok: true,
        booking,
        mailSent: false,
        withInvoice,
        error: 'mail_failed',
      });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});










function resolveOwner(req) {
  const fromHeader = req.get('x-provider-id');
  const fallback   = process.env.DEFAULT_OWNER_ID;
  const id = (fromHeader || fallback || '').trim();
  if (!id || !mongoose.isValidObjectId(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

function prorateForStart(dateISO, monthlyPrice) {
  const d = new Date(dateISO + 'T00:00:00');
  if (isNaN(d.getTime()) || typeof monthlyPrice !== 'number' || !isFinite(monthlyPrice)) {
    return { daysInMonth: null, daysRemaining: null, factor: null, firstMonthPrice: null, monthlyPrice: monthlyPrice ?? null };
  }
  const y = d.getFullYear();
  const m = d.getMonth();
  const daysInMonth   = new Date(y, m + 1, 0).getDate();
  const startDay      = d.getDate();
  const daysRemaining = daysInMonth - startDay + 1;
  const factor        = Math.max(0, Math.min(1, daysRemaining / daysInMonth));
  const firstMonthPrice = Math.round(monthlyPrice * factor * 100) / 100;
  return { daysInMonth, daysRemaining, factor, firstMonthPrice, monthlyPrice };
}

function validate(payload) {
  const errors = {};
  if (!payload.firstName?.trim()) errors.firstName = 'Required';
  if (!payload.lastName?.trim())  errors.lastName  = 'Required';
  if (!/^\S+@\S+\.\S+$/.test(payload.email || '')) errors.email = 'Invalid email';
  const age = Number(payload.age);
  if (!age || age < 5 || age > 19) errors.age = 'Age 5–19';
  if (!payload.date) errors.date = 'Pick a date';
  if (!['U8','U10','U12','U14','U16','U18'].includes(payload.level)) errors.level = 'Invalid level';
  return errors;
}

function buildFilter(query, ownerId) {
  const { q, status, date, includeHoliday } = query || {};

  const filter = { owner: ownerId };

  // Wenn includeHoliday NICHT gesetzt ist:
  // → Camp/Powertraining aus Online-Formular in "Bookings" ausblenden
  if (String(includeHoliday) !== '1') {
    const nonHolidayOnlineCondition = {
      $or: [
        // alles, was NICHT aus dem Online-Formular kommt, bleibt drin
        { source: { $ne: 'online_request' } },
        // Online-Requests nur dann zulassen, wenn sie NICHT Camp/Powertraining sind
        {
          source: 'online_request',
          message: {
            $not: /Programm:\s*(Camp|Powertraining)/i,
          },
        },
      ],
    };

    filter.$and = [nonHolidayOnlineCondition];
  }

  if (status && status !== 'all' && ALLOWED_STATUS.includes(String(status))) {
    filter.status = String(status);
  }

  if (date) filter.date = String(date);

  if (q && String(q).trim()) {
    const needle = String(q).trim();
    filter.$or = [
      { firstName:        { $regex: needle, $options: 'i' } },
      { lastName:         { $regex: needle, $options: 'i' } },
      { email:            { $regex: needle, $options: 'i' } },
      { level:            { $regex: needle, $options: 'i' } },
      { message:          { $regex: needle, $options: 'i' } },
      { confirmationCode: { $regex: needle, $options: 'i' } },
    ];
  }

  return filter;
}


/* ---------- Customer-Helper ---------- */
async function upsertCustomerForBooking({ ownerId, offer, bookingDoc, payload }) {
  const emailLower = String(payload.email || '').trim().toLowerCase();

  let customer = await Customer.findOne({
    owner: ownerId,
    $or: [
      { emailLower },
      { email: emailLower },
      { 'parent.email': emailLower },
    ],
  });

  const bookingDate = new Date(String(payload.date) + 'T00:00:00');
  const venue = typeof offer?.location === 'string'
    ? offer.location
    : (offer?.location?.name || offer?.location?.title || '');

  const bookingRef = {
    bookingId:   bookingDoc._id,
    offerId:     offer._id,
    offerTitle:  String(offer.title || ''),
    offerType:   String(offer.type || ''),
    venue,
    date:        isNaN(bookingDate.getTime()) ? null : bookingDate,
    status:      'active',
    priceAtBooking: typeof offer.price === 'number' ? offer.price : null,
  };

  if (!customer) {
    await Customer.syncCounterWithExisting(ownerId);
    const nextUserId = await Customer.nextUserIdForOwner(ownerId);

    customer = await Customer.create({
      owner: ownerId,
      userId: nextUserId,
      email: emailLower,
      emailLower,
      newsletter: false,
      parent: { email: emailLower },
      child:  { firstName: String(payload.firstName||''), lastName: String(payload.lastName||'') },
      notes:  (payload.message || '').toString(),
      bookings: [bookingRef],
      marketingStatus: null,
    });
    return customer;
  }

  if (customer.userId == null) {
    await Customer.assignUserIdIfMissing(customer);
  }

  const already = customer.bookings?.some(b =>
    String(b.offerId) === String(offer._id) &&
    String(b.bookingId) === String(bookingDoc._id)
  );
  if (!already) customer.bookings.push(bookingRef);

  if (!customer.emailLower) customer.emailLower = emailLower;
  if (!customer.email)      customer.email = emailLower;
  if (!customer.parent)     customer.parent = {};
  if (!customer.parent.email) customer.parent.email = emailLower;

  await customer.save();
  return customer;
}




// z.B. in routes/bookings.js oder in einer helper-Datei



/* ------------------------------ Routes ------------------------------ */

// Create booking
router.post('/', async (req, res) => {
  try {
    const errors = validate(req.body);
    if (Object.keys(errors).length) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', errors });
    }
    if (!req.body.offerId) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', error: 'offerId is required' });
    }

    const offer = await Offer.findById(String(req.body.offerId))
      .select('_id owner title type category sub_type location onlineActive price')
      .lean();
    if (!offer) return res.status(400).json({ ok: false, error: 'Offer not found' });
    if (offer.onlineActive === false) {
      return res.status(400).json({ ok: false, error: 'Offer not bookable' });
    }

    const pidHeader = (req.get('x-provider-id') || '').trim();
    if (pidHeader && String(offer.owner) !== pidHeader) {
      return res.status(403).json({ ok: false, error: 'Offer does not belong to this provider' });
    }

    const isNonTrial = isNonTrialProgram(offer);
    const isHoliday  = isHolidayProgram(offer);   // ✅ NEU

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

    const isWeekly =
      offer?.category === 'Weekly' ||
      offer?.type === 'Foerdertraining' ||
      offer?.type === 'Kindergarten';
    const monthlyPrice = (isWeekly && typeof offer.price === 'number') ? offer.price : null;
    const pro = (isWeekly && monthlyPrice != null)
      ? prorateForStart(req.body.date, monthlyPrice)
      : {
          daysInMonth: null,
          daysRemaining: null,
          factor: null,
          firstMonthPrice: null,
          monthlyPrice: null,
        };

    const created = await Booking.create({
      owner:   offer.owner,
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

    // Kunde upserten + fortlaufende userId vergeben + Buchung referenzieren
    try {
      await upsertCustomerForBooking({
        ownerId: offer.owner,
        offer,
        bookingDoc: created,
        payload: req.body,
      });
    } catch (custErr) {
      console.error('[bookings] customer upsert failed:', custErr?.message || custErr);
    }

    // 1) Eingangsbestätigung (nur wenn NICHT Holiday)
    if (!isHoliday) {
      try {
        await sendBookingAckEmail({
          to: created.email,
          offer,
          booking: created,
          pro,
          isNonTrial,
        });
      } catch (mailErr) {
        console.warn('[bookings] ack email failed:', mailErr?.message || mailErr);
      }
    }

    // 2) Holiday-Programme → direkt bestätigen + Rechnung
    if (isHoliday) {
      try {
        // wie in /:id/confirm
        if (!created.confirmationCode) {
          created.confirmationCode =
            'KS-' + crypto.randomBytes(3).toString('hex').toUpperCase();
        }

        created.status      = 'confirmed';
        created.confirmedAt = new Date();
        await created.save();

        // Terminbestätigung
        await sendBookingConfirmedEmail({
          to: created.email,
          booking: created,
          offer,
          isNonTrial,
        });

        // Teilnahme + Rechnung (PDF) → nutzt holidayInvoices.js
        await createHolidayInvoiceForBooking({
          ownerId: offer.owner,
          offer,
          booking: created,
        });
      } catch (autoConfirmErr) {
        console.error(
          '[bookings] auto-confirm holiday failed:',
          autoConfirmErr?.message || autoConfirmErr
        );
        // wichtig: trotzdem keinen 500er nach außen
      }
    }

    return res.status(201).json({ ok: true, booking: created, prorate: pro });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});


// List
router.get('/', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res.status(500).json({ ok:false, error:'DEFAULT_OWNER_ID missing/invalid' });
    }

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip  = (page - 1) * limit;

    // Program-Filter aus Query
    const programKey = String(req.query.program || 'all');

    // Basis-Filter (Status, Suche, includeHoliday-Logik, usw.)
    const filter = buildFilter(req.query, ownerId);

    // ==== Program-Filter über Offer -> offerId ====
    if (programKey && programKey !== 'all') {
      const offerFilter = buildOfferFilterForProgram(programKey);

      if (offerFilter) {
        // passende Offers für diesen Kurs finden (nur für diesen Owner)
        const offerIds = await Offer.find({
          owner: ownerId,
          ...offerFilter,
        })
          .distinct('_id')
          .exec();

        if (!offerIds.length) {
          // keine passenden Offers -> keine Bookings
          const emptyCounts = {
            pending: 0,
            processing: 0,
            confirmed: 0,
            cancelled: 0,
            deleted: 0,
          };
          return res.json({
            ok: true,
            items: [],
            bookings: [],
            total: 0,
            page,
            limit,
            pages: 1,
            counts: emptyCounts,
          });
        }

        // Filter um offerId-Einschränkung erweitern
        filter.offerId = { $in: offerIds };
      }
    }

    // gleiche Filter-Teile auch für die Aggregation verwenden,
    // damit Counts und Liste übereinstimmen
    const matchForCounts = { owner: ownerId };

    if (filter.status) matchForCounts.status = filter.status;
    if (filter.date)   matchForCounts.date   = filter.date;
    if (filter.$and)   matchForCounts.$and   = filter.$and;
    if (filter.$or)    matchForCounts.$or    = filter.$or;
    if (filter.offerId) matchForCounts.offerId = filter.offerId;

    const [items, total, grouped] = await Promise.all([
      Booking.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Booking.countDocuments(filter),
      Booking.aggregate([
        { $match: matchForCounts },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
    ]);

    const counts = { pending:0, processing:0, confirmed:0, cancelled:0, deleted:0 };
    for (const g of grouped) {
      const key = (g._id || 'pending');
      if (counts[key] !== undefined) counts[key] = g.n;
    }

    return res.json({
      ok: true,
      items,
      bookings: items,
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      counts,
    });
  } catch (err) {
    console.error('[admin/bookings] list failed:', err);
    return res.status(500).json({ ok:false, error:'List failed' });
  }
});

// Status ändern
router.patch('/:id/status', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) return res.status(500).json({ ok:false, error:'DEFAULT_OWNER_ID missing/invalid' });

    const rawStatus = String(req.body?.status || '').trim();
    const status = normalizeStatus(rawStatus);
    const forceMail = String(req.query.force || '') === '1';

    if (!ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', error: 'Invalid status' });
    }

    const prev = await Booking.findOne({ _id: req.params.id, owner: ownerId });
    if (!prev) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

    const updated = await Booking.findOneAndUpdate(
      { _id: req.params.id, owner: ownerId },
      { status },
      { new: true }
    );
    if (!updated) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

  






    let mailSentProcessing = false;
    let mailSentCancelled  = false;

    if (status === 'processing' && (prev.status !== 'processing' || forceMail)) {
      try {
        // Offer laden, um Programmnamen zu kennen
        const offer = updated.offerId
          ? await Offer.findOne({ _id: updated.offerId, owner: ownerId }).lean()
          : null;

        const isNonTrial = isNonTrialProgram(offer);

        await sendBookingProcessingEmail({
          to: updated.email,
          booking: updated,
          offer,
          isNonTrial,
        });

        mailSentProcessing = true;
      } catch (e) {
        console.error('[BOOKINGS] processing-mail FAILED:', e?.message || e);
      }
    }



    if (status === 'cancelled' && (prev.status !== 'cancelled' || forceMail)) {
      try {
        if (updated.email) {
          await sendBookingCancelledEmail({ to: updated.email, booking: updated });
          mailSentCancelled = true;
        } else {
          console.error('[BOOKINGS] cancelled: missing recipient email');
        }
      } catch (e) { console.error('[BOOKINGS] cancellation-mail FAILED:', e?.message || e); }
    }

    return res.json({ ok: true, booking: updated, mailSentProcessing, mailSentCancelled });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});



// Soft delete – Status auf 'deleted' setzen und previousStatus merken
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res
        .status(500)
        .json({ ok: false, error: 'DEFAULT_OWNER_ID missing/invalid' });
    }

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid booking id' });
    }

    const booking = await Booking.findOne({ _id: id, owner: ownerId });
    if (!booking) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND' });
    }

    // Nur wenn noch nicht gelöscht: ursprünglichen Status merken
    if (booking.status !== 'deleted') {
      booking.previousStatus = booking.status || 'pending';
    }

    booking.status = 'deleted';
    await booking.save();

    return res.json({ ok: true, booking });
  } catch (err) {
    console.error('[bookings:soft-delete] error:', err);
    return res
      .status(500)
      .json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

// Restore soft-deleted booking
router.post('/:id/restore', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res
        .status(500)
        .json({ ok: false, error: 'DEFAULT_OWNER_ID missing/invalid' });
    }

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid booking id' });
    }

    const booking = await Booking.findOne({
      _id: id,
      owner: ownerId,
      status: 'deleted',
    });

    if (!booking) {
      return res.status(404).json({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Deleted booking not found',
      });
    }

    // 1) Basis: vorheriger Status, falls vorhanden
    let nextStatus = booking.previousStatus;

    // 2) Falls kein previousStatus gesetzt ist (alte Daten vorher),
    //    sinnvollen Fallback wählen:
    if (!nextStatus || nextStatus === 'deleted') {
      if (booking.source === 'online_request') {
        // Online-Buchungen: niemals 'pending' – dann Standard = 'confirmed'
        nextStatus = 'confirmed';
      } else {
        // Normale Bookings: Default 'pending'
        nextStatus = 'pending';
      }
    }

    booking.status = nextStatus;
    booking.previousStatus = null; // optional aufräumen
    await booking.save();

    return res.json({ ok: true, booking });
  } catch (err) {
    console.error('[bookings:restore] error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});





// Hard delete – endgültig aus der DB entfernen
router.delete('/:id/hard', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res
        .status(500)
        .json({ ok: false, error: 'DEFAULT_OWNER_ID missing/invalid' });
    }

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid booking id' });
    }

    const result = await Booking.deleteOne({ _id: id, owner: ownerId });

    if (!result.deletedCount) {
      return res
        .status(404)
        .json({ ok: false, code: 'NOT_FOUND', error: 'Booking not found' });
    }

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[bookings:hard-delete] error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});









// routes/bookings.js — bestätigten Termin absagen + Storno-Rechnung
router.post('/:id/cancel-confirmed', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res
        .status(500)
        .json({ ok: false, error: 'DEFAULT_OWNER_ID missing/invalid' });
    }

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid booking id' });
    }

    const booking = await Booking.findOne({ _id: id, owner: ownerId });
    if (!booking) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }

    // Nur erlaubt, wenn aktuell 'confirmed'
    if (booking.status !== 'confirmed') {
      return res.status(409).json({
        ok: false,
        code: 'NOT_CONFIRMED',
        error: 'Only confirmed bookings can be cancelled via this route',
      });
    }

    // Status -> cancelled
    booking.status = 'cancelled';
    booking.cancelledAt = new Date();
    await booking.save();

    // Offer + Customer laden
    const offer = booking.offerId
      ? await Offer.findOne({ _id: booking.offerId, owner: ownerId }).lean()
      : null;

    const customer = await Customer.findOne({
      owner: ownerId,
      'bookings.bookingId': booking._id,
    });

    const isNonTrial = isNonTrialProgram(offer);

    let mailSent = false;
    let stornoSent = false;

    // 1) Mail: bestätigter Termin abgesagt
    try {
      await sendBookingCancelledConfirmedEmail({
        to: booking.email,
        booking,
        offer,
        isNonTrial,
      });
      mailSent = true;
    } catch (e) {
      console.error(
        '[bookings:cancel-confirmed] mail failed:',
        e?.message || e
      );
    }

    // 2) Storno-Rechnung (nur wenn Rechnung existiert)
    if (customer && booking.invoiceNumber) {
      try {
        const amount =
          typeof booking.priceAtBooking === 'number'
            ? booking.priceAtBooking
            : typeof offer?.price === 'number'
            ? offer.price
            : 0;

        await sendStornoEmail({
          to: booking.email,
          customer,
          booking,
          offer,
          amount,
          currency: booking.currency || 'EUR',
        });
        stornoSent = true;
      } catch (e) {
        console.error(
          '[bookings:cancel-confirmed] storno mail failed:',
          e?.message || e
        );
      }
    } else {
      console.warn(
        '[bookings:cancel-confirmed] skip storno: no customer or no invoiceNumber for booking',
        String(booking._id)
      );
    }

    return res.json({
      ok: true,
      booking,
      mailSent,
      stornoSent,
    });
  } catch (err) {
    console.error('[bookings:cancel-confirmed] error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});






module.exports = router;








