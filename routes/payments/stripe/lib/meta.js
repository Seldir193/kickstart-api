//routes\payments\stripe\lib\meta.js
"use strict";

const { safeStr } = require("./strings");

function bookingMeta(booking) {
  return booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
}

function amountString(value) {
  return typeof value === "number" ? String(value) : "";
}

function normalizeLower(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isWeeklyStripeBooking(offer) {
  return normalizeLower(offer?.category) === "weekly";
}

function nextMonthStartLabel(dateValue) {
  const base = dateValue ? new Date(dateValue) : new Date();
  if (Number.isNaN(base.getTime())) return "";

  const next = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1, 0, 0, 0),
  );

  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(next);
}

function pushAmountLine(lines, label, value) {
  if (typeof value !== "number") return;
  lines.push(`${label}: ${value} EUR`);
}

function stripeDescriptionLines(booking, offer) {
  const meta = bookingMeta(booking);
  const lines = [];

  const location = safeStr(offer?.location);
  if (location) lines.push(`Ort: ${location}`);

  pushAmountLine(lines, "Basispreis", meta.basePrice);
  pushAmountLine(lines, "Torwart Hauptkind", meta.mainGoalkeeperSurcharge);
  pushAmountLine(
    lines,
    "Torwart Geschwisterkind",
    meta.siblingGoalkeeperSurcharge,
  );
  pushAmountLine(lines, "Zwischensumme", meta.grossPrice);
  pushAmountLine(lines, "Mitgliederrabatt Hauptkind", meta.mainMemberDiscount);
  pushAmountLine(
    lines,
    "Mitgliederrabatt Geschwisterkind",
    meta.siblingMemberDiscount,
  );
  pushAmountLine(lines, "Geschwisterrabatt", meta.siblingDiscount);

  if (safeStr(meta.voucherCode)) {
    lines.push(`Gutschein: ${safeStr(meta.voucherCode)}`);
  }

  pushAmountLine(lines, "Gutscheinwert", meta.voucherDiscount);
  pushAmountLine(lines, "Gesamtrabatt", meta.totalDiscount);

  if (typeof booking?.priceFirstMonth === "number") {
    lines.push(`Erstmonat/Teilmonat: ${booking.priceFirstMonth} EUR`);
  }

  // if (typeof booking?.priceMonthly === "number") {
  //   const nextStart = nextMonthStartLabel(booking?.date);
  //   lines.push(
  //     nextStart
  //       ? `Reguläres Abo ab ${nextStart}: ${booking.priceMonthly} EUR`
  //       : `Reguläres Abo: ${booking.priceMonthly} EUR`,
  //   );
  // }

  if (
    isWeeklyStripeBooking(offer) &&
    typeof booking?.priceMonthly === "number"
  ) {
    const nextStart = nextMonthStartLabel(booking?.date);
    lines.push(
      nextStart
        ? `Reguläres Abo ab ${nextStart}: ${booking.priceMonthly} EUR`
        : `Reguläres Abo: ${booking.priceMonthly} EUR`,
    );
  }

  if (typeof booking?.priceAtBooking === "number") {
    lines.push(`Endbetrag: ${booking.priceAtBooking} EUR`);
  }

  return lines.join(" | ");
}

function metaForBooking(booking) {
  const meta = bookingMeta(booking);

  return {
    bookingId: String(booking._id || ""),
    ownerId: String(booking.owner || ""),
    offerId: String(booking.offerId || ""),
    customerId: String(booking.customerId || ""),
    childId: String(booking.childId || ""),
    childUid: String(booking.childUid || ""),
    source: String(booking.source || ""),
    invoiceNo: String(booking.invoiceNo || booking.invoiceNumber || ""),
    offerType: String(booking.offerType || ""),
    offerTitle: String(booking.offerTitle || ""),
    voucherCode: String(meta.voucherCode || meta.voucher || ""),
    basePrice: amountString(meta.basePrice),
    grossPrice: amountString(meta.grossPrice),
    siblingDiscount: amountString(meta.siblingDiscount),
    memberDiscount: amountString(meta.memberDiscount),
    mainMemberDiscount: amountString(meta.mainMemberDiscount),
    siblingMemberDiscount: amountString(meta.siblingMemberDiscount),
    mainGoalkeeperSurcharge: amountString(meta.mainGoalkeeperSurcharge),
    siblingGoalkeeperSurcharge: amountString(meta.siblingGoalkeeperSurcharge),
    goalkeeperTotal: amountString(meta.goalkeeperTotal),
    voucherDiscount: amountString(meta.voucherDiscount),
    totalDiscount: amountString(meta.totalDiscount),
    priceAtBooking: amountString(booking.priceAtBooking),
    priceFirstMonth: amountString(booking.priceFirstMonth),
    priceMonthly: amountString(booking.priceMonthly),
  };
}

function bookingIdFromInvoice(invoice) {
  const a = safeStr(invoice?.metadata?.bookingId);
  if (a) return a;
  const b = safeStr(invoice?.subscription_details?.metadata?.bookingId);
  if (b) return b;
  const lines = invoice?.lines?.data;
  if (!Array.isArray(lines)) return "";
  for (const ln of lines) {
    const c = safeStr(ln?.metadata?.bookingId);
    if (c) return c;
  }
  return "";
}

module.exports = {
  metaForBooking,
  bookingIdFromInvoice,
  stripeDescriptionLines,
};

// "use strict";

// const { safeStr } = require("./strings");

// function bookingMeta(booking) {
//   return booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
// }

// function amountString(value) {
//   return typeof value === "number" ? String(value) : "";
// }

// function nextMonthStartLabel(dateValue) {
//   const base = dateValue ? new Date(dateValue) : new Date();
//   if (Number.isNaN(base.getTime())) return "";

//   const next = new Date(
//     Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1, 0, 0, 0),
//   );

//   return new Intl.DateTimeFormat("de-DE", {
//     day: "2-digit",
//     month: "2-digit",
//     year: "numeric",
//     timeZone: "UTC",
//   }).format(next);
// }

// function stripeDescriptionLines(booking, offer) {
//   const meta = bookingMeta(booking);
//   const lines = [];

//   const location = safeStr(offer?.location);
//   if (location) lines.push(`Ort: ${location}`);

//   if (typeof meta.basePrice === "number") {
//     lines.push(`Basispreis: ${meta.basePrice} EUR`);
//   }

//   if (typeof meta.siblingDiscount === "number") {
//     lines.push(`Geschwisterrabatt: ${meta.siblingDiscount} EUR`);
//   }

//   if (typeof meta.memberDiscount === "number") {
//     lines.push(`Mitgliederrabatt: ${meta.memberDiscount} EUR`);
//   }

//   if (typeof meta.totalDiscount === "number") {
//     lines.push(`Gesamtrabatt: ${meta.totalDiscount} EUR`);
//   }

//   if (typeof booking?.priceFirstMonth === "number") {
//     lines.push(`Erstmonat/Teilmonat: ${booking.priceFirstMonth} EUR`);
//   }

//   if (typeof booking?.priceMonthly === "number") {
//     const nextStart = nextMonthStartLabel(booking?.date);
//     lines.push(
//       nextStart
//         ? `Reguläres Abo ab ${nextStart}: ${booking.priceMonthly} EUR`
//         : `Reguläres Abo: ${booking.priceMonthly} EUR`,
//     );
//   }

//   if (typeof booking?.priceAtBooking === "number") {
//     lines.push(`Endbetrag: ${booking.priceAtBooking} EUR`);
//   }

//   return lines.join(" | ");
// }

// function metaForBooking(booking) {
//   const meta = bookingMeta(booking);

//   return {
//     bookingId: String(booking._id || ""),
//     ownerId: String(booking.owner || ""),
//     offerId: String(booking.offerId || ""),
//     customerId: String(booking.customerId || ""),
//     childId: String(booking.childId || ""),
//     childUid: String(booking.childUid || ""),
//     source: String(booking.source || ""),
//     invoiceNo: String(booking.invoiceNo || booking.invoiceNumber || ""),
//     offerType: String(booking.offerType || ""),
//     offerTitle: String(booking.offerTitle || ""),
//     basePrice: amountString(meta.basePrice),
//     siblingDiscount: amountString(meta.siblingDiscount),
//     memberDiscount: amountString(meta.memberDiscount),
//     totalDiscount: amountString(meta.totalDiscount),
//     priceAtBooking: amountString(booking.priceAtBooking),
//     priceFirstMonth: amountString(booking.priceFirstMonth),
//     priceMonthly: amountString(booking.priceMonthly),
//   };
// }

// function bookingIdFromInvoice(invoice) {
//   const a = safeStr(invoice?.metadata?.bookingId);
//   if (a) return a;
//   const b = safeStr(invoice?.subscription_details?.metadata?.bookingId);
//   if (b) return b;
//   const lines = invoice?.lines?.data;
//   if (!Array.isArray(lines)) return "";
//   for (const ln of lines) {
//     const c = safeStr(ln?.metadata?.bookingId);
//     if (c) return c;
//   }
//   return "";
// }

// module.exports = {
//   metaForBooking,
//   bookingIdFromInvoice,
//   stripeDescriptionLines,
// };
