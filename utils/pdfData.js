// // // utils/pdfData.js
// utils/pdfData.js
"use strict";

function safeText(v) {
  return String(v ?? "").trim();
}

function toNum(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toISODate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString().slice(0, 10);
}

function sanitizeCourseTitle(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.split(/\s*(?:[•|]|—|–)\s*/)[0];
  const commaDigit = s.search(/,\s*\d/);
  if (commaDigit > 0) s = s.slice(0, commaDigit);
  const dashAddr = s.search(/\s-\s*\d/);
  if (dashAddr > 0) s = s.slice(0, dashAddr);
  return s.trim();
}

function normalizeInvoiceNo(v) {
  if (!v) return "";
  let s = String(v).trim();
  s = s.replace(/^[a-f0-9]{24}\//i, "");
  s = s.replace(/\\/g, "/");

  const m1 = s.match(/^([A-Z0-9ÄÖÜ]+)[\/\-](\d{2}|\d{4})[\/\-](\d{1,5})$/i);
  if (m1) {
    const code = m1[1].toUpperCase();
    const yy = m1[2].slice(-2);
    const seq = String(m1[3]).padStart(4, "0");
    return `${code}-${yy}-${seq}`;
  }

  const m2 = s.match(/^([A-Z0-9ÄÖÜ]+)\s*-\s*(\d{2})\s*-\s*(\d{1,5})$/i);
  if (m2) {
    const code = m2[1].toUpperCase();
    const yy = m2[2];
    const seq = String(m2[3]).padStart(4, "0");
    return `${code}-${yy}-${seq}`;
  }

  return s.toUpperCase();
}

function splitChildName(fullName) {
  const raw = safeText(fullName);
  if (!raw) return { firstName: "", lastName: "" };

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function shapeCustomer(customer = {}, booking = {}) {
  const invParent = booking?.invoiceTo?.parent || {};
  const invAddr = booking?.invoiceTo?.address || {};

  const parent = customer.parent || {};
  const child = customer.child || {};
  const addr = customer.address || {};

  const childFromName = splitChildName(booking?.childName);

  const childFirstName =
    safeText(booking?.childFirstName) || safeText(childFromName.firstName);

  const childLastName =
    safeText(booking?.childLastName) || safeText(childFromName.lastName);

  return {
    userId: String(customer.userId ?? customer._id ?? ""),

    parent: {
      salutation: invParent.salutation || parent.salutation || "",
      firstName:
        invParent.firstName || parent.firstName || booking.firstName || "",
      lastName: invParent.lastName || parent.lastName || booking.lastName || "",
      email: invParent.email || parent.email || booking.email || "",
    },
    child: {
      firstName: childFirstName,
      lastName: childLastName,
    },
    address: {
      street: invAddr.street || addr.street || "",
      houseNo: invAddr.houseNo || addr.houseNo || "",
      zip: invAddr.zip || addr.zip || "",
      city: invAddr.city || addr.city || "",
    },
  };
}

function shapeBooking(booking = {}, offer = {}) {
  const o = offer && typeof offer === "object" ? offer : {};

  const monthlyAmount =
    booking.monthlyAmount != null &&
    Number.isFinite(Number(booking.monthlyAmount))
      ? Number(booking.monthlyAmount)
      : booking.priceMonthly != null &&
          Number.isFinite(Number(booking.priceMonthly))
        ? Number(booking.priceMonthly)
        : undefined;

  const firstMonthAmount =
    booking.firstMonthAmount != null &&
    Number.isFinite(Number(booking.firstMonthAmount))
      ? Number(booking.firstMonthAmount)
      : booking.priceFirstMonth != null &&
          Number.isFinite(Number(booking.priceFirstMonth))
        ? Number(booking.priceFirstMonth)
        : undefined;

  const invoiceNoRaw = booking.invoiceNo || booking.invoiceNumber || "";
  const invoiceDateISO = toISODate(booking.invoiceDate || "");

  const refInvoiceNoRaw = booking.refInvoiceNo || invoiceNoRaw || "";
  const refInvoiceDateISO = toISODate(
    booking.refInvoiceDate || invoiceDateISO || "",
  );

  const bookingOfferTitle =
    booking.offerTitle ||
    booking.offerType ||
    booking.offer ||
    booking.offerSnapshotTitle ||
    "";

  const bookingOfferType = booking.offerType || booking.offerSnapshotType || "";

  const offerTitleFromOffer = o.title || o.sub_type || o.type || "";
  const offerTypeFromOffer = o.sub_type || o.type || "";

  const venue = booking.venue || booking.offerLocation || o.location || "";

  return {
    _id: booking._id || "",

    offerTitle: bookingOfferTitle || offerTitleFromOffer || "",
    offerType: bookingOfferType || offerTypeFromOffer || "",
    venue,

    date: toISODate(booking.date),
    status: booking.status || "",
    cancelDate: toISODate(
      booking.cancelDate ||
        booking.cancellationDate ||
        booking.canceledAt ||
        "",
    ),
    cancelReason: booking.cancelReason || booking.cancellationReason || "",
    endDate: toISODate(booking.endDate || ""),

    level: booking.level || "",
    confirmationCode: booking.confirmationCode || "",

    monthlyAmount,
    firstMonthAmount,

    priceAtBooking: booking.priceAtBooking,
    currency: booking.currency || "EUR",

    invoiceNo: normalizeInvoiceNo(invoiceNoRaw),
    invoiceDate: invoiceDateISO,

    cancellationNo: booking.cancellationNo || booking.cancellationNumber || "",
    refInvoiceNo: normalizeInvoiceNo(refInvoiceNoRaw),
    refInvoiceDate: refInvoiceDateISO,

    stornoNo: booking.stornoNo || booking.stornoNumber || "",

    firstName: booking.firstName || "",
    lastName: booking.lastName || "",
    childName: booking.childName || "",
    childFirstName: booking.childFirstName || "",
    childLastName: booking.childLastName || "",
    child: booking.child || "",
  };
}

function shapeStornoData({
  customer,
  booking,
  offer,
  amount,
  currency = "EUR",
}) {
  let amt;
  if (
    amount === undefined ||
    amount === null ||
    (typeof amount === "string" && amount.trim() === "")
  ) {
    amt = undefined;
  } else {
    const n = Number(amount);
    amt = Number.isFinite(n) ? n : undefined;
  }

  return {
    customer: shapeCustomer(customer, booking),
    booking: shapeBooking(booking, offer),
    amount: amt,
    currency,
  };
}

function shapeCancellationData({
  customer,
  booking,
  offer,
  date,
  endDate,
  reason,
}) {
  const shapedBooking = shapeBooking(booking, offer);

  const requestISO =
    toISODate(booking?.requestDate) ||
    toISODate(booking?.cancelRequestDate) ||
    toISODate(date) ||
    shapedBooking.cancelDate;

  let endISO =
    toISODate(endDate) ||
    toISODate(booking?.endDate) ||
    toISODate(booking?.cancelEndDate) ||
    toISODate(booking?.cancellationEndDate) ||
    "";

  if (!endISO) {
    const baseISO = requestISO || shapedBooking.cancelDate || "";
    if (baseISO) {
      const d = new Date(`${baseISO}T00:00:00`);
      if (!Number.isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = d.getMonth();
        const day = d.getDate();

        const targetY = m === 11 ? y + 1 : y;
        const targetM = (m + 1) % 12;

        const lastDayTargetMonth = new Date(targetY, targetM + 1, 0).getDate();
        const targetDay = Math.min(day, lastDayTargetMonth);

        const end = new Date(targetY, targetM, targetDay);
        endISO = toISODate(end);
      }
    }
  }

  return {
    customer: shapeCustomer(customer, booking),
    booking: shapedBooking,
    details: {
      requestDate: requestISO,
      cancelDate: toISODate(date) || shapedBooking.cancelDate,
      endDate: endISO,
      reason: reason || shapedBooking.cancelReason || "",
    },
  };
}

function shapeParticipationData({ customer, booking, offer }) {
  const shapedCustomer = shapeCustomer(customer, booking);
  const shapedBooking = shapeBooking(booking, offer);

  const rawOffer =
    booking?.offer != null && String(booking.offer).trim() !== ""
      ? String(booking.offer)
      : "";

  const cleanOffer = sanitizeCourseTitle(
    rawOffer ||
      shapedBooking.offerTitle ||
      shapedBooking.offerType ||
      offer?.title ||
      "",
  );

  const dayTimes =
    booking?.dayTimes || booking?.kurstag || booking?.weekday || "";

  const timeDisplay =
    booking?.timeDisplay ||
    booking?.kurszeit ||
    booking?.time ||
    booking?.uhrzeit ||
    "";

  // const meta = booking && booking.meta ? booking.meta : {};

  // const siblingDiscount =
  //   meta && meta.siblingDiscount != null
  //     ? Number(meta.siblingDiscount) || 0
  //     : 0;

  // const memberDiscount =
  //   meta && meta.memberDiscount != null ? Number(meta.memberDiscount) || 0 : 0;

  // const metaTotal =
  //   meta && meta.totalDiscount != null ? Number(meta.totalDiscount) || 0 : 0;

  // const totalDiscount = metaTotal || siblingDiscount + memberDiscount;

  // const finalPrice =
  //   booking?.priceAtBooking != null &&
  //   Number.isFinite(Number(booking.priceAtBooking))
  //     ? Number(booking.priceAtBooking)
  //     : null;

  // const basePrice =
  //   meta.basePrice != null && Number.isFinite(Number(meta.basePrice))
  //     ? Number(meta.basePrice)
  //     : finalPrice != null
  //       ? finalPrice + Number(totalDiscount || 0)
  //       : null;

  // const discount = {
  //   basePrice,
  //   siblingDiscount,
  //   memberDiscount,
  //   totalDiscount,
  //   finalPrice,
  // };

  const meta = booking && booking.meta ? booking.meta : {};

  const basePrice = toNum(meta.basePrice);
  const grossPrice = toNum(meta.grossPrice);

  const mainGoalkeeperSurcharge = toNum(meta.mainGoalkeeperSurcharge) || 0;
  const siblingGoalkeeperSurcharge =
    toNum(meta.siblingGoalkeeperSurcharge) || 0;
  const goalkeeperTotal =
    toNum(meta.goalkeeperTotal) ??
    mainGoalkeeperSurcharge + siblingGoalkeeperSurcharge;

  const siblingDiscount = toNum(meta.siblingDiscount) || 0;
  const mainMemberDiscount = toNum(meta.mainMemberDiscount) || 0;
  const siblingMemberDiscount = toNum(meta.siblingMemberDiscount) || 0;
  const memberDiscount =
    toNum(meta.memberDiscount) ?? mainMemberDiscount + siblingMemberDiscount;

  const voucherDiscount = toNum(meta.voucherDiscount) || 0;

  const totalDiscount =
    toNum(meta.totalDiscount) ??
    siblingDiscount + memberDiscount + voucherDiscount;

  const finalPrice =
    booking?.priceAtBooking != null &&
    Number.isFinite(Number(booking.priceAtBooking))
      ? Number(booking.priceAtBooking)
      : grossPrice != null
        ? grossPrice - totalDiscount
        : null;

  const discount = {
    basePrice,
    grossPrice,
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
    finalPrice,
  };

  return {
    customer: shapedCustomer,
    booking: {
      ...shapedBooking,

      offer:
        rawOffer || shapedBooking.offerTitle || shapedBooking.offerType || "",

      offerClean: cleanOffer,

      dayTimes,
      timeDisplay,
      discount,
    },
  };
}

function shapeDunningData({
  customer,
  booking,
  stage,
  issuedAt,
  dueAt,
  feeSnapshot,
  freeText,
} = {}) {
  const shapedCustomer = shapeCustomer(customer, booking);
  const shapedBooking = shapeBooking(booking, {});

  const fees = feeSnapshot || {};
  const baseAmount =
    booking?.status === "storno" && booking?.stornoAmount != null
      ? Number(booking.stornoAmount) || 0
      : Number(booking?.priceAtBooking || 0) || 0;

  const returnBankFee = Number(fees.returnBankFee || 0) || 0;
  const dunningFee = Number(fees.dunningFee || 0) || 0;
  const processingFee = Number(fees.processingFee || 0) || 0;

  const computedExtraFees = returnBankFee + dunningFee + processingFee;
  const totalExtraFees =
    fees.totalExtraFees != null
      ? Number(fees.totalExtraFees) || 0
      : computedExtraFees;

  const totalDue = baseAmount + totalExtraFees;

  return {
    customer: shapedCustomer,
    booking: shapedBooking,
    dunning: {
      stage: String(stage || "reminder"),
      issuedAt: toISODate(issuedAt || new Date()),
      dueAt: toISODate(dueAt || ""),
      freeText: String(freeText || "").trim(),
    },
    amounts: {
      baseAmount,
      returnBankFee,
      dunningFee,
      processingFee,
      totalExtraFees,
      totalDue,
      currency: String(fees.currency || booking?.currency || "EUR"),
    },
  };
}

function shapeWeeklyContractData({ booking, offer } = {}) {
  const b = booking || {};
  const o = offer || {};

  const meta = b.meta && typeof b.meta === "object" ? b.meta : {};
  const snap =
    meta.contractSnapshot && typeof meta.contractSnapshot === "object"
      ? meta.contractSnapshot
      : {};

  const parent =
    snap.parent && typeof snap.parent === "object" ? snap.parent : {};
  const address =
    snap.address && typeof snap.address === "object" ? snap.address : {};
  const child = snap.child && typeof snap.child === "object" ? snap.child : {};
  const consents =
    snap.consents && typeof snap.consents === "object" ? snap.consents : {};

  const offerTitle =
    b.offerTitle ||
    b.offerType ||
    o.title ||
    o.sub_type ||
    o.type ||
    "Fördertraining";

  const venue = b.venue || o.location || "";
  const startDate = toISODate(b.date) || toISODate(snap.startDate) || "";

  const dayTimes =
    b.dayTimes ||
    b.kurstag ||
    b.weekday ||
    snap.dayTimes ||
    (Array.isArray(o.days) && o.days[0] ? String(o.days[0]) : "");

  const timeFrom = String(o.timeFrom || snap.timeFrom || "").trim();
  const timeTo = String(o.timeTo || snap.timeTo || "").trim();
  const timeDisplay =
    b.timeDisplay ||
    b.kurszeit ||
    b.time ||
    b.uhrzeit ||
    snap.timeDisplay ||
    (timeFrom || timeTo ? [timeFrom, timeTo].filter(Boolean).join(" – ") : "");

  const monthlyPrice =
    typeof b.priceMonthly === "number"
      ? b.priceMonthly
      : typeof o.price === "number"
        ? o.price
        : undefined;

  const firstMonthPrice =
    typeof b.priceFirstMonth === "number" ? b.priceFirstMonth : undefined;

  const signedAt = safeText(meta.contractSignedAt || snap.signedAt || "");
  const signedName = safeText(snap.signatureName || snap.signedName || "");
  const signedCity = safeText(snap.signedCity || "");
  const signedDate = safeText(snap.signedDate || "");

  const docSnap =
    snap.contractDoc && typeof snap.contractDoc === "object"
      ? snap.contractDoc
      : {};

  return {
    bookingId: safeText(b._id),
    providerId: safeText(b.owner),
    offerId: safeText(b.offerId || o._id),

    program: sanitizeCourseTitle(offerTitle),
    venue: safeText(venue),

    schedule: {
      startDate,
      dayTimes: safeText(dayTimes),
      timeDisplay: safeText(timeDisplay),
    },

    pricing: {
      currency: safeText(b.currency || "EUR") || "EUR",
      monthly: monthlyPrice != null ? Number(monthlyPrice) : null,
      firstMonth: firstMonthPrice != null ? Number(firstMonthPrice) : null,
    },

    parent: {
      salutation: safeText(parent.salutation),
      firstName: safeText(parent.firstName),
      lastName: safeText(parent.lastName),
      email: safeText(parent.email || b.email),
      phone: safeText(parent.phone),
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
      gender: safeText(child.gender),
    },

    consents: {
      termsAccepted: consents.acceptAgb === true,
      privacyAccepted: consents.acceptPrivacy === true,
      photoVideo: consents.consentPhotoVideo === true,
    },

    signature: {
      name: signedName,
      city: signedCity,
      date: signedDate,
      signedAt,
      ip: safeText(meta.contractSignedIp || snap.signedIp || ""),
      ua: safeText(meta.contractSignedUa || snap.signedUa || ""),
    },
    doc: {
      version: safeText(docSnap.version || ""),
      contentHtml: safeText(docSnap.contentHtml || ""),
    },
  };
}

module.exports = {
  toISODate,
  sanitizeCourseTitle,
  normalizeInvoiceNo,
  shapeCustomer,
  shapeBooking,
  shapeStornoData,
  shapeCancellationData,
  shapeParticipationData,
  shapeDunningData,
  shapeWeeklyContractData,
};
