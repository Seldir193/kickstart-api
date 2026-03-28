"use strict";

const Customer = require("../../../../models/Customer");
const { safeStr, normEmail } = require("./strings");
const crypto = require("crypto");

function pickInvoiceEmail(booking) {
  return (
    normEmail(booking?.invoiceTo?.parent?.email) ||
    normEmail(booking?.email) ||
    ""
  );
}

function pickParent(booking) {
  const p = booking?.invoiceTo?.parent || {};
  return {
    salutation: safeStr(p.salutation),
    firstName: safeStr(p.firstName),
    lastName: safeStr(p.lastName),
    email: normEmail(p.email) || normEmail(booking?.email),
    phone: safeStr(p.phone),
    phone2: safeStr(p.phone2),
  };
}

function pickAddress(booking) {
  const a = booking?.invoiceTo?.address || {};
  return {
    street: safeStr(a.street),
    houseNo: safeStr(a.houseNo),
    zip: safeStr(a.zip),
    city: safeStr(a.city),
  };
}

function newUid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function safeLower(v) {
  return safeStr(v).toLowerCase();
}

function normName(v) {
  return safeStr(v).trim().toLowerCase();
}

function hasText(v) {
  return safeStr(v).trim() !== "";
}

function sameName(a, b) {
  return normName(a) === normName(b);
}

function assertEmailParentNameMatch(existingCustomer, incomingParent) {
  if (!existingCustomer || !incomingParent) return;

  const ex = existingCustomer.parent || {};
  const inc = incomingParent || {};

  const exFirst = safeStr(ex.firstName);
  const exLast = safeStr(ex.lastName);
  const inFirst = safeStr(inc.firstName);
  const inLast = safeStr(inc.lastName);

  if (!hasText(exFirst) || !hasText(exLast)) return;
  if (!hasText(inFirst) || !hasText(inLast)) return;

  const okFirst = sameName(exFirst, inFirst);
  const okLast = sameName(exLast, inLast);

  if (!okFirst || !okLast) {
    const err = new Error("EMAIL_PARENT_NAME_MISMATCH");
    err.status = 409;
    err.code = "EMAIL_PARENT_NAME_MISMATCH";
    throw err;
  }
}

function setIfEmpty(obj, key, val) {
  const cur = safeStr(obj?.[key]);
  const next = safeStr(val);
  if (!cur && next) {
    obj[key] = next;
    return true;
  }
  return false;
}

function applyParentIfEmpty(customerDoc, incomingParent, emailLower) {
  if (!customerDoc.parent || typeof customerDoc.parent !== "object") {
    customerDoc.parent = {};
  }

  const p = customerDoc.parent;
  let changed = false;

  changed = setIfEmpty(p, "salutation", incomingParent?.salutation) || changed;
  changed = setIfEmpty(p, "firstName", incomingParent?.firstName) || changed;
  changed = setIfEmpty(p, "lastName", incomingParent?.lastName) || changed;
  changed =
    setIfEmpty(p, "email", incomingParent?.email || emailLower) || changed;
  changed = setIfEmpty(p, "phone", incomingParent?.phone) || changed;
  changed = setIfEmpty(p, "phone2", incomingParent?.phone2) || changed;

  return changed;
}

function applyAddressIfEmpty(customerDoc, incomingAddress) {
  if (!customerDoc.address || typeof customerDoc.address !== "object") {
    customerDoc.address = {};
  }

  const a = customerDoc.address;
  let changed = false;

  changed = setIfEmpty(a, "street", incomingAddress?.street) || changed;
  changed = setIfEmpty(a, "houseNo", incomingAddress?.houseNo) || changed;
  changed = setIfEmpty(a, "zip", incomingAddress?.zip) || changed;
  changed = setIfEmpty(a, "city", incomingAddress?.city) || changed;

  return changed;
}

function birthKey(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function childKey(c) {
  const fn = safeLower(c?.firstName);
  const ln = safeLower(c?.lastName);
  const bd = birthKey(c?.birthDate);
  return `${fn}::${ln}::${bd}`;
}

function childNameKey(c) {
  const fn = safeLower(c?.firstName);
  const ln = safeLower(c?.lastName);
  return `${fn}::${ln}`;
}

function hasBirthDate(v) {
  return birthKey(v) !== "";
}

function pickChildFromBooking(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
  const snap = meta.contractSnapshot || {};
  const snapChild = snap.child || {};
  const invChild = booking?.invoiceTo?.child || {};

  const uid =
    safeStr(meta.childUid) ||
    safeStr(meta.childUID) ||
    safeStr(snapChild.uid) ||
    safeStr(invChild.uid) ||
    safeStr(booking?.childUid) ||
    "";

  const firstName =
    safeStr(meta.childFirstName) ||
    safeStr(snapChild.firstName) ||
    safeStr(meta.firstName) ||
    safeStr(invChild.firstName) ||
    safeStr(booking?.childFirstName) ||
    safeStr(booking?.firstName);

  const lastName =
    safeStr(meta.childLastName) ||
    safeStr(snapChild.lastName) ||
    safeStr(meta.lastName) ||
    safeStr(invChild.lastName) ||
    safeStr(booking?.childLastName) ||
    safeStr(booking?.lastName);

  const birthDate =
    meta.childBirthDate ||
    snapChild.birthDate ||
    meta.birthDate ||
    invChild.birthDate ||
    booking?.birthDate ||
    null;

  const gender =
    safeStr(meta.gender) ||
    safeStr(snapChild.gender) ||
    safeStr(invChild.gender) ||
    "";

  const club =
    safeStr(meta.club) ||
    safeStr(snapChild.club) ||
    safeStr(invChild.club) ||
    "";

  return {
    uid: safeStr(uid),
    firstName,
    lastName,
    gender,
    birthDate: birthDate ? new Date(birthDate) : null,
    club,
  };
}

function ensureChildrenArray(customerDoc) {
  if (!Array.isArray(customerDoc.children)) customerDoc.children = [];
  return customerDoc.children;
}

function ensureUid(child) {
  if (!child) return "";
  if (safeStr(child.uid)) return safeStr(child.uid);
  child.uid = newUid();
  return child.uid;
}

function mergeChildIfMissing(target, source) {
  if (!target || !source) return;

  if (!safeStr(target.firstName) && safeStr(source.firstName)) {
    target.firstName = safeStr(source.firstName);
  }

  if (!safeStr(target.lastName) && safeStr(source.lastName)) {
    target.lastName = safeStr(source.lastName);
  }

  if (!safeStr(target.gender) && safeStr(source.gender)) {
    target.gender = safeStr(source.gender);
  }

  if (!safeStr(target.club) && safeStr(source.club)) {
    target.club = safeStr(source.club);
  }

  if (!hasBirthDate(target.birthDate) && hasBirthDate(source.birthDate)) {
    target.birthDate = source.birthDate;
  }

  ensureUid(target);
}

function findChildByUid(customerDoc, child) {
  const uid = safeStr(child?.uid);
  if (!uid) return null;
  const list = ensureChildrenArray(customerDoc);
  return list.find((c) => safeStr(c?.uid) === uid) || null;
}

function findChildByExactKey(customerDoc, child) {
  const key = childKey(child);
  if (!key || key === "::") return null;
  const list = ensureChildrenArray(customerDoc);
  return list.find((c) => childKey(c) === key) || null;
}

function findChildByNameFallback(customerDoc, child) {
  const key = childNameKey(child);
  if (!key || key === "::") return null;

  const list = ensureChildrenArray(customerDoc);
  const hits = list.filter((c) => childNameKey(c) === key);

  if (hits.length === 1) return hits[0];

  const incomingHasBirth = hasBirthDate(child?.birthDate);
  if (!incomingHasBirth) return null;

  const birthMatch = hits.find(
    (c) => birthKey(c?.birthDate) === birthKey(child?.birthDate),
  );
  if (birthMatch) return birthMatch;

  const missingBirthHits = hits.filter((c) => !hasBirthDate(c?.birthDate));
  if (missingBirthHits.length === 1) return missingBirthHits[0];

  return null;
}

function syncPrimaryChild(customerDoc, child) {
  if (!customerDoc.child || typeof customerDoc.child !== "object") {
    customerDoc.child = child;
    return;
  }

  const sameUid =
    safeStr(customerDoc.child?.uid) &&
    safeStr(customerDoc.child?.uid) === safeStr(child?.uid);

  const sameName =
    childNameKey(customerDoc.child) === childNameKey(child) &&
    childNameKey(child) !== "::";

  if (sameUid || sameName || !safeStr(customerDoc.child?.uid)) {
    mergeChildIfMissing(customerDoc.child, child);
    if (!safeStr(customerDoc.child?.uid) && safeStr(child?.uid)) {
      customerDoc.child.uid = safeStr(child.uid);
    }
  }
}

function upsertChild(customerDoc, rawChild) {
  const child = {
    uid: safeStr(rawChild?.uid),
    firstName: safeStr(rawChild?.firstName),
    lastName: safeStr(rawChild?.lastName),
    gender: safeStr(rawChild?.gender),
    birthDate: rawChild?.birthDate || null,
    club: safeStr(rawChild?.club),
  };

  const hasName = safeStr(child.firstName) || safeStr(child.lastName);
  const hasUid = safeStr(child.uid);
  if (!hasUid && !hasName) return "";

  const list = ensureChildrenArray(customerDoc);

  const byUid = findChildByUid(customerDoc, child);
  if (byUid) {
    mergeChildIfMissing(byUid, child);
    syncPrimaryChild(customerDoc, byUid);
    return safeStr(byUid.uid);
  }

  const byExactKey = findChildByExactKey(customerDoc, child);
  if (byExactKey) {
    mergeChildIfMissing(byExactKey, child);
    syncPrimaryChild(customerDoc, byExactKey);
    return safeStr(byExactKey.uid);
  }

  const byNameFallback = findChildByNameFallback(customerDoc, child);
  if (byNameFallback) {
    if (!safeStr(byNameFallback.uid) && hasUid) {
      byNameFallback.uid = child.uid;
    }
    mergeChildIfMissing(byNameFallback, child);
    syncPrimaryChild(customerDoc, byNameFallback);
    return safeStr(byNameFallback.uid);
  }

  child.uid = safeStr(child.uid) || newUid();
  list.push(child);
  syncPrimaryChild(customerDoc, child);

  if (!safeStr(customerDoc.child?.uid)) {
    customerDoc.child = child;
  }

  return child.uid;
}

function bookingDateOrNow(booking) {
  const s = safeStr(booking?.date);
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : new Date();
}

async function ensureCustomerUserId(customerDoc, owner) {
  if (customerDoc.userId != null) return;
  customerDoc.userId = await Customer.nextUserIdForOwner(owner);
}

function findBookingRef(customerDoc, bookingId) {
  const id = String(bookingId || "");
  const direct = customerDoc.bookings?.find((b) => String(b?.bookingId) === id);
  if (direct) return direct;
  return customerDoc.bookings?.find((b) => String(b?._id) === id) || null;
}

function normalizeBookingRefStatus(v) {
  const s = safeStr(v);
  if (!s) return "";
  if (
    s === "active" ||
    s === "cancelled" ||
    s === "completed" ||
    s === "pending"
  ) {
    return s;
  }

  if (s === "confirmed") return "active";
  if (s === "processing") return "pending";
  if (s === "storno") return "cancelled";
  if (s === "deleted") return "cancelled";

  return "";
}

function pickStatus(booking, current) {
  const fromBooking = normalizeBookingRefStatus(booking?.status);
  if (fromBooking) return fromBooking;

  const cur = normalizeBookingRefStatus(current?.status);
  if (cur) return cur;

  return "active";
}

function upsertBookingRef(customerDoc, booking, offer, childUid, child) {
  if (!Array.isArray(customerDoc.bookings)) customerDoc.bookings = [];
  const ref = findBookingRef(customerDoc, booking._id);

  const invoiceNumber = safeStr(booking?.invoiceNumber);
  const invoiceNo = safeStr(booking?.invoiceNo);
  const invoiceDate = booking?.invoiceDate || null;

  const next = {
    _id: booking._id,
    bookingId: booking._id,
    offerId: booking.offerId,
    offerTitle: safeStr(offer?.title) || safeStr(booking?.offerTitle),
    offerType:
      safeStr(offer?.sub_type || offer?.type) || safeStr(booking?.offerType),
    venue: safeStr(offer?.location) || safeStr(booking?.venue),
    date: bookingDateOrNow(booking),
    childUid: safeStr(childUid),
    childFirstName: safeStr(child?.firstName) || safeStr(booking?.firstName),
    childLastName: safeStr(child?.lastName) || safeStr(booking?.lastName),
    status: pickStatus(booking, ref),
    currency: safeStr(booking?.currency) || safeStr(ref?.currency) || "EUR",
    priceMonthly:
      typeof booking?.priceMonthly === "number" ? booking.priceMonthly : null,
    priceFirstMonth:
      typeof booking?.priceFirstMonth === "number"
        ? booking.priceFirstMonth
        : null,
    priceAtBooking:
      typeof booking?.priceAtBooking === "number"
        ? booking.priceAtBooking
        : null,
    invoiceNumber: invoiceNumber || safeStr(ref?.invoiceNumber),
    invoiceNo: invoiceNo || safeStr(ref?.invoiceNo),
    invoiceDate: invoiceDate || ref?.invoiceDate || null,
    cancellationNo: safeStr(ref?.cancellationNo),
    cancelDate: ref?.cancelDate || null,
    stornoNo: safeStr(ref?.stornoNo),
    stornoDate: ref?.stornoDate || null,
    stornoAmount:
      typeof ref?.stornoAmount === "number" ? ref.stornoAmount : null,
  };

  if (!ref) {
    customerDoc.bookings.push(next);
    return;
  }

  Object.assign(ref, next);
}

function isDupKeyError(err) {
  return (
    !!err &&
    (err.code === 11000 || String(err?.message || "").includes("E11000"))
  );
}

async function findCustomerByEmailLower(owner, emailLower) {
  if (!owner || !emailLower) return null;
  return Customer.findOne({ owner, emailLower }).exec();
}

async function findCustomerByBookingCustomerId(booking) {
  const customerId = String(booking?.customerId || "").trim();
  const owner = booking?.owner;

  if (!owner || !customerId) {
    return null;
  }

  const found = await Customer.findOne({ _id: customerId, owner }).exec();

  return found;
}

async function upsertCustomerShell(owner, booking) {
  const emailLower = pickInvoiceEmail(booking);
  if (!owner || !emailLower) return null;

  const incomingParent = pickParent(booking);
  const incomingAddress = pickAddress(booking);
  const pickedChild = pickChildFromBooking(booking);

  const existing = await findCustomerByEmailLower(owner, emailLower);
  if (existing) {
    assertEmailParentNameMatch(existing, incomingParent);

    let changed = false;

    changed = setIfEmpty(existing, "email", emailLower) || changed;

    const lowerEmail = String(emailLower).trim().toLowerCase();
    if (lowerEmail && existing.emailLower !== lowerEmail) {
      existing.emailLower = lowerEmail;
      changed = true;
    }

    changed =
      applyParentIfEmpty(existing, incomingParent, emailLower) || changed;
    changed = applyAddressIfEmpty(existing, incomingAddress) || changed;

    const beforeChildren = JSON.stringify(existing.children || []);
    const beforeChild = JSON.stringify(existing.child || {});
    upsertChild(existing, pickedChild);

    if (
      beforeChildren !== JSON.stringify(existing.children || []) ||
      beforeChild !== JSON.stringify(existing.child || {})
    ) {
      changed = true;
    }

    if (changed) await existing.save();
    return existing;
  }

  const childForInsert = {
    uid: safeStr(pickedChild.uid) || newUid(),
    firstName: safeStr(pickedChild.firstName),
    lastName: safeStr(pickedChild.lastName),
    gender: safeStr(pickedChild.gender),
    birthDate: pickedChild.birthDate || null,
    club: safeStr(pickedChild.club),
  };

  const setOnInsert = {
    owner,
    newsletter: false,
    email: emailLower,
    emailLower,
    parent: { ...incomingParent, email: incomingParent.email || emailLower },
    address: incomingAddress,
    child: childForInsert,
    children: [childForInsert],
    bookings: [],
    relatedCustomerIds: [],
  };

  try {
    return await Customer.findOneAndUpdate(
      { owner, emailLower },
      { $setOnInsert: setOnInsert },
      { new: true, upsert: true },
    ).exec();
  } catch (err) {
    if (!isDupKeyError(err)) throw err;
    return await findCustomerByEmailLower(owner, emailLower);
  }
}

function ensureShellChildren(customerDoc) {
  ensureChildrenArray(customerDoc);

  if (!safeStr(customerDoc.child?.uid)) ensureUid(customerDoc.child);

  if (
    !Array.isArray(customerDoc.children) ||
    customerDoc.children.length === 0
  ) {
    const base = {
      uid: ensureUid(customerDoc.child),
      firstName: safeStr(customerDoc.child?.firstName),
      lastName: safeStr(customerDoc.child?.lastName),
      gender: safeStr(customerDoc.child?.gender),
      birthDate: customerDoc.child?.birthDate || null,
      club: safeStr(customerDoc.child?.club),
    };
    customerDoc.children = [base];
    customerDoc.child = base;
  }

  for (const c of customerDoc.children) ensureUid(c);

  if (!safeStr(customerDoc.child?.uid) && customerDoc.children[0]) {
    customerDoc.child = customerDoc.children[0];
  }
}

async function ensureCustomerForPaidBooking(booking, offer) {
  const owner = booking?.owner;
  if (!owner) return null;

  let doc = await findCustomerByBookingCustomerId(booking);

  if (!doc) {
    const emailLower = pickInvoiceEmail(booking);
    if (!emailLower) return null;

    doc = await upsertCustomerShell(owner, booking);
  }

  if (!doc) return null;

  ensureShellChildren(doc);

  const pickedChild = pickChildFromBooking(booking);
  const childUid = upsertChild(doc, pickedChild);

  const effectiveUid =
    safeStr(childUid) ||
    ensureUid(doc.child) ||
    (doc.children?.[0] ? ensureUid(doc.children[0]) : "");

  ensureShellChildren(doc);

  upsertBookingRef(doc, booking, offer, effectiveUid, pickedChild);
  await ensureCustomerUserId(doc, owner);

  try {
    await doc.save();
  } catch (err) {
    if (!isDupKeyError(err)) throw err;

    const emailLower = pickInvoiceEmail(booking);
    const latest = await findCustomerByEmailLower(owner, emailLower);
    if (!latest) throw err;

    ensureShellChildren(latest);

    const picked = pickChildFromBooking(booking);
    const uid = upsertChild(latest, picked);

    const eff =
      safeStr(uid) ||
      ensureUid(latest.child) ||
      (latest.children?.[0] ? ensureUid(latest.children[0]) : "");

    ensureShellChildren(latest);

    upsertBookingRef(latest, booking, offer, eff, picked);
    await ensureCustomerUserId(latest, owner);
    await latest.save();

    if (!booking.customerId) await linkBookingCustomer(booking, latest._id);

    return latest;
  }

  if (!booking.customerId) await linkBookingCustomer(booking, doc._id);

  return doc;
}

async function linkBookingCustomer(booking, customerId) {
  booking.customerId = customerId;
  await booking.save();
}

module.exports = { ensureCustomerForPaidBooking };

// //routes\payments\stripe\lib\customerSync.js
// "use strict";

// const Customer = require("../../../../models/Customer");
// const { safeStr, normEmail } = require("./strings");
// const crypto = require("crypto");

// function pickInvoiceEmail(booking) {
//   return (
//     normEmail(booking?.invoiceTo?.parent?.email) ||
//     normEmail(booking?.email) ||
//     ""
//   );
// }

// function pickParent(booking) {
//   const p = booking?.invoiceTo?.parent || {};
//   return {
//     salutation: safeStr(p.salutation),
//     firstName: safeStr(p.firstName),
//     lastName: safeStr(p.lastName),
//     email: normEmail(p.email) || normEmail(booking?.email),
//     phone: safeStr(p.phone),
//     phone2: safeStr(p.phone2),
//   };
// }

// function pickAddress(booking) {
//   const a = booking?.invoiceTo?.address || {};
//   return {
//     street: safeStr(a.street),
//     houseNo: safeStr(a.houseNo),
//     zip: safeStr(a.zip),
//     city: safeStr(a.city),
//   };
// }

// function newUid() {
//   if (crypto.randomUUID) return crypto.randomUUID();
//   return crypto.randomBytes(16).toString("hex");
// }

// function safeLower(v) {
//   return safeStr(v).toLowerCase();
// }

// function normName(v) {
//   return safeStr(v).trim().toLowerCase();
// }

// function hasText(v) {
//   return safeStr(v).trim() !== "";
// }

// function sameName(a, b) {
//   return normName(a) === normName(b);
// }

// function assertEmailParentNameMatch(existingCustomer, incomingParent) {
//   if (!existingCustomer || !incomingParent) return;

//   const ex = existingCustomer.parent || {};
//   const inc = incomingParent || {};

//   const exFirst = safeStr(ex.firstName);
//   const exLast = safeStr(ex.lastName);
//   const inFirst = safeStr(inc.firstName);
//   const inLast = safeStr(inc.lastName);

//   if (!hasText(exFirst) || !hasText(exLast)) return;
//   if (!hasText(inFirst) || !hasText(inLast)) return;

//   const okFirst = sameName(exFirst, inFirst);
//   const okLast = sameName(exLast, inLast);

//   if (!okFirst || !okLast) {
//     const err = new Error("EMAIL_PARENT_NAME_MISMATCH");
//     err.status = 409;
//     err.code = "EMAIL_PARENT_NAME_MISMATCH";
//     throw err;
//   }
// }

// function setIfEmpty(obj, key, val) {
//   const cur = safeStr(obj?.[key]);
//   const next = safeStr(val);
//   if (!cur && next) {
//     obj[key] = next;
//     return true;
//   }
//   return false;
// }

// function applyParentIfEmpty(customerDoc, incomingParent, emailLower) {
//   if (!customerDoc.parent || typeof customerDoc.parent !== "object") {
//     customerDoc.parent = {};
//   }

//   const p = customerDoc.parent;
//   let changed = false;

//   changed = setIfEmpty(p, "salutation", incomingParent?.salutation) || changed;
//   changed = setIfEmpty(p, "firstName", incomingParent?.firstName) || changed;
//   changed = setIfEmpty(p, "lastName", incomingParent?.lastName) || changed;
//   changed =
//     setIfEmpty(p, "email", incomingParent?.email || emailLower) || changed;
//   changed = setIfEmpty(p, "phone", incomingParent?.phone) || changed;
//   changed = setIfEmpty(p, "phone2", incomingParent?.phone2) || changed;

//   return changed;
// }

// function applyAddressIfEmpty(customerDoc, incomingAddress) {
//   if (!customerDoc.address || typeof customerDoc.address !== "object") {
//     customerDoc.address = {};
//   }

//   const a = customerDoc.address;
//   let changed = false;

//   changed = setIfEmpty(a, "street", incomingAddress?.street) || changed;
//   changed = setIfEmpty(a, "houseNo", incomingAddress?.houseNo) || changed;
//   changed = setIfEmpty(a, "zip", incomingAddress?.zip) || changed;
//   changed = setIfEmpty(a, "city", incomingAddress?.city) || changed;

//   return changed;
// }

// function birthKey(v) {
//   if (!v) return "";
//   const d = new Date(v);
//   if (Number.isNaN(d.getTime())) return "";
//   return d.toISOString().slice(0, 10);
// }

// function childKey(c) {
//   const fn = safeLower(c?.firstName);
//   const ln = safeLower(c?.lastName);
//   const bd = birthKey(c?.birthDate);
//   return `${fn}::${ln}::${bd}`;
// }

// function childNameKey(c) {
//   const fn = safeLower(c?.firstName);
//   const ln = safeLower(c?.lastName);
//   return `${fn}::${ln}`;
// }

// function hasBirthDate(v) {
//   return birthKey(v) !== "";
// }

// function pickChildFromBooking(booking) {
//   const meta =
//     booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
//   const snap = meta.contractSnapshot || {};
//   const snapChild = snap.child || {};
//   const invChild = booking?.invoiceTo?.child || {};

//   const uid =
//     safeStr(meta.childUid) ||
//     safeStr(meta.childUID) ||
//     safeStr(snapChild.uid) ||
//     safeStr(invChild.uid) ||
//     safeStr(booking?.childUid) ||
//     "";

//   const firstName =
//     safeStr(meta.childFirstName) ||
//     safeStr(snapChild.firstName) ||
//     safeStr(meta.firstName) ||
//     safeStr(invChild.firstName) ||
//     safeStr(booking?.childFirstName) ||
//     safeStr(booking?.firstName);

//   const lastName =
//     safeStr(meta.childLastName) ||
//     safeStr(snapChild.lastName) ||
//     safeStr(meta.lastName) ||
//     safeStr(invChild.lastName) ||
//     safeStr(booking?.childLastName) ||
//     safeStr(booking?.lastName);

//   const birthDate =
//     meta.childBirthDate ||
//     snapChild.birthDate ||
//     meta.birthDate ||
//     invChild.birthDate ||
//     booking?.birthDate ||
//     null;

//   const gender =
//     safeStr(meta.gender) ||
//     safeStr(snapChild.gender) ||
//     safeStr(invChild.gender) ||
//     "";

//   const club =
//     safeStr(meta.club) ||
//     safeStr(snapChild.club) ||
//     safeStr(invChild.club) ||
//     "";

//   return {
//     uid: safeStr(uid),
//     firstName,
//     lastName,
//     gender,
//     birthDate: birthDate ? new Date(birthDate) : null,
//     club,
//   };
// }

// function ensureChildrenArray(customerDoc) {
//   if (!Array.isArray(customerDoc.children)) customerDoc.children = [];
//   return customerDoc.children;
// }

// function ensureUid(child) {
//   if (!child) return "";
//   if (safeStr(child.uid)) return safeStr(child.uid);
//   child.uid = newUid();
//   return child.uid;
// }

// function mergeChildIfMissing(target, source) {
//   if (!target || !source) return;

//   if (!safeStr(target.firstName) && safeStr(source.firstName)) {
//     target.firstName = safeStr(source.firstName);
//   }

//   if (!safeStr(target.lastName) && safeStr(source.lastName)) {
//     target.lastName = safeStr(source.lastName);
//   }

//   if (!safeStr(target.gender) && safeStr(source.gender)) {
//     target.gender = safeStr(source.gender);
//   }

//   if (!safeStr(target.club) && safeStr(source.club)) {
//     target.club = safeStr(source.club);
//   }

//   if (!hasBirthDate(target.birthDate) && hasBirthDate(source.birthDate)) {
//     target.birthDate = source.birthDate;
//   }

//   ensureUid(target);
// }

// function findChildByUid(customerDoc, child) {
//   const uid = safeStr(child?.uid);
//   if (!uid) return null;
//   const list = ensureChildrenArray(customerDoc);
//   return list.find((c) => safeStr(c?.uid) === uid) || null;
// }

// function findChildByExactKey(customerDoc, child) {
//   const key = childKey(child);
//   if (!key || key === "::") return null;
//   const list = ensureChildrenArray(customerDoc);
//   return list.find((c) => childKey(c) === key) || null;
// }

// function findChildByNameFallback(customerDoc, child) {
//   const key = childNameKey(child);
//   if (!key || key === "::") return null;

//   const list = ensureChildrenArray(customerDoc);
//   const hits = list.filter((c) => childNameKey(c) === key);

//   if (hits.length === 1) return hits[0];

//   const incomingHasBirth = hasBirthDate(child?.birthDate);
//   if (!incomingHasBirth) return null;

//   const birthMatch = hits.find(
//     (c) => birthKey(c?.birthDate) === birthKey(child?.birthDate),
//   );
//   if (birthMatch) return birthMatch;

//   const missingBirthHits = hits.filter((c) => !hasBirthDate(c?.birthDate));
//   if (missingBirthHits.length === 1) return missingBirthHits[0];

//   return null;
// }

// function syncPrimaryChild(customerDoc, child) {
//   if (!customerDoc.child || typeof customerDoc.child !== "object") {
//     customerDoc.child = child;
//     return;
//   }

//   const sameUid =
//     safeStr(customerDoc.child?.uid) &&
//     safeStr(customerDoc.child?.uid) === safeStr(child?.uid);

//   const sameName =
//     childNameKey(customerDoc.child) === childNameKey(child) &&
//     childNameKey(child) !== "::";

//   if (sameUid || sameName || !safeStr(customerDoc.child?.uid)) {
//     mergeChildIfMissing(customerDoc.child, child);
//     if (!safeStr(customerDoc.child?.uid) && safeStr(child?.uid)) {
//       customerDoc.child.uid = safeStr(child.uid);
//     }
//   }
// }

// function upsertChild(customerDoc, rawChild) {
//   const child = {
//     uid: safeStr(rawChild?.uid),
//     firstName: safeStr(rawChild?.firstName),
//     lastName: safeStr(rawChild?.lastName),
//     gender: safeStr(rawChild?.gender),
//     birthDate: rawChild?.birthDate || null,
//     club: safeStr(rawChild?.club),
//   };

//   const hasName = safeStr(child.firstName) || safeStr(child.lastName);
//   const hasUid = safeStr(child.uid);
//   if (!hasUid && !hasName) return "";

//   const list = ensureChildrenArray(customerDoc);

//   const byUid = findChildByUid(customerDoc, child);
//   if (byUid) {
//     mergeChildIfMissing(byUid, child);
//     syncPrimaryChild(customerDoc, byUid);
//     return safeStr(byUid.uid);
//   }

//   const byExactKey = findChildByExactKey(customerDoc, child);
//   if (byExactKey) {
//     mergeChildIfMissing(byExactKey, child);
//     syncPrimaryChild(customerDoc, byExactKey);
//     return safeStr(byExactKey.uid);
//   }

//   const byNameFallback = findChildByNameFallback(customerDoc, child);
//   if (byNameFallback) {
//     if (!safeStr(byNameFallback.uid) && hasUid) {
//       byNameFallback.uid = child.uid;
//     }
//     mergeChildIfMissing(byNameFallback, child);
//     syncPrimaryChild(customerDoc, byNameFallback);
//     return safeStr(byNameFallback.uid);
//   }

//   child.uid = safeStr(child.uid) || newUid();
//   list.push(child);
//   syncPrimaryChild(customerDoc, child);

//   if (!safeStr(customerDoc.child?.uid)) {
//     customerDoc.child = child;
//   }

//   return child.uid;
// }

// function bookingDateOrNow(booking) {
//   const s = safeStr(booking?.date);
//   const d = s ? new Date(s) : null;
//   return d && !Number.isNaN(d.getTime()) ? d : new Date();
// }

// async function ensureCustomerUserId(customerDoc, owner) {
//   if (customerDoc.userId != null) return;
//   customerDoc.userId = await Customer.nextUserIdForOwner(owner);
// }

// function findBookingRef(customerDoc, bookingId) {
//   const id = String(bookingId || "");
//   const direct = customerDoc.bookings?.find((b) => String(b?.bookingId) === id);
//   if (direct) return direct;
//   return customerDoc.bookings?.find((b) => String(b?._id) === id) || null;
// }

// function normalizeBookingRefStatus(v) {
//   const s = safeStr(v);
//   if (!s) return "";
//   if (
//     s === "active" ||
//     s === "cancelled" ||
//     s === "completed" ||
//     s === "pending"
//   ) {
//     return s;
//   }

//   if (s === "confirmed") return "active";
//   if (s === "processing") return "pending";
//   if (s === "storno") return "cancelled";
//   if (s === "deleted") return "cancelled";

//   return "";
// }

// function pickStatus(booking, current) {
//   const fromBooking = normalizeBookingRefStatus(booking?.status);
//   if (fromBooking) return fromBooking;

//   const cur = normalizeBookingRefStatus(current?.status);
//   if (cur) return cur;

//   return "active";
// }

// function upsertBookingRef(customerDoc, booking, offer, childUid, child) {
//   if (!Array.isArray(customerDoc.bookings)) customerDoc.bookings = [];
//   const ref = findBookingRef(customerDoc, booking._id);

//   const invoiceNumber = safeStr(booking?.invoiceNumber);
//   const invoiceNo = safeStr(booking?.invoiceNo);
//   const invoiceDate = booking?.invoiceDate || null;

//   const next = {
//     _id: booking._id,
//     bookingId: booking._id,
//     offerId: booking.offerId,
//     offerTitle: safeStr(offer?.title) || safeStr(booking?.offerTitle),
//     offerType:
//       safeStr(offer?.sub_type || offer?.type) || safeStr(booking?.offerType),
//     venue: safeStr(offer?.location) || safeStr(booking?.venue),
//     date: bookingDateOrNow(booking),

//     childUid: safeStr(childUid),
//     childFirstName: safeStr(child?.firstName) || safeStr(booking?.firstName),
//     childLastName: safeStr(child?.lastName) || safeStr(booking?.lastName),

//     status: pickStatus(booking, ref),
//     currency: safeStr(booking?.currency) || safeStr(ref?.currency) || "EUR",
//     priceMonthly:
//       typeof booking?.priceMonthly === "number" ? booking.priceMonthly : null,
//     priceFirstMonth:
//       typeof booking?.priceFirstMonth === "number"
//         ? booking.priceFirstMonth
//         : null,
//     priceAtBooking:
//       typeof booking?.priceAtBooking === "number"
//         ? booking.priceAtBooking
//         : null,
//     invoiceNumber: invoiceNumber || safeStr(ref?.invoiceNumber),
//     invoiceNo: invoiceNo || safeStr(ref?.invoiceNo),
//     invoiceDate: invoiceDate || ref?.invoiceDate || null,
//     cancellationNo: safeStr(ref?.cancellationNo),
//     cancelDate: ref?.cancelDate || null,
//     stornoNo: safeStr(ref?.stornoNo),
//     stornoDate: ref?.stornoDate || null,
//     stornoAmount:
//       typeof ref?.stornoAmount === "number" ? ref.stornoAmount : null,
//   };

//   if (!ref) {
//     customerDoc.bookings.push(next);
//     return;
//   }

//   Object.assign(ref, next);
// }

// function isDupKeyError(err) {
//   return (
//     !!err &&
//     (err.code === 11000 || String(err?.message || "").includes("E11000"))
//   );
// }

// async function findCustomerByEmailLower(owner, emailLower) {
//   if (!owner || !emailLower) return null;
//   return Customer.findOne({ owner, emailLower }).exec();
// }

// async function findCustomerByBookingCustomerId(booking) {

//   const customerId = safeStr(booking?.customerId);
//   const owner = booking?.owner;

//   if (!owner || !customerId) return null;
//   return Customer.findOne({ _id: customerId, owner }).exec();
// }

// async function upsertCustomerShell(owner, booking) {

//   const emailLower = pickInvoiceEmail(booking);
//   if (!owner || !emailLower) return null;

//   const incomingParent = pickParent(booking);
//   const incomingAddress = pickAddress(booking);
//   const pickedChild = pickChildFromBooking(booking);

//   const existing = await findCustomerByEmailLower(owner, emailLower);
//   if (existing) {
//     assertEmailParentNameMatch(existing, incomingParent);

//     let changed = false;

//     changed = setIfEmpty(existing, "email", emailLower) || changed;

//     const lowerEmail = String(emailLower).trim().toLowerCase();
//     if (lowerEmail && existing.emailLower !== lowerEmail) {
//       existing.emailLower = lowerEmail;
//       changed = true;
//     }

//     changed =
//       applyParentIfEmpty(existing, incomingParent, emailLower) || changed;
//     changed = applyAddressIfEmpty(existing, incomingAddress) || changed;

//     const beforeChildren = JSON.stringify(existing.children || []);
//     const beforeChild = JSON.stringify(existing.child || {});
//     upsertChild(existing, pickedChild);

//     if (
//       beforeChildren !== JSON.stringify(existing.children || []) ||
//       beforeChild !== JSON.stringify(existing.child || {})
//     ) {
//       changed = true;
//     }

//     if (changed) await existing.save();
//     return existing;
//   }

//   const childForInsert = {
//     uid: safeStr(pickedChild.uid) || newUid(),
//     firstName: safeStr(pickedChild.firstName),
//     lastName: safeStr(pickedChild.lastName),
//     gender: safeStr(pickedChild.gender),
//     birthDate: pickedChild.birthDate || null,
//     club: safeStr(pickedChild.club),
//   };

//   const setOnInsert = {
//     owner,
//     newsletter: false,
//     email: emailLower,
//     emailLower,
//     parent: { ...incomingParent, email: incomingParent.email || emailLower },
//     address: incomingAddress,
//     child: childForInsert,
//     children: [childForInsert],
//     bookings: [],
//     relatedCustomerIds: [],
//   };

//   try {

//     return await Customer.findOneAndUpdate(
//       { owner, emailLower },
//       { $setOnInsert: setOnInsert },
//       { new: true, upsert: true },
//     ).exec();
//   } catch (err) {
//     if (!isDupKeyError(err)) throw err;
//     return await findCustomerByEmailLower(owner, emailLower);
//   }
// }

// function ensureShellChildren(customerDoc) {
//   ensureChildrenArray(customerDoc);

//   if (!safeStr(customerDoc.child?.uid)) ensureUid(customerDoc.child);

//   if (
//     !Array.isArray(customerDoc.children) ||
//     customerDoc.children.length === 0
//   ) {
//     const base = {
//       uid: ensureUid(customerDoc.child),
//       firstName: safeStr(customerDoc.child?.firstName),
//       lastName: safeStr(customerDoc.child?.lastName),
//       gender: safeStr(customerDoc.child?.gender),
//       birthDate: customerDoc.child?.birthDate || null,
//       club: safeStr(customerDoc.child?.club),
//     };
//     customerDoc.children = [base];
//     customerDoc.child = base;
//   }

//   for (const c of customerDoc.children) ensureUid(c);

//   if (!safeStr(customerDoc.child?.uid) && customerDoc.children[0]) {
//     customerDoc.child = customerDoc.children[0];
//   }
// }

// // async function ensureCustomerForPaidBooking(booking, offer) {
// //   const owner = booking?.owner;
// //   const emailLower = pickInvoiceEmail(booking);
// //   if (!owner || !emailLower) return null;

// //   const doc = await upsertCustomerShell(owner, booking);
// //   if (!doc) return null;

// async function ensureCustomerForPaidBooking(booking, offer) {
//   const owner = booking?.owner;
//   if (!owner) return null;

//   let doc = await findCustomerByBookingCustomerId(booking);

//   if (!doc) {
//     const emailLower = pickInvoiceEmail(booking);
//     if (!emailLower) return null;

//     doc = await upsertCustomerShell(owner, booking);
//   }

//   if (!doc) return null;

//   ensureShellChildren(doc);

//   const pickedChild = pickChildFromBooking(booking);
//   const childUid = upsertChild(doc, pickedChild);

//   const effectiveUid =
//     safeStr(childUid) ||
//     ensureUid(doc.child) ||
//     (doc.children?.[0] ? ensureUid(doc.children[0]) : "");

//   ensureShellChildren(doc);

//   upsertBookingRef(doc, booking, offer, effectiveUid, pickedChild);
//   await ensureCustomerUserId(doc, owner);

//   try {
//     await doc.save();
//   } catch (err) {
//     if (!isDupKeyError(err)) throw err;

//     const latest = await findCustomerByEmailLower(owner, emailLower);
//     if (!latest) throw err;

//     ensureShellChildren(latest);

//     const picked = pickChildFromBooking(booking);
//     const uid = upsertChild(latest, picked);

//     const eff =
//       safeStr(uid) ||
//       ensureUid(latest.child) ||
//       (latest.children?.[0] ? ensureUid(latest.children[0]) : "");

//     ensureShellChildren(latest);

//     upsertBookingRef(latest, booking, offer, eff, picked);
//     await ensureCustomerUserId(latest, owner);
//     await latest.save();

//     if (!booking.customerId) await linkBookingCustomer(booking, latest._id);
//     return latest;
//   }

//   if (!booking.customerId) await linkBookingCustomer(booking, doc._id);

//   return doc;
// }

// async function linkBookingCustomer(booking, customerId) {
//   booking.customerId = customerId;
//   await booking.save();
// }

// module.exports = { ensureCustomerForPaidBooking };
