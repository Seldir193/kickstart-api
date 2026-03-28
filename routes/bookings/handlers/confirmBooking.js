//routes\bookings\handlers\confirmBooking.js
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const Booking = require("../../../models/Booking");
const Offer = require("../../../models/Offer");
const Customer = require("../../../models/Customer");

const {
  createHolidayInvoiceForBooking,
} = require("../../../utils/holidayInvoices");

const {
  sendBookingConfirmedEmail,
  sendParticipationEmail,
} = require("../../../utils/mailer");

const { resolveOwner } = require("../helpers/owner");
const {
  isNonTrialProgram,
  isHolidayProgram,
} = require("../helpers/offerTypes");

function safeText(v) {
  return String(v ?? "").trim();
}

function refBookingIdOf(ref) {
  return safeText(ref?.bookingId || ref?._id);
}

function isWeeklyOffer(offer) {
  const category = safeText(offer?.category);
  const type = safeText(offer?.type);
  return (
    category === "Weekly" ||
    type === "Foerdertraining" ||
    type === "Kindergarten"
  );
}

async function upsertCustomerBookingRef(customer, booking, offer) {
  if (!customer || !booking) return;
  if (!Array.isArray(customer.bookings)) customer.bookings = [];

  const bid = safeText(booking._id);
  if (!bid) return;

  const isSelfBooking = !safeText(booking?.childUid);

  const patch = {
    bookingId: booking._id,
    offerId: booking.offerId || offer?._id,
    offerTitle: safeText(offer?.title || booking.offerTitle || ""),
    offerType: safeText(
      offer?.sub_type || offer?.type || booking.offerType || "",
    ),
    venue: safeText(offer?.location || booking?.venue || ""),
    date: booking.date ? new Date(booking.date) : new Date(),
    status: safeText(booking.status || ""),
    priceAtBooking: booking.priceAtBooking ?? undefined,
    currency: safeText(booking.currency || "EUR"),
    invoiceNumber: safeText(booking.invoiceNumber || booking.invoiceNo || ""),
    invoiceNo: safeText(booking.invoiceNo || ""),
    invoiceDate: booking.invoiceDate || null,
    childUid: isSelfBooking ? "" : safeText(booking?.childUid),
    childFirstName: isSelfBooking ? "" : safeText(booking?.firstName),
    childLastName: isSelfBooking ? "" : safeText(booking?.lastName),
    parentEmail: safeText(booking?.invoiceTo?.parent?.email || booking?.email),
    parentFirstName: safeText(booking?.invoiceTo?.parent?.firstName),
    parentLastName: safeText(booking?.invoiceTo?.parent?.lastName),
  };

  const idx = customer.bookings.findIndex((r) => refBookingIdOf(r) === bid);

  if (idx >= 0) {
    customer.bookings[idx] = { ...(customer.bookings[idx] || {}), ...patch };
  } else {
    customer.bookings.push({ _id: booking._id, ...patch });
  }

  await customer.save();
}

// async function upsertCustomerBookingRef(customer, booking, offer) {
//   if (!customer || !booking) return;
//   if (!Array.isArray(customer.bookings)) customer.bookings = [];

//   const bid = safeText(booking._id);
//   if (!bid) return;

//   const child = customer.child || {};
//   const patch = {
//     bookingId: booking._id,
//     offerId: booking.offerId || offer?._id,
//     offerTitle: safeText(offer?.title || booking.offerTitle || ""),
//     offerType: safeText(
//       offer?.sub_type || offer?.type || booking.offerType || "",
//     ),
//     venue: safeText(offer?.location || booking?.venue || ""),
//     date: booking.date ? new Date(booking.date) : new Date(),
//     status: safeText(booking.status || ""),
//     priceAtBooking: booking.priceAtBooking ?? undefined,
//     currency: safeText(booking.currency || "EUR"),
//     invoiceNumber: safeText(booking.invoiceNumber || booking.invoiceNo || ""),
//     invoiceNo: safeText(booking.invoiceNo || ""),
//     invoiceDate: booking.invoiceDate || null,
//     childUid: safeText(child.uid),
//     childFirstName: safeText(child.firstName),
//     childLastName: safeText(child.lastName),
//   };

//   const idx = customer.bookings.findIndex((r) => refBookingIdOf(r) === bid);

//   if (idx >= 0) {
//     customer.bookings[idx] = { ...(customer.bookings[idx] || {}), ...patch };
//   } else {
//     customer.bookings.push({ _id: booking._id, ...patch });
//   }

//   await customer.save();
// }

async function findCustomerForBooking(ownerId, booking) {
  let customer = await Customer.findOne({
    owner: ownerId,
    "bookings.bookingId": booking._id,
  });

  if (customer) return customer;

  const mail = safeText(booking.email).toLowerCase();
  if (!mail) return null;

  return Customer.findOne({
    owner: ownerId,
    "parent.email": booking.email,
  });
}

async function confirmBooking(req, res) {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res
        .status(500)
        .json({ ok: false, error: "DEFAULT_OWNER_ID missing/invalid" });
    }

    const id = safeText(req.params.id);
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid booking id" });
    }

    const booking = await Booking.findOne({ _id: id, owner: ownerId });
    if (!booking) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    const forceResend = String(req.query.resend || "") === "1";
    const isManualConfirm = String(req.query.manual || "") === "1";
    const withInvoiceParam = String(req.query.withInvoice || "") === "1";
    const alreadyConfirmed = booking.status === "confirmed";

    // console.log("DEBUG confirmBooking query flags", {
    //   bookingId: String(booking._id),
    //   resend: req.query.resend,
    //   manual: req.query.manual,
    //   isManualConfirm,
    // });

    const offer = booking.offerId
      ? await Offer.findOne({ _id: booking.offerId, owner: ownerId }).lean()
      : null;

    // console.log("DEBUG confirmBooking offer snapshot", {
    //   bookingId: String(booking._id),
    //   offerId: String(booking.offerId || ""),
    //   hasOffer: !!offer,
    //   offerCategory: safeText(offer?.category),
    //   offerType: safeText(offer?.type),
    //   offerSubType: safeText(offer?.sub_type),
    //   bookingOfferTitle: safeText(booking.offerTitle),
    //   bookingOfferType: safeText(booking.offerType),
    //   source: booking.source,
    // });

    const isNonTrial = isNonTrialProgram(offer);
    const isHoliday = isHolidayProgram(offer);
    const isWeekly = isWeeklyOffer(offer);

    const isOnline = booking.source === "online_request";
    const isAdminBooking = booking.source === "admin_booking";

    const offerCategory = safeText(offer?.category);
    const offerSubType = safeText(offer?.sub_type).toLowerCase();

    const isClubProgram =
      offerCategory === "RentACoach" ||
      offerCategory === "ClubPrograms" ||
      offerSubType === "rentacoach_generic" ||
      offerSubType === "coacheducation" ||
      offerSubType === "clubprogram_generic";
    //const shouldAutoConfirmStatus = !(isAdminBooking && isClubProgram);
    const shouldAutoConfirmStatus =
      isManualConfirm || !(isAdminBooking && isClubProgram);

    //  const isAdminWeekly = isAdminBooking && isWeekly;
    const isAdminWeekly = isAdminBooking && isWeekly && !isClubProgram;
    const isHolidayBooking = isHoliday;
    const isAdminOneTime =
      isAdminBooking && !isWeekly && !isHoliday && !isClubProgram;

    // const shouldSendConfirmedMail =
    //   isOnline || isAdminWeekly || isAdminOneTime || isHolidayBooking;

    const shouldSendConfirmedMail =
      isManualConfirm ||
      isOnline ||
      isAdminWeekly ||
      isAdminOneTime ||
      isHolidayBooking;

    const wantInvoice = withInvoiceParam || isAdminOneTime;

    // console.log("DEBUG confirmBooking mail gate", {
    //   bookingId: String(booking._id),
    //   source: booking.source,
    //   offerCategory: safeText(offer?.category),
    //   offerType: safeText(offer?.type),
    //   offerSubType: safeText(offer?.sub_type),
    //   isWeekly,
    //   isHoliday,
    //   isAdminBooking,
    //   isClubProgram,
    //   isAdminWeekly,
    //   isAdminOneTime,
    //   shouldSendConfirmedMail,
    //   wantInvoice,
    // });

    if (!booking.confirmationCode) {
      booking.confirmationCode =
        "KS-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    }

    // if (!alreadyConfirmed) {
    //   booking.status = "confirmed";
    //   booking.confirmedAt = new Date();
    //   await booking.save();
    // }

    if (!alreadyConfirmed && shouldAutoConfirmStatus) {
      booking.status = "confirmed";
      booking.confirmedAt = new Date();
      await booking.save();
    }

    if (alreadyConfirmed && !forceResend) {
      return res.json({
        ok: true,
        booking,
        info: "already confirmed (no email sent)",
        wantInvoice,
      });
    }

    try {
      if (shouldSendConfirmedMail) {
        await sendBookingConfirmedEmail({
          to: booking.email,
          booking,
          offer,
          isNonTrial,
        });
      }

      if (wantInvoice) {
        if (isHoliday) {
          await createHolidayInvoiceForBooking({
            ownerId,
            offer,
            booking,
          });
        } else {
          const customer = await findCustomerForBooking(ownerId, booking);

          if (customer) {
            await upsertCustomerBookingRef(customer, booking, offer);

            await sendParticipationEmail({
              to: booking.email,
              customer,
              booking,
              offer,
            });
          } else {
            console.warn(
              "[bookings:confirm] no customer found for participation email",
              String(booking._id),
            );
          }
        }
      }

      return res.json({
        ok: true,
        booking,
        mailSent: shouldSendConfirmedMail,
        wantInvoice,
      });
    } catch (mailErr) {
      console.error(
        "[bookings:confirm] mail/pdf failed:",
        mailErr?.message || mailErr,
      );
      return res.status(200).json({
        ok: true,
        booking,
        mailSent: false,
        wantInvoice,
        error: "mail_failed",
      });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { confirmBooking };

// "use strict";

// const crypto = require("crypto");
// const mongoose = require("mongoose");

// const Booking = require("../../../models/Booking");
// const Offer = require("../../../models/Offer");
// const Customer = require("../../../models/Customer");

// const {
//   createHolidayInvoiceForBooking,
// } = require("../../../utils/holidayInvoices");

// const {
//   sendBookingConfirmedEmail,
//   sendParticipationEmail,
// } = require("../../../utils/mailer");

// const { resolveOwner } = require("../helpers/owner");
// const {
//   isNonTrialProgram,
//   isHolidayProgram,
// } = require("../helpers/offerTypes");

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function refBookingIdOf(ref) {
//   return safeText(ref?.bookingId || ref?._id);
// }

// function isWeeklyOffer(offer) {
//   const category = safeText(offer?.category);
//   const type = safeText(offer?.type);
//   return (
//     category === "Weekly" ||
//     type === "Foerdertraining" ||
//     type === "Kindergarten"
//   );
// }

// async function upsertCustomerBookingRef(customer, booking, offer) {
//   if (!customer || !booking) return;
//   if (!Array.isArray(customer.bookings)) customer.bookings = [];

//   const bid = safeText(booking._id);
//   if (!bid) return;

//   const child = customer.child || {};
//   const patch = {
//     bookingId: booking._id,
//     offerId: booking.offerId || offer?._id,
//     offerTitle: safeText(offer?.title || booking.offerTitle || ""),
//     offerType: safeText(
//       offer?.sub_type || offer?.type || booking.offerType || "",
//     ),
//     venue: safeText(offer?.location || booking?.venue || ""),
//     date: booking.date ? new Date(booking.date) : new Date(),
//     status: safeText(booking.status || ""),
//     priceAtBooking: booking.priceAtBooking ?? undefined,
//     currency: safeText(booking.currency || "EUR"),
//     invoiceNumber: safeText(booking.invoiceNumber || booking.invoiceNo || ""),
//     invoiceNo: safeText(booking.invoiceNo || ""),
//     invoiceDate: booking.invoiceDate || null,
//     childUid: safeText(child.uid),
//     childFirstName: safeText(child.firstName),
//     childLastName: safeText(child.lastName),
//   };

//   const idx = customer.bookings.findIndex((r) => refBookingIdOf(r) === bid);

//   if (idx >= 0) {
//     customer.bookings[idx] = { ...(customer.bookings[idx] || {}), ...patch };
//   } else {
//     customer.bookings.push({ _id: booking._id, ...patch });
//   }

//   await customer.save();
// }

// async function findCustomerForBooking(ownerId, booking) {
//   let customer = await Customer.findOne({
//     owner: ownerId,
//     "bookings.bookingId": booking._id,
//   });

//   if (customer) return customer;

//   const mail = safeText(booking.email).toLowerCase();
//   if (!mail) return null;

//   return Customer.findOne({
//     owner: ownerId,
//     "parent.email": booking.email,
//   });
// }

// async function confirmBooking(req, res) {
//   try {
//     const ownerId = resolveOwner(req);
//     if (!ownerId) {
//       return res
//         .status(500)
//         .json({ ok: false, error: "DEFAULT_OWNER_ID missing/invalid" });
//     }

//     const id = safeText(req.params.id);
//     if (!mongoose.isValidObjectId(id)) {
//       return res.status(400).json({ ok: false, error: "Invalid booking id" });
//     }

//     const booking = await Booking.findOne({ _id: id, owner: ownerId });
//     if (!booking) {
//       return res.status(404).json({ ok: false, error: "Not found" });
//     }

//     const forceResend = String(req.query.resend || "") === "1";
//     const withInvoiceParam = String(req.query.withInvoice || "") === "1";
//     const alreadyConfirmed = booking.status === "confirmed";

//     const offer = booking.offerId
//       ? await Offer.findOne({ _id: booking.offerId, owner: ownerId }).lean()
//       : null;

//     const isNonTrial = isNonTrialProgram(offer);
//     const isHoliday = isHolidayProgram(offer);
//     const isWeekly = isWeeklyOffer(offer);

//     // const isOnline = booking.source === "online_request";
//     // const isAdminBooking = booking.source === "admin_booking";
//     // const isAdminWeekly = isAdminBooking && isWeekly;
//     // const isAdminOneTime = isAdminBooking && !isWeekly && !isHoliday;

//     // const shouldSendConfirmedMail = isOnline || isAdminWeekly || isAdminOneTime;
//     // const wantInvoice = withInvoiceParam || isAdminOneTime;

//     const isOnline = booking.source === "online_request";
//     const isAdminBooking = booking.source === "admin_booking";
//     const isAdminWeekly = isAdminBooking && isWeekly;
//     const isHolidayBooking = isHoliday;
//     const isAdminOneTime = isAdminBooking && !isWeekly && !isHoliday;

//     const shouldSendConfirmedMail =
//       isOnline || isAdminWeekly || isAdminOneTime || isHolidayBooking;

//     const wantInvoice = withInvoiceParam || isAdminOneTime;

//     if (!booking.confirmationCode) {
//       booking.confirmationCode =
//         "KS-" + crypto.randomBytes(3).toString("hex").toUpperCase();
//     }

//     if (!alreadyConfirmed) {
//       booking.status = "confirmed";
//       booking.confirmedAt = new Date();
//       await booking.save();
//     }

//     if (alreadyConfirmed && !forceResend) {
//       return res.json({
//         ok: true,
//         booking,
//         info: "already confirmed (no email sent)",
//         wantInvoice,
//       });
//     }

//     try {
//       if (shouldSendConfirmedMail) {
//         await sendBookingConfirmedEmail({
//           to: booking.email,
//           booking,
//           offer,
//           isNonTrial,
//         });
//       }

//       if (wantInvoice) {
//         if (isHoliday) {
//           await createHolidayInvoiceForBooking({
//             ownerId,
//             offer,
//             booking,
//           });
//         } else {
//           const customer = await findCustomerForBooking(ownerId, booking);

//           if (customer) {
//             await upsertCustomerBookingRef(customer, booking, offer);

//             await sendParticipationEmail({
//               to: booking.email,
//               customer,
//               booking,
//               offer,
//             });
//           } else {
//             console.warn(
//               "[bookings:confirm] no customer found for participation email",
//               String(booking._id),
//             );
//           }
//         }
//       }

//       return res.json({
//         ok: true,
//         booking,
//         mailSent: true,
//         wantInvoice,
//       });
//     } catch (mailErr) {
//       console.error(
//         "[bookings:confirm] mail/pdf failed:",
//         mailErr?.message || mailErr,
//       );
//       return res.status(200).json({
//         ok: true,
//         booking,
//         mailSent: false,
//         wantInvoice,
//         error: "mail_failed",
//       });
//     }
//   } catch (err) {
//     console.error(err);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// }

// module.exports = { confirmBooking };
