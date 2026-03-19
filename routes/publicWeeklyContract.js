//routes\publicWeeklyContract.js
"use strict";

const express = require("express");
const crypto = require("crypto");

const Booking = require("../models/Booking");
const Offer = require("../models/Offer");

const {
  createSubscriptionCheckout,
} = require("./payments/stripe/lib/createSubscriptionCheckout");
const { safeStr } = require("./payments/stripe/lib/strings");

const router = express.Router();

const fs = require("fs");
const path = require("path");
const { buildWeeklyContractPdf } = require("../utils/pdf");

const { sendWeeklyContractSignedEmail } = require("../utils/mailer");

function safeText(v) {
  return String(v ?? "").trim();
}

function safeLower(v) {
  return safeText(v).toLowerCase();
}

function asObj(v) {
  return v && typeof v === "object" ? v : {};
}

function ensureMeta(booking) {
  if (!booking.meta || typeof booking.meta !== "object") booking.meta = {};
  return booking.meta;
}

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

function isExpired(iso) {
  const s = safeText(iso);
  if (!s) return false;
  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() > t;
}

async function findByToken(token) {
  return Booking.findOne({ "meta.contractToken": token });
}

async function loadOfferForBooking(booking) {
  if (!booking?.offerId) return null;
  try {
    return await Offer.findById(String(booking.offerId))
      .select("_id title type category sub_type location days timeFrom timeTo")
      .lean();
  } catch {
    return null;
  }
}

async function sendContractSignedMailOnce({ booking, offer }) {
  const meta = ensureMeta(booking);
  if (safeStr(meta.contractSignedEmailSentAt)) return;

  const to =
    safeText(booking?.invoiceTo?.parent?.email) || safeText(booking?.email);

  if (!to) return;

  const pdfBuffer = await buildWeeklyContractPdf({ booking, offer });

  await sendWeeklyContractSignedEmail({
    to,
    booking,
    offer,
    pdfBuffer,
  });

  meta.contractSignedEmailSentAt = new Date().toISOString();
  booking.markModified("meta");
  await booking.save();
}

function dayLabel(day) {
  const d = safeLower(day);
  const map = {
    mon: "Montag",
    tue: "Dienstag",
    wed: "Mittwoch",
    thu: "Donnerstag",
    fri: "Freitag",
    sat: "Samstag",
    sun: "Sonntag",
  };
  return map[d] || safeText(day);
}

function timeLabel(offer) {
  const from = safeText(offer?.timeFrom);
  const to = safeText(offer?.timeTo);
  if (!from && !to) return "";
  return [from, to].filter(Boolean).join(" – ");
}

function contractFromBody(body) {
  const b = asObj(body);
  const c = asObj(b.contract);

  const parent = asObj(c.parent);
  const address = asObj(c.address);
  const child = asObj(c.child);
  const consents = asObj(c.consents);

  return {
    parent: {
      salutation: safeText(parent.salutation),
      firstName: safeText(parent.firstName),
      lastName: safeText(parent.lastName),
      email: safeLower(parent.email),
      phone: safeText(parent.phone),
      mobile: safeText(parent.mobile),
    },
    address: {
      street: safeText(address.street),
      houseNo: safeText(address.houseNo),
      zip: safeText(address.zip),
      city: safeText(address.city),
    },
    child: {
      firstName: safeText(child.firstName),
      lastName: safeText(child.lastName),
      birthDate: safeText(child.birthDate),
    },
    consents: {
      acceptAgb: consents.acceptAgb === true,
      acceptPrivacy: consents.acceptPrivacy === true,
      consentPhotoVideo: consents.consentPhotoVideo === true,
    },
    signatureName: safeText(c.signatureName),
  };
}

function validateContract(contract) {
  const errors = {};

  if (!contract?.parent?.firstName) errors.parentFirstName = "required";
  if (!contract?.parent?.lastName) errors.parentLastName = "required";

  if (!contract?.parent?.email || !contract.parent.email.includes("@")) {
    errors.parentEmail = "required";
  }

  if (!contract?.address?.street) errors.street = "required";
  if (!contract?.address?.houseNo) errors.houseNo = "required";
  if (!contract?.address?.zip) errors.zip = "required";
  if (!contract?.address?.city) errors.city = "required";

  if (!contract?.child?.firstName) errors.childFirstName = "required";
  if (!contract?.child?.lastName) errors.childLastName = "required";
  if (!contract?.child?.birthDate) errors.childBirthDate = "required";

  if (contract?.consents?.acceptAgb !== true) errors.acceptAgb = "required";
  if (contract?.consents?.acceptPrivacy !== true)
    errors.acceptPrivacy = "required";

  if (!contract?.signatureName) errors.signatureName = "required";

  return errors;
}

/* ================= existing endpoints ================= */

router.post("/weekly/contract-token", async (req, res) => {
  //routes\publicWeeklyContract.js

  try {
    const bookingId = safeText(req.body?.bookingId);
    if (!bookingId) {
      return res.status(400).json({ ok: false, code: "MISSING_BOOKING_ID" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ ok: false, code: "BOOKING_NOT_FOUND" });
    }

    const offer = await loadOfferForBooking(booking);
    if (!offer) {
      return res.status(400).json({ ok: false, code: "OFFER_NOT_FOUND" });
    }

    // const meta = ensureMeta(booking);

    // meta.contractToken = randomToken();
    // meta.contractTokenExpiresAt = new Date(
    //   Date.now() + 7 * 24 * 60 * 60 * 1000,
    // ).toISOString();

    const meta = ensureMeta(booking);

    meta.subscriptionEligible = true;

    const approvedAt =
      safeText(meta.subscriptionEligibleAt) ||
      safeText(meta.weeklyApprovedAt) ||
      new Date().toISOString();

    meta.subscriptionEligibleAt = approvedAt;
    meta.weeklyApprovedAt = approvedAt;

    meta.contractToken = randomToken();
    meta.contractTokenExpiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    booking.markModified("meta");
    await booking.save();

    const pdfBuffer = await buildWeeklyContractPdf({ booking, offer });

    const dir = path.resolve(process.cwd(), "uploads", "contracts");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const fileName = `contract-${String(booking._id)}.pdf`;
    const abs = path.resolve(dir, fileName);
    fs.writeFileSync(abs, pdfBuffer);

    meta.contractPdfPath = `/uploads/contracts/${fileName}`;
    const to =
      safeText(booking?.invoiceTo?.parent?.email) || safeText(booking?.email);

    await sendWeeklyContractSignedEmail({
      to,
      booking,
      offer,
      pdfBuffer,
    });
    meta.contractPdfCreatedAt = new Date().toISOString();

    booking.markModified("meta");
    await booking.save();

    return res.status(200).json({ ok: true, token: meta.contractToken });
  } catch (e) {
    console.error("[public] weekly contract-token error:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER" });
  }
});

router.post("/weekly/contract-sign", async (req, res) => {
  try {
    const token = safeText(req.body?.token);
    if (!token) {
      return res.status(400).json({ ok: false, code: "MISSING_TOKEN" });
    }

    const booking = await findByToken(token);
    if (!booking) {
      return res.status(404).json({ ok: false, code: "TOKEN_NOT_FOUND" });
    }

    const meta = ensureMeta(booking);

    if (isExpired(meta.contractTokenExpiresAt)) {
      return res.status(410).json({ ok: false, code: "TOKEN_EXPIRED" });
    }

    meta.contractSignedAt = new Date().toISOString();

    booking.markModified("meta");
    await booking.save();

    return res.status(200).json({
      ok: true,
      contractSignedAt: meta.contractSignedAt,
      bookingId: String(booking._id),
    });
  } catch (e) {
    console.error("[public] weekly contract-sign error:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER" });
  }
});

router.post("/weekly/contract-sign-and-checkout", async (req, res) => {
  try {
    const token = safeText(req.body?.token);
    const returnTo = safeText(req.body?.returnTo);
    if (!token) {
      return res.status(400).json({ ok: false, code: "MISSING_TOKEN" });
    }

    const booking = await findByToken(token);
    if (!booking) {
      return res.status(404).json({ ok: false, code: "TOKEN_NOT_FOUND" });
    }

    const meta = ensureMeta(booking);

    if (isExpired(meta.contractTokenExpiresAt)) {
      return res.status(410).json({ ok: false, code: "TOKEN_EXPIRED" });
    }

    if (!safeStr(meta.contractSignedAt)) {
      meta.contractSignedAt = new Date().toISOString();
      booking.markModified("meta");
      await booking.save();
    }

    const out = await createSubscriptionCheckout({
      booking,
      returnTo: returnTo || undefined,
    });

    if (!out?.ok) {
      const code = out?.code || "SERVER";
      const status =
        code === "PAYMENT_NOT_APPROVED" ||
        code === "SUBSCRIPTION_NOT_ALLOWED" ||
        code === "NOT_A_SUBSCRIPTION_OFFER"
          ? 403
          : code === "SUBSCRIPTION_ALREADY_CREATED"
            ? 409
            : 400;
      return res.status(status).json({ ok: false, code });
    }

    return res.status(200).json({
      ok: true,
      contractSignedAt: safeText(meta.contractSignedAt),
      url: out.url,
      sessionId: out.sessionId,
    });
  } catch (e) {
    console.error(
      "[public] weekly contract-sign-and-checkout error:",
      e?.message || e,
    );
    return res.status(500).json({ ok: false, code: "SERVER" });
  }
});

/* ================= new endpoints for contract form ================= */

router.get("/weekly/contract-init", async (req, res) => {
  try {
    const token = safeText(req.query.token);
    if (!token)
      return res.status(400).json({ ok: false, code: "TOKEN_NOT_FOUND" });

    const booking = await findByToken(token);
    if (!booking)
      return res.status(404).json({ ok: false, code: "TOKEN_NOT_FOUND" });

    const meta = ensureMeta(booking);
    if (isExpired(meta.contractTokenExpiresAt)) {
      return res.status(410).json({ ok: false, code: "TOKEN_EXPIRED" });
    }

    if (meta.subscriptionEligible !== true) {
      return res
        .status(403)
        .json({ ok: false, code: "SUBSCRIPTION_NOT_ALLOWED" });
    }

    const offer = await loadOfferForBooking(booking);
    if (!offer)
      return res.status(400).json({ ok: false, code: "OFFER_NOT_FOUND" });

    const invParent = asObj(booking.invoiceTo?.parent);
    const invAddr = asObj(booking.invoiceTo?.address);

    const firstDay =
      Array.isArray(offer.days) && offer.days.length ? offer.days[0] : "";

    return res.status(200).json({
      ok: true,
      bookingId: String(booking._id),
      offerTitle:
        safeText(offer.title) ||
        safeText(offer.sub_type) ||
        safeText(offer.type),
      location: safeText(offer.location),
      startDate: safeText(booking.date),
      dayLabel: dayLabel(firstDay),
      timeLabel: timeLabel(offer),
      parent: {
        salutation: safeText(invParent.salutation),
        firstName: safeText(invParent.firstName),
        lastName: safeText(invParent.lastName),
        email: safeLower(invParent.email || booking.email),
        phone: safeText(invParent.phone),
        mobile: "",
      },
      address: {
        street: safeText(invAddr.street),
        houseNo: safeText(invAddr.houseNo),
        zip: safeText(invAddr.zip),
        city: safeText(invAddr.city),
      },
      child: {
        firstName: safeText(booking.firstName),
        lastName: safeText(booking.lastName),
        birthDate: "",
      },
    });
  } catch (e) {
    console.error("[public] weekly contract-init error:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER" });
  }
});

router.post("/weekly/contract-submit-and-checkout", async (req, res) => {
  try {
    const token = safeText(req.body?.token);
    const returnTo = safeText(req.body?.returnTo);

    if (!token)
      return res.status(400).json({ ok: false, code: "TOKEN_NOT_FOUND" });

    const booking = await findByToken(token);
    if (!booking)
      return res.status(404).json({ ok: false, code: "TOKEN_NOT_FOUND" });

    const meta = ensureMeta(booking);
    if (isExpired(meta.contractTokenExpiresAt)) {
      return res.status(410).json({ ok: false, code: "TOKEN_EXPIRED" });
    }

    if (meta.subscriptionEligible !== true) {
      return res
        .status(403)
        .json({ ok: false, code: "SUBSCRIPTION_NOT_ALLOWED" });
    }

    const offer = await loadOfferForBooking(booking);
    if (!offer)
      return res.status(400).json({ ok: false, code: "OFFER_NOT_FOUND" });

    const contract = contractFromBody(req.body);
    const v = validateContract(contract);
    if (Object.keys(v).length) {
      return res.status(400).json({ ok: false, code: "VALIDATION", errors: v });
    }

    booking.invoiceTo = booking.invoiceTo || {};
    booking.invoiceTo.parent = {
      salutation: contract.parent.salutation,
      firstName: contract.parent.firstName,
      lastName: contract.parent.lastName,
      email: contract.parent.email,
      phone: contract.parent.phone,
      phone2: contract.parent.mobile,
    };
    booking.invoiceTo.address = {
      street: contract.address.street,
      houseNo: contract.address.houseNo,
      zip: contract.address.zip,
      city: contract.address.city,
    };

    const signedAt = new Date().toISOString();
    meta.contractSignedAt = signedAt;

    meta.contractSnapshot = {
      signedAt,
      signatureName: contract.signatureName,
      consents: {
        acceptAgb: contract.consents.acceptAgb,
        acceptPrivacy: contract.consents.acceptPrivacy,
        consentPhotoVideo: contract.consents.consentPhotoVideo,
      },
      parent: contract.parent,
      address: contract.address,
      child: contract.child,
      offer: {
        offerId: String(offer._id),
        title: safeText(offer.title),
        type: safeText(offer.type),
        category: safeText(offer.category),
        sub_type: safeText(offer.sub_type),
        location: safeText(offer.location),
        days: Array.isArray(offer.days) ? offer.days : [],
        timeFrom: safeText(offer.timeFrom),
        timeTo: safeText(offer.timeTo),
      },
      booking: {
        bookingId: String(booking._id),
        startDate: safeText(booking.date),
        email: safeLower(booking.email),
      },
      tech: {
        ip: safeText(req.headers["x-forwarded-for"] || req.ip),
        ua: safeText(req.headers["user-agent"]),
      },
    };

    const doc = asObj(req.body?.contractDoc);
    meta.contractSnapshot.contractDoc = {
      version: safeText(doc.version),
      contentHtml: safeText(doc.contentHtml),
    };

    // booking.markModified("invoiceTo");
    // booking.markModified("meta");
    // await booking.save();

    // const out = await createSubscriptionCheckout({
    //   booking,
    //   returnTo: returnTo || undefined,
    // });

    booking.markModified("invoiceTo");
    booking.markModified("meta");
    await booking.save();

    await sendContractSignedMailOnce({ booking, offer });

    const out = await createSubscriptionCheckout({
      booking,
      returnTo: returnTo || undefined,
    });

    if (!out?.ok) {
      const code = out?.code || "SERVER";
      const status =
        code === "PAYMENT_NOT_APPROVED" ||
        code === "SUBSCRIPTION_NOT_ALLOWED" ||
        code === "NOT_A_SUBSCRIPTION_OFFER"
          ? 403
          : code === "SUBSCRIPTION_ALREADY_CREATED"
            ? 409
            : 400;

      return res.status(status).json({ ok: false, code });
    }

    return res.status(200).json({
      ok: true,
      contractSignedAt: signedAt,
      url: out.url,
      sessionId: out.sessionId,
    });
  } catch (e) {
    // console.error(
    //   "[public] weekly contract-submit-and-checkout error:",
    //   e?.message || e,
    // );
    console.error(
      "[public] weekly contract-submit-and-checkout error full:",
      e?.type,
      e?.code,
      e?.message,
      e,
    );
    return res.status(500).json({ ok: false, code: "SERVER" });
  }
});

router.get("/weekly/contract-preview", async (req, res) => {
  try {
    const token = safeText(req.query?.token);
    if (!token) {
      return res.status(400).json({ ok: false, code: "MISSING_TOKEN" });
    }

    const booking = await findByToken(token);
    if (!booking) {
      return res.status(404).json({ ok: false, code: "TOKEN_NOT_FOUND" });
    }

    const meta = ensureMeta(booking);
    if (isExpired(meta.contractTokenExpiresAt)) {
      return res.status(410).json({ ok: false, code: "TOKEN_EXPIRED" });
    }

    if (meta.subscriptionEligible !== true) {
      return res
        .status(403)
        .json({ ok: false, code: "SUBSCRIPTION_NOT_ALLOWED" });
    }

    const offer = await loadOfferForBooking(booking);
    if (!offer) {
      return res.status(400).json({ ok: false, code: "OFFER_NOT_FOUND" });
    }

    const pdfBuffer = await buildWeeklyContractPdf({ booking, offer });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="Vertrag.pdf"');
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(pdfBuffer);
  } catch (e) {
    console.error("[public] weekly contract-preview error:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER" });
  }
});

module.exports = router;

// // routes/publicWeeklyContract.js
// "use strict";

// const express = require("express");
// const crypto = require("crypto");
// const Booking = require("../models/Booking");
// const {
//   createSubscriptionCheckout,
// } = require("./payments/stripe/lib/createSubscriptionCheckout");
// const { safeStr } = require("./payments/stripe/lib/strings");

// const router = express.Router();

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function ensureMeta(booking) {
//   if (!booking.meta || typeof booking.meta !== "object") booking.meta = {};
//   return booking.meta;
// }

// function randomToken() {
//   return crypto.randomBytes(24).toString("hex");
// }

// function isExpired(iso) {
//   const s = safeText(iso);
//   if (!s) return false;
//   const t = new Date(s).getTime();
//   if (!Number.isFinite(t)) return false;
//   return Date.now() > t;
// }

// async function findByToken(token) {
//   return Booking.findOne({ "meta.contractToken": token });
// }

// router.post("/weekly/contract-token", async (req, res) => {
//   try {
//     const bookingId = safeText(req.body?.bookingId);
//     if (!bookingId) {
//       return res.status(400).json({ ok: false, code: "MISSING_BOOKING_ID" });
//     }

//     const booking = await Booking.findById(bookingId);
//     if (!booking) {
//       return res.status(404).json({ ok: false, code: "BOOKING_NOT_FOUND" });
//     }

//     const meta = ensureMeta(booking);

//     meta.contractToken = randomToken();
//     meta.contractTokenExpiresAt = new Date(
//       Date.now() + 7 * 24 * 60 * 60 * 1000,
//     ).toISOString();

//     booking.markModified("meta");
//     await booking.save();

//     return res.status(200).json({ ok: true, token: meta.contractToken });
//   } catch (e) {
//     console.error("[public] weekly contract-token error:", e?.message || e);
//     return res.status(500).json({ ok: false, code: "SERVER" });
//   }
// });

// router.post("/weekly/contract-sign", async (req, res) => {
//   try {
//     const token = safeText(req.body?.token);
//     if (!token) {
//       return res.status(400).json({ ok: false, code: "MISSING_TOKEN" });
//     }

//     const booking = await findByToken(token);
//     if (!booking) {
//       return res.status(404).json({ ok: false, code: "TOKEN_NOT_FOUND" });
//     }

//     const meta = ensureMeta(booking);

//     if (isExpired(meta.contractTokenExpiresAt)) {
//       return res.status(410).json({ ok: false, code: "TOKEN_EXPIRED" });
//     }

//     meta.contractSignedAt = new Date().toISOString();

//     booking.markModified("meta");
//     await booking.save();

//     return res.status(200).json({
//       ok: true,
//       contractSignedAt: meta.contractSignedAt,
//       bookingId: String(booking._id),
//     });
//   } catch (e) {
//     console.error("[public] weekly contract-sign error:", e?.message || e);
//     return res.status(500).json({ ok: false, code: "SERVER" });
//   }
// });

// router.post("/weekly/contract-sign-and-checkout", async (req, res) => {
//   try {
//     const token = safeText(req.body?.token);
//     const returnTo = safeText(req.body?.returnTo);
//     if (!token) {
//       return res.status(400).json({ ok: false, code: "MISSING_TOKEN" });
//     }

//     const booking = await findByToken(token);
//     if (!booking) {
//       return res.status(404).json({ ok: false, code: "TOKEN_NOT_FOUND" });
//     }

//     const meta = ensureMeta(booking);

//     if (isExpired(meta.contractTokenExpiresAt)) {
//       return res.status(410).json({ ok: false, code: "TOKEN_EXPIRED" });
//     }

//     if (!safeStr(meta.contractSignedAt)) {
//       meta.contractSignedAt = new Date().toISOString();
//       booking.markModified("meta");
//       await booking.save();
//     }

//     const out = await createSubscriptionCheckout({
//       booking,
//       returnTo: returnTo || undefined,
//     });

//     if (!out?.ok) {
//       const code = out?.code || "SERVER";
//       const status =
//         code === "PAYMENT_NOT_APPROVED" ||
//         code === "SUBSCRIPTION_NOT_ALLOWED" ||
//         code === "NOT_A_SUBSCRIPTION_OFFER"
//           ? 403
//           : code === "SUBSCRIPTION_ALREADY_CREATED"
//             ? 409
//             : 400;
//       return res.status(status).json({ ok: false, code });
//     }

//     return res.status(200).json({
//       ok: true,
//       contractSignedAt: safeText(meta.contractSignedAt),
//       url: out.url,
//       sessionId: out.sessionId,
//     });
//   } catch (e) {
//     console.error(
//       "[public] weekly contract-sign-and-checkout error:",
//       e?.message || e,
//     );
//     return res.status(500).json({ ok: false, code: "SERVER" });
//   }
// });

// module.exports = router;
