// // //utils\pdf.js
// utils/pdf.js
"use strict";

require("dotenv").config();

let htmlRenderer;
try {
  htmlRenderer = require("./pdfHtml");
} catch (e) {
  const msg =
    "[utils/pdf] Konnte ./pdfHtml nicht laden. Erwartete Exporte: " +
    "bookingPdfBufferHTML, buildParticipationPdfHTML, buildCancellationPdfHTML, buildStornoPdfHTML.\n" +
    `Originalfehler: ${e && e.message ? e.message : String(e)}`;
  throw new Error(msg);
}

function assertFn(name) {
  if (typeof htmlRenderer[name] !== "function") {
    throw new Error(
      `[utils/pdf] Erwartete Funktion "${name}" fehlt in utils/pdfHtml.js`,
    );
  }
}

const {
  shapeParticipationData,
  shapeCancellationData,
  shapeStornoData,
  shapeDunningData,
  shapeWeeklyContractData,
  normalizeInvoiceNo,
} = require("./pdfData");

async function buildWeeklyRecurringInvoicePdf({
  customer,
  booking,
  offer,
  invoiceNo,
  invoiceDate,
  amount,
  billingMonth,
  billingMonthLabel,
  periodStart,
  periodEnd,
  periodStartDisplay,
  periodEndDisplay,
  venue,
} = {}) {
  assertFn("buildWeeklyRecurringInvoicePdfHTML");

  const shaped = shapeParticipationData({ customer, booking, offer });

  shaped.invoice = shaped.invoice || {};
  shaped.pricing = shaped.pricing || {};
  shaped.customer = shaped.customer || {};
  shaped.booking = shaped.booking || {};

  const currency = String(
    shaped.invoice.currency ||
      shaped.pricing.currency ||
      shaped.booking.currency ||
      "EUR",
  );

  shaped.invoice.currency = currency;
  shaped.pricing.currency = currency;

  if (venue && !shaped.booking.venue) shaped.booking.venue = venue;

  shaped.booking.offer =
    shaped.booking.offer ||
    shaped.booking.offerTitle ||
    shaped.booking.offerType ||
    "";

  shaped.invoice.number = normalizeInvoiceNo(invoiceNo || "");
  shaped.invoice.date = invoiceDate || "";
  shaped.invoice.amount = amount;
  shaped.invoice.billingMonth = billingMonth || "";
  shaped.invoice.billingMonthLabel = billingMonthLabel || billingMonth || "";
  shaped.invoice.periodStart = periodStart || "";
  shaped.invoice.periodEnd = periodEnd || "";
  shaped.invoice.periodStartDisplay = periodStartDisplay || periodStart || "";
  shaped.invoice.periodEndDisplay = periodEndDisplay || periodEnd || "";

  return htmlRenderer.buildWeeklyRecurringInvoicePdfHTML({
    customer: shaped.customer,
    booking: shaped.booking,
    offer,
    invoice: shaped.invoice,
  });
}

async function bookingPdfBuffer(booking) {
  assertFn("bookingPdfBufferHTML");
  return htmlRenderer.bookingPdfBufferHTML(booking);
}

function computeIsWeekly(offer) {
  if (!offer) return false;

  const category = String(offer.category || "").trim();
  const type = String(offer.type || "").trim();
  const subType = String(offer.sub_type || "")
    .trim()
    .toLowerCase();
  const title = String(offer.title || "")
    .trim()
    .toLowerCase();

  const isExplicitNonWeekly =
    category === "RentACoach" ||
    category === "ClubPrograms" ||
    category === "Individual" ||
    category === "Holiday" ||
    category === "HolidayPrograms" ||
    subType.startsWith("rentacoach") ||
    subType.includes("coacheducation") ||
    subType.includes("trainingcamp") ||
    subType.includes("trainingscamp") ||
    subType.includes("powertraining") ||
    subType.startsWith("clubprogram") ||
    type === "PersonalTraining" ||
    type === "CoachEducation" ||
    title.includes("rentacoach") ||
    title.includes("coacheducation") ||
    title.includes("powertraining");

  if (isExplicitNonWeekly) return false;
  if (category === "Weekly") return true;
  if (type === "Foerdertraining" || type === "Kindergarten") return true;

  return false;
}

function safeText(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function toNum(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" && v.trim() === "") return undefined;
  if (typeof v === "object" && v && typeof v.toString === "function") {
    const s = String(v.toString()).trim();
    if (s !== "" && Number.isFinite(Number(s))) return Number(s);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toNumNonZero(v) {
  const n = toNum(v);
  return n === 0 ? undefined : n;
}

function prorate(iso, monthly) {
  if (!iso || monthly == null) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getFullYear();
  const m = d.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const startDay = d.getDate();
  const daysRemaining = Math.max(0, daysInMonth - startDay + 1);
  const factor = Math.max(0, Math.min(1, daysRemaining / daysInMonth));
  return Math.round(monthly * factor * 100) / 100;
}

async function buildParticipationPdf({
  customer,
  booking,
  offer,
  invoiceNo,
  invoiceDate,
  monthlyAmount,
  firstMonthAmount,
  venue,
} = {}) {
  assertFn("buildParticipationPdfHTML");

  const shaped = shapeParticipationData({ customer, booking, offer });
  const isWeekly = computeIsWeekly(offer);

  shaped.invoice = shaped.invoice || {};
  shaped.pricing = shaped.pricing || {};
  shaped.customer = shaped.customer || {};
  shaped.booking = shaped.booking || {};

  const CURRENCY = String(
    shaped.invoice.currency ||
      shaped.pricing.currency ||
      shaped.booking.currency ||
      "EUR",
  );

  shaped.invoice.currency = CURRENCY;
  shaped.pricing.currency = CURRENCY;

  if (venue && !shaped.booking.venue) shaped.booking.venue = venue;

  if (invoiceNo) shaped.booking.invoiceNo = normalizeInvoiceNo(invoiceNo);
  if (invoiceDate) shaped.booking.invoiceDate = String(invoiceDate);

  const effectiveInvoiceNo =
    normalizeInvoiceNo(invoiceNo) ||
    normalizeInvoiceNo(shaped.booking.invoiceNo) ||
    normalizeInvoiceNo(booking?.invoiceNo) ||
    normalizeInvoiceNo(booking?.invoiceNumber) ||
    "";

  const effectiveInvoiceDate =
    (invoiceDate != null && String(invoiceDate)) ||
    shaped.booking.invoiceDate ||
    booking?.invoiceDate ||
    "";

  shaped.booking.invoiceNo = effectiveInvoiceNo || shaped.booking.invoiceNo;
  shaped.booking.invoiceDate =
    effectiveInvoiceDate || shaped.booking.invoiceDate;

  shaped.invoice.number = shaped.invoice.number || effectiveInvoiceNo;
  shaped.invoice.date = shaped.invoice.date || effectiveInvoiceDate;

  if (monthlyAmount != null) {
    shaped.booking.monthlyAmount = Number(monthlyAmount);
  }

  if (firstMonthAmount != null) {
    shaped.booking.firstMonthAmount = Number(firstMonthAmount);
  }

  shaped.booking.dayTimes =
    shaped.booking.dayTimes ||
    booking?.dayTimes ||
    booking?.kurstag ||
    booking?.weekday ||
    "";

  shaped.booking.timeDisplay =
    shaped.booking.timeDisplay ||
    booking?.timeDisplay ||
    booking?.kurszeit ||
    booking?.time ||
    booking?.uhrzeit ||
    "";

  const startISO = shaped.booking.date || booking?.date || "";

  if (isWeekly) {
    const monthly =
      toNum(shaped.booking.monthlyAmount) ??
      toNum(booking?.monthlyAmount) ??
      toNum(booking?.priceMonthly) ??
      toNumNonZero(shaped.invoice.monthly) ??
      toNumNonZero(shaped.pricing.monthly) ??
      toNum(offer?.price);

    if (monthly != null) {
      shaped.invoice.monthly = monthly;
      shaped.pricing.monthly = monthly;
    }

    const firstMonth =
      toNum(shaped.booking.firstMonthAmount) ??
      toNum(booking?.firstMonthAmount) ??
      toNum(booking?.priceFirstMonth) ??
      toNumNonZero(shaped.invoice.firstMonth) ??
      toNumNonZero(shaped.pricing.firstMonth) ??
      (monthly != null ? prorate(startISO, monthly) : undefined);

    if (firstMonth != null) {
      shaped.invoice.firstMonth = firstMonth;
      shaped.pricing.firstMonth = firstMonth;
    }

    const meta =
      booking && typeof booking.meta === "object" ? booking.meta : {};

    const voucherDiscount = toNum(meta.voucherDiscount) ?? 0;
    const totalDiscount = toNum(meta.totalDiscount) ?? voucherDiscount;

    shaped.booking.discount = {
      ...(shaped.booking.discount || {}),
      voucherCode: safeText(meta.voucherCode || meta.voucher),
      voucherDiscount,
      totalDiscount,
      finalPrice:
        toNum(booking?.priceAtBooking) ??
        toNum(shaped.booking.priceAtBooking) ??
        toNum(firstMonth) ??
        null,
    };

    delete shaped.invoice.oneOff;
    delete shaped.pricing.oneOff;
    delete shaped.invoice.single;
    delete shaped.pricing.single;
  } else {
    const meta =
      booking && typeof booking.meta === "object" ? booking.meta : {};

    const basePrice = toNum(meta.basePrice);
    const grossPrice = toNum(meta.grossPrice);

    const mainGoalkeeperSurcharge = toNum(meta.mainGoalkeeperSurcharge) ?? 0;
    const siblingGoalkeeperSurcharge =
      toNum(meta.siblingGoalkeeperSurcharge) ?? 0;

    const goalkeeperTotal =
      toNum(meta.goalkeeperTotal) ??
      mainGoalkeeperSurcharge + siblingGoalkeeperSurcharge;

    const siblingDiscount = toNum(meta.siblingDiscount) ?? 0;
    const mainMemberDiscount = toNum(meta.mainMemberDiscount) ?? 0;
    const siblingMemberDiscount = toNum(meta.siblingMemberDiscount) ?? 0;

    const memberDiscount =
      toNum(meta.memberDiscount) ?? mainMemberDiscount + siblingMemberDiscount;

    const voucherDiscount = toNum(meta.voucherDiscount) ?? 0;

    const totalDiscount =
      toNum(meta.totalDiscount) ??
      siblingDiscount + memberDiscount + voucherDiscount;

    const finalPrice =
      toNum(booking?.priceAtBooking) ??
      toNum(shaped.booking.priceAtBooking) ??
      (grossPrice != null ? grossPrice - totalDiscount : undefined) ??
      toNumNonZero(shaped.invoice.single) ??
      toNumNonZero(shaped.invoice.oneOff) ??
      toNumNonZero(shaped.pricing.single) ??
      toNum(offer?.price);

    shaped.booking.discount = {
      basePrice: basePrice ?? null,
      grossPrice: grossPrice ?? null,
      mainGoalkeeperSurcharge,
      siblingGoalkeeperSurcharge,
      goalkeeperTotal,
      siblingDiscount,
      mainMemberDiscount,
      siblingMemberDiscount,
      memberDiscount,
      voucherCode: safeText(meta.voucherCode || meta.voucher),
      voucherDiscount,
      totalDiscount,
      finalPrice: finalPrice ?? grossPrice ?? basePrice ?? null,
    };

    if (finalPrice != null) {
      shaped.invoice.single = finalPrice;
      shaped.pricing.single = finalPrice;
    }

    delete shaped.pricing.firstMonth;
    delete shaped.invoice.firstMonth;
  }

  shaped.booking.isWeekly = isWeekly;
  shaped.isWeekly = isWeekly;

  return htmlRenderer.buildParticipationPdfHTML({
    customer: shaped.customer,
    booking: shaped.booking,
    offer,
    invoiceNo: effectiveInvoiceNo,
    invoiceDate: effectiveInvoiceDate,
    monthlyAmount,
    firstMonthAmount,
    venue,
    isWeekly,
    pricing: shaped.pricing,
    invoice: shaped.invoice,
  });
}

// async function buildParticipationPdf({
//   customer,
//   booking,
//   offer,
//   invoiceNo,
//   invoiceDate,
//   monthlyAmount,
//   firstMonthAmount,
//   venue,
// } = {}) {
//   assertFn("buildParticipationPdfHTML");

//   const shaped = shapeParticipationData({ customer, booking, offer });
//   const isWeekly = computeIsWeekly(offer);

//   shaped.invoice = shaped.invoice || {};
//   shaped.pricing = shaped.pricing || {};
//   shaped.customer = shaped.customer || {};
//   shaped.booking = shaped.booking || {};

//   const CURRENCY = String(
//     shaped.invoice.currency ||
//       shaped.pricing.currency ||
//       shaped.booking.currency ||
//       "EUR",
//   );
//   shaped.invoice.currency = CURRENCY;
//   shaped.pricing.currency = CURRENCY;

//   if (venue && !shaped.booking.venue) shaped.booking.venue = venue;

//   if (invoiceNo) shaped.booking.invoiceNo = normalizeInvoiceNo(invoiceNo);
//   if (invoiceDate) shaped.booking.invoiceDate = String(invoiceDate);

//   const effectiveInvoiceNo =
//     normalizeInvoiceNo(invoiceNo) ||
//     normalizeInvoiceNo(shaped.booking.invoiceNo) ||
//     normalizeInvoiceNo(booking?.invoiceNo) ||
//     normalizeInvoiceNo(booking?.invoiceNumber) ||
//     "";

//   const effectiveInvoiceDate =
//     (invoiceDate != null && String(invoiceDate)) ||
//     shaped.booking.invoiceDate ||
//     booking?.invoiceDate ||
//     "";

//   shaped.booking.invoiceNo = effectiveInvoiceNo || shaped.booking.invoiceNo;
//   shaped.booking.invoiceDate =
//     effectiveInvoiceDate || shaped.booking.invoiceDate;

//   shaped.invoice.number = shaped.invoice.number || effectiveInvoiceNo;
//   shaped.invoice.date = shaped.invoice.date || effectiveInvoiceDate;

//   if (monthlyAmount != null)
//     shaped.booking.monthlyAmount = Number(monthlyAmount);
//   if (firstMonthAmount != null)
//     shaped.booking.firstMonthAmount = Number(firstMonthAmount);

//   shaped.booking.dayTimes =
//     shaped.booking.dayTimes ||
//     booking?.dayTimes ||
//     booking?.kurstag ||
//     booking?.weekday ||
//     "";

//   shaped.booking.timeDisplay =
//     shaped.booking.timeDisplay ||
//     booking?.timeDisplay ||
//     booking?.kurszeit ||
//     booking?.time ||
//     booking?.uhrzeit ||
//     "";

//   const startISO = shaped.booking.date || booking?.date || "";

//   if (isWeekly) {
//     const monthly =
//       toNum(shaped.booking.monthlyAmount) ??
//       toNum(booking?.monthlyAmount) ??
//       toNum(booking?.priceMonthly) ??
//       toNum(shaped.booking.priceAtBooking) ??
//       toNum(booking?.priceAtBooking) ??
//       toNumNonZero(shaped.invoice.monthly) ??
//       toNumNonZero(shaped.pricing.monthly) ??
//       toNum(offer?.price);

//     if (monthly != null) {
//       shaped.invoice.monthly = monthly;
//       shaped.pricing.monthly = monthly;
//     }

//     const firstMonth =
//       toNum(shaped.booking.firstMonthAmount) ??
//       toNum(booking?.firstMonthAmount) ??
//       toNum(booking?.priceFirstMonth) ??
//       toNumNonZero(shaped.invoice.firstMonth) ??
//       toNumNonZero(shaped.pricing.firstMonth) ??
//       (monthly != null ? prorate(startISO, monthly) : undefined);

//     if (firstMonth != null) {
//       shaped.invoice.firstMonth = firstMonth;
//       shaped.pricing.firstMonth = firstMonth;
//     }

//     delete shaped.invoice.oneOff;
//     delete shaped.pricing.oneOff;
//     delete shaped.invoice.single;
//     delete shaped.pricing.single;
//   } else {
//     const meta =
//       booking && typeof booking.meta === "object" ? booking.meta : {};

//     const basePrice = toNum(meta.basePrice);
//     const grossPrice = toNum(meta.grossPrice);

//     const mainGoalkeeperSurcharge = toNum(meta.mainGoalkeeperSurcharge) ?? 0;

//     const siblingGoalkeeperSurcharge =
//       toNum(meta.siblingGoalkeeperSurcharge) ?? 0;

//     const goalkeeperTotal =
//       toNum(meta.goalkeeperTotal) ??
//       mainGoalkeeperSurcharge + siblingGoalkeeperSurcharge;

//     const siblingDiscount = toNum(meta.siblingDiscount) ?? 0;
//     const mainMemberDiscount = toNum(meta.mainMemberDiscount) ?? 0;
//     const siblingMemberDiscount = toNum(meta.siblingMemberDiscount) ?? 0;

//     const memberDiscount =
//       toNum(meta.memberDiscount) ?? mainMemberDiscount + siblingMemberDiscount;

//     const voucherDiscount = toNum(meta.voucherDiscount) ?? 0;

//     const totalDiscount =
//       toNum(meta.totalDiscount) ??
//       siblingDiscount + memberDiscount + voucherDiscount;

//     const finalPrice =
//       toNum(booking?.priceAtBooking) ??
//       toNum(shaped.booking.priceAtBooking) ??
//       (grossPrice != null ? grossPrice - totalDiscount : undefined) ??
//       toNumNonZero(shaped.invoice.single) ??
//       toNumNonZero(shaped.invoice.oneOff) ??
//       toNumNonZero(shaped.pricing.single) ??
//       toNum(offer?.price);

//     shaped.booking.discount = {
//       basePrice: basePrice ?? null,
//       grossPrice: grossPrice ?? null,
//       mainGoalkeeperSurcharge,
//       siblingGoalkeeperSurcharge,
//       goalkeeperTotal,
//       siblingDiscount,
//       mainMemberDiscount,
//       siblingMemberDiscount,
//       memberDiscount,
//       voucherCode: safeText(meta.voucherCode || meta.voucher),
//       voucherDiscount,
//       totalDiscount,
//       finalPrice: finalPrice ?? grossPrice ?? basePrice ?? null,
//     };

//     if (finalPrice != null) {
//       shaped.invoice.single = finalPrice;
//       shaped.pricing.single = finalPrice;
//     }

//     delete shaped.pricing.firstMonth;
//     delete shaped.invoice.firstMonth;
//   }

//   shaped.booking.isWeekly = isWeekly;
//   shaped.isWeekly = isWeekly;

//   return htmlRenderer.buildParticipationPdfHTML({
//     customer: shaped.customer,
//     booking: shaped.booking,
//     offer,
//     invoiceNo: effectiveInvoiceNo,
//     invoiceDate: effectiveInvoiceDate,
//     monthlyAmount,
//     firstMonthAmount,
//     venue,
//     isWeekly,
//     pricing: shaped.pricing,
//     invoice: shaped.invoice,
//   });
// }
async function buildCancellationPdf({
  customer,
  booking,
  offer,
  date,
  endDate,
  reason,
  cancellationNo,
  refInvoiceNo,
  refInvoiceDate,
  referenceInvoice,
} = {}) {
  assertFn("buildCancellationPdfHTML");

  const shaped = shapeCancellationData({
    customer,
    booking,
    offer,
    date,
    endDate,
    reason,
  });

  if (cancellationNo) shaped.booking.cancellationNo = String(cancellationNo);
  if (refInvoiceNo)
    shaped.booking.refInvoiceNo = normalizeInvoiceNo(refInvoiceNo);
  if (refInvoiceDate) shaped.booking.refInvoiceDate = String(refInvoiceDate);

  if (referenceInvoice?.number && !shaped.booking.refInvoiceNo) {
    shaped.booking.refInvoiceNo = normalizeInvoiceNo(referenceInvoice.number);
  }

  if (referenceInvoice?.date && !shaped.booking.refInvoiceDate) {
    shaped.booking.refInvoiceDate = String(referenceInvoice.date);
  }

  if (!shaped.booking.refInvoiceNo) {
    shaped.booking.refInvoiceNo = shaped.booking.invoiceNo || "";
  }

  if (!shaped.booking.refInvoiceDate) {
    shaped.booking.refInvoiceDate = shaped.booking.invoiceDate || "";
  }

  if (!shaped.booking.cancelDate) {
    shaped.booking.cancelDate = shaped.details.cancelDate;
  }

  if (!shaped.booking.endDate) {
    shaped.booking.endDate = shaped.details.endDate;
  }

  console.log("[PDF cancel] dates:", {
    requestDate: shaped.details.requestDate,
    cancelDate: shaped.details.cancelDate,
    endDate: shaped.details.endDate,
  });

  return htmlRenderer.buildCancellationPdfHTML({
    customer: shaped.customer,
    booking: shaped.booking,
    offer,
    date: shaped.details.cancelDate,
    reason: shaped.details.reason,
    requestDate: shaped.details.requestDate,
    endDate: shaped.details.endDate,
  });
}

async function buildStornoPdf({
  customer,
  booking,
  offer,
  amount,
  currency = "EUR",
  stornoNo,
  refInvoiceNo,
  refInvoiceDate,
  referenceInvoice,
} = {}) {
  assertFn("buildStornoPdfHTML");

  const shaped = shapeStornoData({
    customer,
    booking,
    offer,
    amount,
    currency,
  });

  const meta = booking && typeof booking.meta === "object" ? booking.meta : {};
  const voucherDiscount = toNum(meta.voucherDiscount) ?? 0;
  const totalDiscount = toNum(meta.totalDiscount) ?? voucherDiscount;

  const grossBase =
    toNum(meta.grossPrice) ??
    toNum(meta.basePrice) ??
    toNum(offer?.price) ??
    undefined;

  const discountedOriginalAmount =
    toNum(booking?.priceAtBooking) ??
    toNum(meta.finalPrice) ??
    (grossBase != null ? grossBase - totalDiscount : undefined);

  shaped.booking.discount = {
    ...(shaped.booking.discount || {}),
    voucherCode: safeText(meta.voucherCode || meta.voucher),
    voucherDiscount,
    totalDiscount,
    finalPrice: discountedOriginalAmount ?? null,
  };

  const effAmount =
    toNum(shaped.amount) ??
    toNum(booking?.stornoAmount) ??
    discountedOriginalAmount ??
    toNum(offer?.price) ??
    0;

  // const effAmount =
  //   toNum(shaped.amount) ??
  //   toNum(booking?.stornoAmount) ??
  //   toNum(booking?.priceAtBooking) ??
  //   toNum(offer?.price) ??
  //   0;

  const curr = String(shaped.currency || "EUR");

  if (stornoNo) shaped.booking.stornoNo = String(stornoNo);
  if (refInvoiceNo)
    shaped.booking.refInvoiceNo = normalizeInvoiceNo(refInvoiceNo);
  if (refInvoiceDate) shaped.booking.refInvoiceDate = String(refInvoiceDate);

  if (referenceInvoice?.number && !shaped.booking.refInvoiceNo) {
    shaped.booking.refInvoiceNo = normalizeInvoiceNo(referenceInvoice.number);
  }
  if (referenceInvoice?.date && !shaped.booking.refInvoiceDate) {
    shaped.booking.refInvoiceDate = String(referenceInvoice.date);
  }

  if (!shaped.booking.refInvoiceNo)
    shaped.booking.refInvoiceNo = shaped.booking.invoiceNo || "";
  if (!shaped.booking.refInvoiceDate)
    shaped.booking.refInvoiceDate = shaped.booking.invoiceDate || "";

  return htmlRenderer.buildStornoPdfHTML({
    customer: shaped.customer,
    booking: shaped.booking,
    offer,
    amount: effAmount,
    currency: curr,
  });
}

async function buildDunningPdf({
  customer,
  booking,
  stage,
  issuedAt,
  dueAt,
  feeSnapshot,
  freeText,
} = {}) {
  assertFn("buildDunningPdfHTML");

  const shaped = shapeDunningData({
    customer,
    booking,
    stage,
    issuedAt,
    dueAt,
    feeSnapshot,
    freeText,
  });

  return htmlRenderer.buildDunningPdfHTML({
    customer: shaped.customer,
    booking: shaped.booking,
    stage: shaped.dunning.stage,
    issuedAt: shaped.dunning.issuedAt,
    dueAt: shaped.dunning.dueAt,
    feeSnapshot: {
      ...shaped.amounts,
      totalExtraFees: shaped.amounts.totalExtraFees,
    },
    freeText: shaped.dunning.freeText,
  });
}

async function buildWeeklyContractPdf({ booking, offer } = {}) {
  assertFn("buildWeeklyContractPdfHTML");

  const contract = shapeWeeklyContractData({ booking, offer });
  return htmlRenderer.buildWeeklyContractPdfHTML({ contract });
}

module.exports = {
  bookingPdfBuffer,
  buildParticipationPdf,
  buildCancellationPdf,
  buildStornoPdf,
  buildDunningPdf,
  buildWeeklyContractPdf,
  buildWeeklyRecurringInvoicePdf,
};
