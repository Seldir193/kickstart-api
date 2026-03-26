"use strict";

function dunningStageLabel(stage) {
  if (stage === "reminder") return "Zahlungserinnerung";
  if (stage === "dunning1") return "1. Mahnung";
  if (stage === "dunning2") return "2. Mahnung";
  if (stage === "final") return "Letzte Mahnung";
  return "Mahnung";
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bookingBaseAmount(booking) {
  if (booking?.priceAtBooking != null)
    return toNumber(booking.priceAtBooking, 0);
  if (booking?.priceMonthly != null) return toNumber(booking.priceMonthly, 0);
  if (booking?.price != null) return toNumber(booking.price, 0);
  return 0;
}

function safeText(v) {
  return String(v ?? "").trim();
}

function refIdOf(b) {
  return safeText(b?.bookingId || b?._id);
}

function childMatches(b, childUid, childFirst, childLast) {
  const cu = safeText(childUid).toLowerCase();
  if (cu) return safeText(b?.childUid).toLowerCase() === cu;

  if (!childFirst && !childLast) return true;
  const bf = safeText(b?.childFirstName).toLowerCase();
  const bl = safeText(b?.childLastName).toLowerCase();
  const cf = safeText(childFirst).toLowerCase();
  const cl = safeText(childLast).toLowerCase();
  if (cf && bf !== cf) return false;
  if (cl && bl !== cl) return false;
  return true;
}

function hasContractMeta(b) {
  const meta = b && typeof b.meta === "object" ? b.meta : {};
  const signedAt = safeText(meta.contractSignedAt);
  const html = safeText(meta?.contractSnapshot?.contractDoc?.contentHtml);
  return Boolean(signedAt && html);
}

function contractSignedAt(b) {
  const meta = b && typeof b.meta === "object" ? b.meta : {};
  return meta.contractSignedAt || null;
}

function bookingDocHref(bid, type) {
  return `/api/admin/bookings/${encodeURIComponent(bid)}/documents/${encodeURIComponent(
    type,
  )}`;
}

function buildInvoiceDoc(bid, baseTitle, common, booking) {
  const invoiceNo = safeText(booking.invoiceNumber || booking.invoiceNo);
  if (!invoiceNo) return null;

  return {
    id: `${bid}:invoice`,
    type: "invoice",
    title: `Rechnung – ${baseTitle}`,
    issuedAt: booking.invoiceDate || booking.date || booking.createdAt,
    href: bookingDocHref(bid, "participation"),
    amount: common.originalInvoiceAmount || 0,
    invoiceNo,
    ...common,
  };
}

function buildParticipationDoc(bid, baseTitle, common, booking) {
  const invoiceNo = safeText(booking.invoiceNumber || booking.invoiceNo);
  if (!invoiceNo) return null;

  return {
    id: `${bid}:participation`,
    type: "participation",
    title: `Teilnahmebestätigung – ${baseTitle}`,
    issuedAt: booking.invoiceDate || booking.date || booking.createdAt,
    href: bookingDocHref(bid, "participation"),
    amount: common.originalInvoiceAmount || 0,
    invoiceNo,
    ...common,
  };
}

function build_booking_docs(customer, opts) {
  const docs = [];
  const cid = String(customer?._id || "");
  const childUid = opts ? opts.childUid : "";
  const childFirst = opts ? opts.childFirst : "";
  const childLast = opts ? opts.childLast : "";

  for (const b of customer?.bookings || []) {
    const bid = refIdOf(b);
    if (!bid) continue;
    if (!childMatches(b, childUid, childFirst, childLast)) continue;

    const baseTitle = `${b.offerTitle || b.offerType || "Angebot"}`;
    const kndNo = String(b.cancellationNo || b.cancellationNumber || "").trim();
    const stoNo = String(b.stornoNo || b.stornoNumber || "").trim();

    const common = {
      bookingId: bid,
      customerId: cid,
      offerTitle: b.offerTitle,
      offerType: b.offerType,
      status: b.status || "open",
      currency: b.currency || "EUR",
      invoiceDate: b.invoiceDate || null,
      cancellationNo: kndNo,
      stornoNo: stoNo,
      originalInvoiceAmount: bookingBaseAmount(b),
      returnBankFee: toNumber(b.returnBankFee, 0),
      dunningFee: 0,
      processingFee: 0,
      totalExtraFees: 0,
      childUid: safeText(b.childUid),
      childFirstName: safeText(b.childFirstName),
      childLastName: safeText(b.childLastName),
    };

    if (hasContractMeta(b)) {
      docs.push({
        id: `${bid}:contract`,
        type: "contract",
        title: `Vertrag – ${baseTitle}`,
        issuedAt: contractSignedAt(b) || b.updatedAt || b.createdAt,
        href: bookingDocHref(bid, "contract"),
        amount: 0,
        invoiceNo: "",
        ...common,
      });
    }

    const invoiceDoc = buildInvoiceDoc(bid, baseTitle, common, b);
    if (invoiceDoc) docs.push(invoiceDoc);

    const participationDoc = buildParticipationDoc(bid, baseTitle, common, b);
    if (participationDoc) docs.push(participationDoc);

    if (kndNo) {
      const issued = b.cancelDate || b.updatedAt || b.createdAt;

      docs.push({
        id: `${bid}:cancellation`,
        type: "cancellation",
        title: `Kündigungsbestätigung – ${baseTitle}`,
        issuedAt: issued,
        href: bookingDocHref(bid, "cancellation"),
        amount: 0,
        invoiceNo: kndNo,
        ...common,
      });
    }

    if (stoNo) {
      const issued = b.stornoDate || b.updatedAt || b.createdAt;

      docs.push({
        id: `${bid}:storno`,
        type: "storno",
        title: `Storno-Rechnung – ${baseTitle}`,
        issuedAt: issued,
        href: bookingDocHref(bid, "storno"),
        amount:
          b?.stornoAmount != null
            ? toNumber(b.stornoAmount, 0)
            : common.originalInvoiceAmount,
        stornoAmount:
          b?.stornoAmount != null
            ? toNumber(b.stornoAmount, 0)
            : common.originalInvoiceAmount,
        invoiceNo: stoNo,
        ...common,
      });
    }
  }

  return docs;
}

function build_dunning_docs(customer, billingDocs) {
  const docs = [];
  const cid = String(customer?._id || "");
  const bookings = Array.isArray(customer?.bookings) ? customer.bookings : [];

  const bookingById = new Map(
    bookings.map((b) => [refIdOf(b), b]).filter(([k]) => Boolean(k)),
  );

  const bookingIdSet = new Set([...bookingById.keys()].filter(Boolean));

  for (const doc of billingDocs || []) {
    const did = String(doc?._id || "");
    const bid = String(doc?.bookingId || "");
    if (!did || !bid || !bookingIdSet.has(bid)) continue;

    const booking = bookingById.get(bid) || {};
    const fee = doc?.feesSnapshot || {};
    const originalInvoiceAmount = bookingBaseAmount(booking);
    const returnBankFee = toNumber(
      fee.returnBankFee,
      toNumber(booking.returnBankFee, 0),
    );
    const dunningFee = toNumber(fee.dunningFee, 0);
    const processingFee = toNumber(fee.processingFee, 0);
    const totalExtraFees = toNumber(
      fee.totalExtraFees,
      returnBankFee + dunningFee + processingFee,
    );

    docs.push({
      id: `dunning:${did}`,
      bookingId: bid,
      customerId: cid,
      type: "dunning",
      stage: doc.stage || "",
      title: `${dunningStageLabel(doc.stage)}${
        doc.invoiceNo ? ` – ${doc.invoiceNo}` : ""
      }`,
      issuedAt: doc.sentAt || doc.createdAt || null,
      status: "open",
      offerTitle: booking.offerTitle || doc.offerTitle || "",
      offerType: "dunning",
      subject: doc.subject || "",
      href: `/api/admin/invoices/dunning-documents/${encodeURIComponent(
        did,
      )}/download`,
      invoiceNo: doc.invoiceNo || "",
      invoiceDate: doc.sentAt || doc.createdAt || null,
      cancellationNo: "",
      stornoNo: "",
      stornoAmount: "",
      currency: fee.currency || booking.currency || "EUR",
      fileName: doc.fileName || "",
      filePath: doc.filePath || "",
      amount: totalExtraFees,
      originalInvoiceAmount,
      returnBankFee,
      dunningFee,
      processingFee,
      totalExtraFees,
      dunningTotalAmount: originalInvoiceAmount + totalExtraFees,
      dueAt: doc.dueAt || null,
      childUid: safeText(booking.childUid),
      childFirstName: safeText(booking.childFirstName),
      childLastName: safeText(booking.childLastName),
    });
  }

  return docs;
}

module.exports = {
  buildCustomerDocs: build_booking_docs,
  buildCustomerDunningDocs: build_dunning_docs,
  dunningStageLabel,
};

// // routes/customers/helpers/documents/buildCustomerDocs.js
// "use strict";

// function dunningStageLabel(stage) {
//   if (stage === "reminder") return "Zahlungserinnerung";
//   if (stage === "dunning1") return "1. Mahnung";
//   if (stage === "dunning2") return "2. Mahnung";
//   if (stage === "final") return "Letzte Mahnung";
//   return "Mahnung";
// }

// function toNumber(value, fallback = 0) {
//   const n = Number(value);
//   return Number.isFinite(n) ? n : fallback;
// }

// function bookingBaseAmount(booking) {
//   if (booking?.priceAtBooking != null)
//     return toNumber(booking.priceAtBooking, 0);
//   if (booking?.priceMonthly != null) return toNumber(booking.priceMonthly, 0);
//   if (booking?.price != null) return toNumber(booking.price, 0);
//   return 0;
// }

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function refIdOf(b) {
//   return safeText(b?.bookingId || b?._id);
// }

// function childMatches(b, childUid, childFirst, childLast) {
//   const cu = safeText(childUid).toLowerCase();
//   if (cu) return safeText(b?.childUid).toLowerCase() === cu;

//   if (!childFirst && !childLast) return true;
//   const bf = safeText(b?.childFirstName).toLowerCase();
//   const bl = safeText(b?.childLastName).toLowerCase();
//   const cf = safeText(childFirst).toLowerCase();
//   const cl = safeText(childLast).toLowerCase();
//   if (cf && bf !== cf) return false;
//   if (cl && bl !== cl) return false;
//   return true;
// }

// function hasContractMeta(b) {
//   const meta = b && typeof b.meta === "object" ? b.meta : {};
//   const signedAt = safeText(meta.contractSignedAt);
//   const html = safeText(meta?.contractSnapshot?.contractDoc?.contentHtml);
//   return Boolean(signedAt && html);
// }

// function contractSignedAt(b) {
//   const meta = b && typeof b.meta === "object" ? b.meta : {};
//   return meta.contractSignedAt || null;
// }

// function bookingDocHref(bid, type) {
//   return `/api/admin/bookings/${encodeURIComponent(bid)}/documents/${encodeURIComponent(
//     type,
//   )}`;
// }

// function build_booking_docs(customer, opts) {
//   const docs = [];
//   const cid = String(customer?._id || "");
//   const childUid = opts ? opts.childUid : "";
//   const childFirst = opts ? opts.childFirst : "";
//   const childLast = opts ? opts.childLast : "";

//   for (const b of customer?.bookings || []) {
//     const bid = refIdOf(b);
//     if (!bid) continue;
//     if (!childMatches(b, childUid, childFirst, childLast)) continue;

//     const baseTitle = `${b.offerTitle || b.offerType || "Angebot"}`;

//     const foNo = String(b.invoiceNumber || b.invoiceNo || "").trim();
//     const kndNo = String(b.cancellationNo || b.cancellationNumber || "").trim();
//     const stoNo = String(b.stornoNo || b.stornoNumber || "").trim();

//     const common = {
//       bookingId: bid,
//       customerId: cid,
//       offerTitle: b.offerTitle,
//       offerType: b.offerType,
//       status: b.status || "open",
//       currency: b.currency || "EUR",
//       invoiceDate: b.invoiceDate || null,
//       cancellationNo: kndNo,
//       stornoNo: stoNo,
//       originalInvoiceAmount: bookingBaseAmount(b),
//       returnBankFee: toNumber(b.returnBankFee, 0),
//       dunningFee: 0,
//       processingFee: 0,
//       totalExtraFees: 0,
//       childUid: safeText(b.childUid),
//       childFirstName: safeText(b.childFirstName),
//       childLastName: safeText(b.childLastName),
//     };

//     if (hasContractMeta(b)) {
//       docs.push({
//         id: `${bid}:contract`,
//         type: "contract",
//         title: `Vertrag – ${baseTitle}`,
//         issuedAt: contractSignedAt(b) || b.updatedAt || b.createdAt,
//         href: bookingDocHref(bid, "contract"),
//         amount: 0,
//         invoiceNo: "",
//         ...common,
//       });
//     }

//     if (foNo) {
//       docs.push({
//         id: `${bid}:participation`,
//         type: "participation",
//         title: `Teilnahmebestätigung – ${baseTitle}`,
//         issuedAt: b.invoiceDate || b.date || b.createdAt,
//         href: bookingDocHref(bid, "participation"),
//         amount: common.originalInvoiceAmount || 0,
//         invoiceNo: foNo,
//         ...common,
//       });
//     }

//     if (kndNo) {
//       const issued = b.cancelDate || b.updatedAt || b.createdAt;

//       docs.push({
//         id: `${bid}:cancellation`,
//         type: "cancellation",
//         title: `Kündigungsbestätigung – ${baseTitle}`,
//         issuedAt: issued,
//         href: bookingDocHref(bid, "cancellation"),
//         amount: 0,
//         invoiceNo: kndNo,
//         ...common,
//       });
//     }

//     if (stoNo) {
//       const issued = b.stornoDate || b.updatedAt || b.createdAt;

//       docs.push({
//         id: `${bid}:storno`,
//         type: "storno",
//         title: `Storno-Rechnung – ${baseTitle}`,
//         issuedAt: issued,
//         href: bookingDocHref(bid, "storno"),
//         amount:
//           b?.stornoAmount != null
//             ? toNumber(b.stornoAmount, 0)
//             : common.originalInvoiceAmount,
//         stornoAmount:
//           b?.stornoAmount != null
//             ? toNumber(b.stornoAmount, 0)
//             : common.originalInvoiceAmount,
//         invoiceNo: stoNo,
//         ...common,
//       });
//     }
//   }

//   return docs;
// }

// function build_dunning_docs(customer, billingDocs) {
//   const docs = [];
//   const cid = String(customer?._id || "");
//   const bookings = Array.isArray(customer?.bookings) ? customer.bookings : [];

//   const bookingById = new Map(
//     bookings.map((b) => [refIdOf(b), b]).filter(([k]) => Boolean(k)),
//   );

//   const bookingIdSet = new Set([...bookingById.keys()].filter(Boolean));

//   for (const doc of billingDocs || []) {
//     const did = String(doc?._id || "");
//     const bid = String(doc?.bookingId || "");
//     if (!did || !bid || !bookingIdSet.has(bid)) continue;

//     const booking = bookingById.get(bid) || {};
//     const fee = doc?.feesSnapshot || {};
//     const originalInvoiceAmount = bookingBaseAmount(booking);
//     const returnBankFee = toNumber(
//       fee.returnBankFee,
//       toNumber(booking.returnBankFee, 0),
//     );
//     const dunningFee = toNumber(fee.dunningFee, 0);
//     const processingFee = toNumber(fee.processingFee, 0);
//     const totalExtraFees = toNumber(
//       fee.totalExtraFees,
//       returnBankFee + dunningFee + processingFee,
//     );

//     docs.push({
//       id: `dunning:${did}`,
//       bookingId: bid,
//       customerId: cid,
//       type: "dunning",
//       stage: doc.stage || "",
//       title: `${dunningStageLabel(doc.stage)}${
//         doc.invoiceNo ? ` – ${doc.invoiceNo}` : ""
//       }`,
//       issuedAt: doc.sentAt || doc.createdAt || null,
//       status: "open",
//       offerTitle: booking.offerTitle || doc.offerTitle || "",
//       offerType: "dunning",
//       subject: doc.subject || "",
//       href: `/api/admin/invoices/dunning-documents/${encodeURIComponent(
//         did,
//       )}/download`,
//       invoiceNo: doc.invoiceNo || "",
//       invoiceDate: doc.sentAt || doc.createdAt || null,
//       cancellationNo: "",
//       stornoNo: "",
//       stornoAmount: "",
//       currency: fee.currency || booking.currency || "EUR",
//       fileName: doc.fileName || "",
//       filePath: doc.filePath || "",
//       amount: totalExtraFees,
//       originalInvoiceAmount,
//       returnBankFee,
//       dunningFee,
//       processingFee,
//       totalExtraFees,
//       dunningTotalAmount: originalInvoiceAmount + totalExtraFees,
//       dueAt: doc.dueAt || null,
//       childUid: safeText(booking.childUid),
//       childFirstName: safeText(booking.childFirstName),
//       childLastName: safeText(booking.childLastName),
//     });
//   }

//   return docs;
// }

// module.exports = {
//   buildCustomerDocs: build_booking_docs,
//   buildCustomerDunningDocs: build_dunning_docs,
//   dunningStageLabel,
// };
