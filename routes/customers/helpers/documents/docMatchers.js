// //routes\customers\helpers\documents\docMatchers.js

"use strict";

function toNorm(s = "") {
  return String(s)
    .replace(/[Ää]/g, "ae")
    .replace(/[Öö]/g, "oe")
    .replace(/[Üü]/g, "ue")
    .replace(/ß/g, "ss")
    .toLowerCase();
}

function docNoFrom(doc) {
  return String(
    doc?.creditNoteNo ||
      doc?.invoiceNo ||
      doc?.invoiceNumber ||
      doc?.cancellationNo ||
      doc?.stornoNo ||
      doc?.stornoNumber ||
      "",
  ).trim();
}

function docMatchesType(doc, typeSet) {
  if (!typeSet || !typeSet.size) return true;
  return typeSet.has(String(doc?.type || "").toLowerCase());
}

function docMatchesQuery(doc, q) {
  if (!q) return true;

  const needle = toNorm(q);
  const hay = toNorm(
    [
      doc?.title,
      doc?.type,
      doc?.offerTitle,
      doc?.offerType,
      doc?.subject,
      doc?.stage,
      doc?.fileName,
      doc?.customerNumber,
      docNoFrom(doc),
      doc?.bookingId,
    ]
      .filter(Boolean)
      .join(" "),
  );

  return hay.includes(needle);
}

function parseDate(d) {
  if (!d) return null;
  const t = new Date(d);
  return isNaN(t.getTime()) ? null : t;
}

module.exports = {
  toNorm,
  docNoFrom,
  docMatchesType,
  docMatchesQuery,
  parseDate,
};

// ("use strict");

// function toNorm(s = "") {
//   return String(s)
//     .replace(/[Ää]/g, "ae")
//     .replace(/[Öö]/g, "oe")
//     .replace(/[Üü]/g, "ue")
//     .replace(/ß/g, "ss")
//     .toLowerCase();
// }

// function docMatchesType(doc, typeSet) {
//   if (!typeSet || !typeSet.size) return true;
//   return typeSet.has(doc.type);
// }

// function docMatchesQuery(doc, q) {
//   if (!q) return true;
//   const n = toNorm(q);
//   const hay = toNorm(
//     [doc.title, doc.type, doc.offerTitle, doc.offerType]
//       .filter(Boolean)
//       .join(" "),
//   );
//   return hay.includes(n);
// }

// function parseDate(d) {
//   if (!d) return null;
//   const t = new Date(d);
//   return isNaN(t.getTime()) ? null : t;
// }

// module.exports = { toNorm, docMatchesType, docMatchesQuery, parseDate };
