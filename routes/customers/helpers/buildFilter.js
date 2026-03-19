// routes/customers/helpers/buildFilter.js
"use strict";

function parseNewsletterParam(newsletter) {
  if (newsletter === "true") return true;
  if (newsletter === "false") return false;
  return null;
}

function leadOr() {
  return [
    { newsletter: true },
    { marketingStatus: "pending" },
    { confirmToken: { $exists: true } },
  ];
}

// function buildSearchOr(needle) {
//   return [
//     { "child.firstName": { $regex: needle, $options: "i" } },
//     { "child.lastName": { $regex: needle, $options: "i" } },
//     { "parent.firstName": { $regex: needle, $options: "i" } },
//     { "parent.lastName": { $regex: needle, $options: "i" } },
//     { "parent.email": { $regex: needle, $options: "i" } },
//     { "parent.phone": { $regex: needle, $options: "i" } },
//     { "child.club": { $regex: needle, $options: "i" } },
//     { "address.city": { $regex: needle, $options: "i" } },
//     { "address.street": { $regex: needle, $options: "i" } },
//     { notes: { $regex: needle, $options: "i" } },
//     { userId: isFinite(+needle) ? +needle : -1 },
//   ];
// }

function buildSearchOr(needle) {
  return [
    { "child.firstName": { $regex: needle, $options: "i" } },
    { "child.lastName": { $regex: needle, $options: "i" } },
    { "child.club": { $regex: needle, $options: "i" } },

    { "children.firstName": { $regex: needle, $options: "i" } },
    { "children.lastName": { $regex: needle, $options: "i" } },
    { "children.club": { $regex: needle, $options: "i" } },

    { "parent.firstName": { $regex: needle, $options: "i" } },
    { "parent.lastName": { $regex: needle, $options: "i" } },
    { "parent.email": { $regex: needle, $options: "i" } },
    { "parent.phone": { $regex: needle, $options: "i" } },
    { "parent.phone2": { $regex: needle, $options: "i" } },

    { "parents.firstName": { $regex: needle, $options: "i" } },
    { "parents.lastName": { $regex: needle, $options: "i" } },
    { "parents.email": { $regex: needle, $options: "i" } },
    { "parents.phone": { $regex: needle, $options: "i" } },
    { "parents.phone2": { $regex: needle, $options: "i" } },

    { "address.city": { $regex: needle, $options: "i" } },
    { "address.street": { $regex: needle, $options: "i" } },
    { notes: { $regex: needle, $options: "i" } },
    { userId: isFinite(+needle) ? +needle : -1 },
  ];
}

function buildFilter(query, owner) {
  const { q, newsletter, tab } = query || {};
  const filter = owner ? { owner } : {};
  const t = String(tab || "").toLowerCase();

  const n = parseNewsletterParam(newsletter);

  const and = [];

  if (t === "newsletter") {
    and.push({ "bookings.0": { $exists: false } });

    if (n !== null) {
      and.push({ newsletter: n });
    } else {
      and.push({ $or: leadOr() });
    }
  } else if (t === "customers") {
    and.push({ "bookings.0": { $exists: true } });
    if (n !== null) and.push({ newsletter: n });
  } else {
    if (n !== null) and.push({ newsletter: n });
  }

  if (q && String(q).trim().length) {
    const needle = String(q).trim();
    and.push({ $or: buildSearchOr(needle) });
  }

  if (and.length === 1) return { ...filter, ...and[0] };
  if (and.length > 1) return { ...filter, $and: and };
  return filter;
}

module.exports = { buildFilter };

// //routes\customers\helpers\buildFilter.js
// "use strict";

// function buildFilter(query, owner) {
//   const { q, newsletter, tab } = query || {};
//   const filter = { owner };
//   const t = String(tab || "").toLowerCase();

//   const n =
//     newsletter === "true" ? true : newsletter === "false" ? false : null;

//   if (t === "newsletter") {
//     filter["bookings.0"] = { $exists: false };
//     filter.newsletter = n === null ? true : n;
//   } else if (t === "customers") {
//     filter["bookings.0"] = { $exists: true };
//     if (n !== null) filter.newsletter = n;
//   } else {
//     if (n !== null) filter.newsletter = n;
//   }

//   if (q && String(q).trim().length) {
//     const needle = String(q).trim();
//     filter.$or = [
//       { "child.firstName": { $regex: needle, $options: "i" } },
//       { "child.lastName": { $regex: needle, $options: "i" } },
//       { "parent.firstName": { $regex: needle, $options: "i" } },
//       { "parent.lastName": { $regex: needle, $options: "i" } },
//       { "parent.email": { $regex: needle, $options: "i" } },
//       { "parent.phone": { $regex: needle, $options: "i" } },
//       { "child.club": { $regex: needle, $options: "i" } },
//       { "address.city": { $regex: needle, $options: "i" } },
//       { "address.street": { $regex: needle, $options: "i" } },
//       { notes: { $regex: needle, $options: "i" } },
//       { userId: isFinite(+needle) ? +needle : -1 },
//     ];
//   }

//   return filter;
// }

// module.exports = { buildFilter };
