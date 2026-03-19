//routes\customers\handlers\bookings\addAdminBooking.js
"use strict";

const mongoose = require("mongoose");

const { assignInvoiceData } = require("../../../../utils/billing");

const Customer = require("../../../../models/Customer");
const Offer = require("../../../../models/Offer");
const Booking = require("../../../../models/Booking");
const {
  createBookingCore,
} = require("../../../bookings/handlers/createBooking");

function safeText(v) {
  return String(v ?? "").trim();
}

function safeEmail(v) {
  return safeText(v).toLowerCase();
}

function hasRealValue(v) {
  const t = safeText(v);
  return t !== "" && t !== "-" && t !== "—";
}

function pickChildFromCustomer(customer, uid) {
  const cu = safeText(uid);
  if (!cu) return null;

  const legacy = customer?.child || null;
  const children = Array.isArray(customer?.children) ? customer.children : [];

  const hit =
    children.find((ch) => safeText(ch?.uid) === cu) ||
    (safeText(legacy?.uid) === cu ? legacy : null);

  return hit || null;
}

function offerHolidayLabel(offer, body) {
  return (
    safeText(body?.holidayLabel) ||
    safeText(offer?.holidayWeekName) ||
    safeText(offer?.holidayLabel) ||
    safeText(offer?.holidayWeek) ||
    safeText(offer?.holiday_name) ||
    safeText(offer?.holidayName) ||
    safeText(offer?.holiday) ||
    "-"
  );
}

function normalizeSiblingGender(raw) {
  const g = safeText(raw).toLowerCase();
  if (g === "male" || g === "m" || g === "männlich") return "männlich";
  if (g === "female" || g === "f" || g === "weiblich") return "weiblich";
  return safeText(raw) || "—";
}

function normalizeChildGender(raw) {
  const g = safeText(raw).toLowerCase();
  if (g === "male" || g === "m" || g === "männlich") return "männlich";
  if (g === "female" || g === "f" || g === "weiblich") return "weiblich";
  return "";
}

function calcAge(birthDate) {
  if (!birthDate) return 10;

  const d = new Date(birthDate);
  if (Number.isNaN(d.getTime())) return 10;

  return Math.max(
    5,
    Math.min(
      19,
      Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000)),
    ),
  );
}

function inferLevel(age) {
  if (age <= 8) return "U8";
  if (age <= 10) return "U10";
  if (age <= 12) return "U12";
  if (age <= 14) return "U14";
  if (age <= 16) return "U16";
  return "U18";
}

function formatDateOnlyDe(value) {
  if (!value) return "-";
  const iso = /T/.test(String(value)) ? String(value) : `${value}T00:00:00`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return safeText(value);

  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function formatRangeDe(from, to) {
  const a = formatDateOnlyDe(from);
  const b = formatDateOnlyDe(to);

  if (a === "-" && b === "-") return "-";
  if (a !== "-" && b !== "-") return `${a} – ${b}`;
  return a !== "-" ? a : b;
}

function buildParentName(customer) {
  const salutation = safeText(customer?.parent?.salutation);
  const firstName = safeText(customer?.parent?.firstName);
  const lastName = safeText(customer?.parent?.lastName);
  return [salutation, firstName, lastName].filter(Boolean).join(" ") || "-";
}

function buildAddress(customer) {
  const street = safeText(customer?.address?.street);
  const houseNo = safeText(customer?.address?.houseNo);
  const zip = safeText(customer?.address?.zip);
  const city = safeText(customer?.address?.city);
  const left = [street, houseNo].filter(Boolean).join(" ");
  const right = [zip, city].filter(Boolean).join(" ");
  return [left, right].filter(Boolean).join(", ") || "-";
}

function offerHolidayFrom(offer) {
  return (
    safeText(offer?.holidayDateFrom) ||
    safeText(offer?.holidayFrom) ||
    safeText(offer?.dateFrom) ||
    safeText(offer?.startDate) ||
    ""
  );
}

function offerHolidayTo(offer) {
  return (
    safeText(offer?.holidayDateTo) ||
    safeText(offer?.holidayTo) ||
    safeText(offer?.dateTo) ||
    safeText(offer?.endDate) ||
    ""
  );
}

function buildInvoiceTo(customer) {
  return {
    parent: {
      salutation: safeText(customer?.parent?.salutation),
      firstName: safeText(customer?.parent?.firstName),
      lastName: safeText(customer?.parent?.lastName),
      email: safeEmail(customer?.parent?.email),
      phone: safeText(customer?.parent?.phone),
      phone2: safeText(customer?.parent?.phone2),
    },
    address: {
      street: safeText(customer?.address?.street),
      houseNo: safeText(customer?.address?.houseNo),
      zip: safeText(customer?.address?.zip),
      city: safeText(customer?.address?.city),
    },
  };
}

function normalizeParentInput(parent = {}) {
  return {
    salutation: safeText(parent?.salutation),
    firstName: safeText(parent?.firstName),
    lastName: safeText(parent?.lastName),
    email: safeEmail(parent?.email),
    phone: safeText(parent?.phone),
    phone2: safeText(parent?.phone2),
  };
}

function parentHasData(parent) {
  if (!parent) return false;
  return [
    parent.salutation,
    parent.firstName,
    parent.lastName,
    parent.email,
    parent.phone,
    parent.phone2,
  ].some((v) => safeText(v) !== "");
}

function selectedParentFromBody(body, customer) {
  const raw =
    body?.invoiceTo?.parent && typeof body.invoiceTo.parent === "object"
      ? body.invoiceTo.parent
      : body?.parent && typeof body.parent === "object"
        ? body.parent
        : null;

  const selected = normalizeParentInput(raw || {});
  if (parentHasData(selected)) return selected;

  return normalizeParentInput(customer?.parent || {});
}

function buildInvoiceToForParent(customer, parent) {
  const selected = normalizeParentInput(parent);

  return {
    parent: {
      salutation: selected.salutation,
      firstName: selected.firstName,
      lastName: selected.lastName,
      email: selected.email,
      phone: selected.phone,
      phone2: selected.phone2,
    },
    address: {
      street: safeText(customer?.address?.street),
      houseNo: safeText(customer?.address?.houseNo),
      zip: safeText(customer?.address?.zip),
      city: safeText(customer?.address?.city),
    },
  };
}

function buildParentNameFromParent(parent) {
  return (
    [
      safeText(parent?.salutation),
      safeText(parent?.firstName),
      safeText(parent?.lastName),
    ]
      .filter(Boolean)
      .join(" ") || "-"
  );
}

function isCampOffer(offer) {
  return safeText(offer?.type) === "Camp";
}

function isPowerOffer(offer) {
  const cat = safeText(offer?.category).toLowerCase();
  const sub = safeText(offer?.sub_type).toLowerCase();
  return cat === "powertraining" || sub === "powertraining";
}

function isHolidayOffer(offer) {
  const cat = safeText(offer?.category).toLowerCase().replace(/\s+/g, "");
  const text =
    `${safeText(offer?.type)} ${safeText(offer?.sub_type)}`.toLowerCase();

  return (
    cat === "holiday" ||
    cat === "holidayprograms" ||
    /camp|feriencamp|holiday|powertraining|power training/.test(text)
  );
}

function buildChildLine(child, body) {
  const first = safeText(child?.firstName) || safeText(body?.firstName);
  const last = safeText(child?.lastName) || safeText(body?.lastName);
  const gender = normalizeChildGender(child?.gender || body?.childGender);
  const name = [first, last].filter(Boolean).join(" ").trim() || "-";
  return gender ? `${name} (${gender})` : name;
}

function hasRealSibling(body) {
  return (
    body?.hasSibling === true &&
    [
      body?.siblingGender,
      body?.siblingBirthDate,
      body?.siblingFirstName,
      body?.siblingLastName,
      body?.siblingTShirtSize,
    ].some(hasRealValue)
  );
}

function goalkeeperText(flag) {
  return flag === true ? "Ja (+40€)" : "Nein";
}

function buildCampMessage({ offer, customer, parent, child, body }) {
  const lines = [
    "Anmeldung Ferienprogramm",
    `Ferien: ${offerHolidayLabel(offer, body)}`,
    `Zeitraum: ${formatRangeDe(body?.holidayFrom, body?.holidayTo)}`,
    `T-Shirt-Größe (Kind): ${safeText(body?.mainTShirtSize) || "—"}`,
    `Torwartschule (Kind): ${goalkeeperText(body?.mainGoalkeeperSchool)}`,
    `Geschwisterkind: ${hasRealSibling(body) ? "Ja" : "Nein"}`,
    ...(child
      ? [
          `Kind: ${buildChildLine(child, body)}`,
          `Geburtstag: ${formatDateOnlyDe(
            child?.birthDate || body?.childBirthDate,
          )}`,
        ]
      : []),
    // `Kontakt: ${buildParentName(customer)}`,
    `Kontakt: ${buildParentNameFromParent(parent)}`,
    `Adresse: ${buildAddress(customer)}`,
    // `Telefon: ${safeText(customer?.parent?.phone) || "-"}`,
    `Telefon: ${safeText(parent?.phone) || "-"}`,
    `Gutschein: ${safeText(body?.voucher) || "-"}`,
    `Quelle: ${safeText(body?.source) || "-"}`,
  ];

  if (!hasRealSibling(body)) return lines.join("\n");

  return [
    ...lines,
    "Geschwister dazu buchen",
    `Geschlecht (Geschwister): ${normalizeSiblingGender(body?.siblingGender)}`,
    `Geburtstag (Geschwister): ${formatDateOnlyDe(body?.siblingBirthDate)}`,
    `Vorname (Geschwister): ${safeText(body?.siblingFirstName) || "—"}`,
    `Nachname (Geschwister): ${safeText(body?.siblingLastName) || "—"}`,
    `T-Shirt-Größe (Geschwister): ${safeText(body?.siblingTShirtSize) || "—"}`,
    `Torwartschule (Geschwister): ${goalkeeperText(
      body?.siblingGoalkeeperSchool,
    )}`,
  ].join("\n");
}

function buildPowerMessage({ offer, customer, parent, child, body }) {
  return [
    "Anmeldung Ferienprogramm",
    `Ferien: ${offerHolidayLabel(offer, body)}`,
    `Zeitraum: ${formatRangeDe(
      offerHolidayFrom(offer),
      offerHolidayTo(offer),
    )}`,
    "Ausgewählte Tage: —",
    ...(child
      ? [
          `Kind: ${buildChildLine(child, body)}`,
          `Geburtstag: ${formatDateOnlyDe(
            child?.birthDate || body?.childBirthDate,
          )}`,
        ]
      : []),
    `Kontakt: ${buildParentNameFromParent(parent)}`,
    // `Kontakt: ${buildParentName(customer)}`,
    `Adresse: ${buildAddress(customer)}`,
    `Telefon: ${safeText(parent?.phone) || "-"}`,
    // `Telefon: ${safeText(customer?.parent?.phone) || "-"}`,
    `Gutschein: ${safeText(body?.voucher) || "-"}`,
    `Quelle: ${safeText(body?.source) || "-"}`,
  ].join("\n");
}

function buildHolidayMeta({ offer, body, child }) {
  return {
    holidayType: isCampOffer(offer)
      ? "camp"
      : isPowerOffer(offer)
        ? "powertraining"
        : "holiday",
    holidayLabel:
      safeText(body?.holidayLabel) || offerHolidayLabel(offer, body),
    holidayFrom: safeText(body?.holidayFrom) || offerHolidayFrom(offer),
    holidayTo: safeText(body?.holidayTo) || offerHolidayTo(offer),
    mainTShirtSize: safeText(body?.mainTShirtSize),
    mainGoalkeeperSchool: body?.mainGoalkeeperSchool === true,
    hasSibling: hasRealSibling(body),
    siblingGender: normalizeSiblingGender(body?.siblingGender),
    siblingBirthDate: safeText(body?.siblingBirthDate),
    siblingFirstName: safeText(body?.siblingFirstName),
    siblingLastName: safeText(body?.siblingLastName),
    siblingTShirtSize: safeText(body?.siblingTShirtSize),
    siblingGoalkeeperSchool: body?.siblingGoalkeeperSchool === true,
    childGender: normalizeChildGender(body?.childGender || child?.gender),
    childBirthDate: child?.birthDate || body?.childBirthDate || null,
    voucher: safeText(body?.voucher),
    source: safeText(body?.source),
  };
}

// function buildMirrorBookingSubdoc({ booking, offer, child, when }) {
//   return {
//     _id: booking._id,
//     bookingId: booking._id,
//     offerId: offer._id,
//     offerTitle: booking.offerTitle,
//     offerType: booking.offerType,
//     venue: booking.venue,
//     date: when,
//     status: "active",
//     createdAt: booking.createdAt || new Date(),
//     priceAtBooking: booking.priceAtBooking,
//     childUid: safeText(child?.uid),
//     childFirstName: safeText(child?.firstName),
//     childLastName: safeText(child?.lastName),
//   };
// }

function buildMirrorBookingSubdoc({ booking, offer, child, when, parent }) {
  return {
    _id: booking._id,
    bookingId: booking._id,
    offerId: offer._id,
    offerTitle: booking.offerTitle,
    offerType: booking.offerType,
    venue: booking.venue,
    date: when,
    status: "active",
    createdAt: booking.createdAt || new Date(),
    priceAtBooking: booking.priceAtBooking,
    childUid: safeText(child?.uid),
    childFirstName: safeText(child?.firstName),
    childLastName: safeText(child?.lastName),
    parentEmail: safeEmail(parent?.email),
    parentFirstName: safeText(parent?.firstName),
    parentLastName: safeText(parent?.lastName),

    invoiceNo: safeText(booking?.invoiceNo),
    invoiceNumber: safeText(booking?.invoiceNumber),
    invoiceDate: booking?.invoiceDate || null,
  };
}

async function addAdminBooking(req, res, requireOwner, requireId) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const { offerId, date, childUid } = req.body || {};
    if (!offerId || !mongoose.isValidObjectId(offerId)) {
      return res.status(400).json({ error: "Invalid offerId" });
    }

    const offer = await Offer.findOne({ _id: offerId, owner }).lean();
    if (!offer) return res.status(404).json({ error: "Offer not found" });

    const customer = await Customer.findOne({ _id: id, owner });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const selectedParent = selectedParentFromBody(req.body, customer);

    const requestedChildUid = safeText(childUid);
    const isChildBooking = requestedChildUid !== "";
    const pickedChild = pickChildFromCustomer(customer, requestedChildUid);

    if (isChildBooking && !pickedChild) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CHILD_UID",
        message: "Selected childUid not found on customer.",
      });
    }

    const isHoliday = isHolidayOffer(offer);
    const isCamp = isCampOffer(offer);
    const isPower = isPowerOffer(offer);

    // const bookingFirstName = isChildBooking
    //   ? safeText(pickedChild?.firstName)
    //   : safeText(customer?.parent?.firstName);

    // const bookingLastName = isChildBooking
    //   ? safeText(pickedChild?.lastName)
    //   : safeText(customer?.parent?.lastName);

    const bookingFirstName = isChildBooking
      ? safeText(pickedChild?.firstName)
      : safeText(selectedParent?.firstName);

    const bookingLastName = isChildBooking
      ? safeText(pickedChild?.lastName)
      : safeText(selectedParent?.lastName);

    const childBirthDate = isChildBooking
      ? pickedChild?.birthDate || null
      : null;
    const childGender = isChildBooking
      ? normalizeChildGender(req.body?.childGender) ||
        normalizeChildGender(pickedChild?.gender)
      : "";

    const age = isChildBooking ? calcAge(childBirthDate) : undefined;
    const level = isChildBooking ? inferLevel(age) : "";
    const when = date ? new Date(date) : new Date();
    const holidayLabel =
      safeText(req.body?.holidayLabel) || offerHolidayLabel(offer, req.body);
    const holidayFrom =
      safeText(req.body?.holidayFrom) || offerHolidayFrom(offer);
    const holidayTo = safeText(req.body?.holidayTo) || offerHolidayTo(offer);

    const body = {
      offerId: String(offer._id),
      source: "admin_booking",
      skipAutoCheckout: true,
      customerId: String(customer._id),
      childUid: isChildBooking ? safeText(pickedChild?.uid) : "",
      firstName: bookingFirstName,
      lastName: bookingLastName,
      childBirthDate: childBirthDate,
      childGender: childGender,
      // email: safeEmail(customer?.parent?.email),
      email: safeEmail(selectedParent?.email),
      age,
      level,
      date: when.toISOString().slice(0, 10),
      invoiceTo: buildInvoiceToForParent(customer, selectedParent),
      //  invoiceTo: buildInvoiceTo(customer),
      holidayLabel,
      holidayFrom,
      holidayTo,
      voucher: safeText(req.body?.voucher),
      sourceLabel: safeText(req.body?.source),
      mainTShirtSize: safeText(req.body?.mainTShirtSize),
      mainGoalkeeperSchool: req.body?.mainGoalkeeperSchool === true,
      hasSibling: req.body?.hasSibling === true,
      siblingGender: safeText(req.body?.siblingGender),
      siblingBirthDate: safeText(req.body?.siblingBirthDate),
      siblingFirstName: safeText(req.body?.siblingFirstName),
      siblingLastName: safeText(req.body?.siblingLastName),
      siblingTShirtSize: safeText(req.body?.siblingTShirtSize),
      siblingGoalkeeperSchool: req.body?.siblingGoalkeeperSchool === true,
      meta: buildHolidayMeta({
        offer,
        body: {
          ...req.body,
          holidayLabel,
          holidayFrom,
          holidayTo,
          childGender,
        },
        child: pickedChild,
      }),
      message: customer?.notes || "",
    };

    if (isCamp) {
      body.message = buildCampMessage({
        offer,
        customer,
        parent: selectedParent,
        child: pickedChild,
        body,
      });
    }

    if (isPower) {
      body.message = buildPowerMessage({
        offer,
        customer,
        parent: selectedParent,
        child: pickedChild,
        body,
      });
    }

    const result = await createBookingCore({
      body,
      providerId: String(owner),
    });

    if (!result?.data?.ok || !result?.data?.booking?._id) {
      return res.status(result?.status || 500).json(
        result?.data || {
          ok: false,
          error: "Booking creation failed",
        },
      );
    }

    const booking = await Booking.findById(result.data.booking._id);
    if (!booking) {
      return res.status(500).json({
        ok: false,
        error: "Booking was created but could not be reloaded.",
      });
    }

    if (!Array.isArray(customer.bookings)) customer.bookings = [];

    // customer.bookings.push(
    //   buildMirrorBookingSubdoc({
    //     booking,
    //     offer,
    //     child: pickedChild,
    //     when,
    //   }),
    // );

    customer.bookings.push(
      buildMirrorBookingSubdoc({
        booking,
        offer,
        child: pickedChild,
        when,
        parent: selectedParent,
      }),
    );

    const bookingSubdoc =
      customer.bookings.id(booking._id) ||
      customer.bookings[customer.bookings.length - 1] ||
      null;

    if (!isHoliday) {
      await assignInvoiceData({
        booking: bookingSubdoc,
        offer,
        providerId: String(owner),
      });

      booking.invoiceNumber = bookingSubdoc?.invoiceNumber;
      booking.invoiceNo = bookingSubdoc?.invoiceNo;
      booking.invoiceDate = bookingSubdoc?.invoiceDate;
      await booking.save();
    }

    await customer.save();

    return res.status(201).json({
      ok: true,
      booking,
      isHoliday,
    });
  } catch (err) {
    const status = Number(err?.status) || 500;
    const payload = err?.payload || {
      ok: false,
      code: "SERVER",
      error: "Server error",
      detail: String(err?.message || err),
    };

    console.error("[customers/:id/bookings]", err);
    return res.status(status).json(payload);
  }
}

module.exports = { addAdminBooking };
// //routes\customers\handlers\bookings\addAdminBooking.js
// "use strict";

// const mongoose = require("mongoose");

// const { assignInvoiceData } = require("../../../../utils/billing");

// const Customer = require("../../../../models/Customer");
// const Offer = require("../../../../models/Offer");
// const Booking = require("../../../../models/Booking");
// const {
//   createBookingCore,
// } = require("../../../bookings/handlers/createBooking");

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function safeEmail(v) {
//   return safeText(v).toLowerCase();
// }

// function hasRealValue(v) {
//   const t = safeText(v);
//   return t !== "" && t !== "-" && t !== "—";
// }

// function pickChildFromCustomer(customer, uid) {
//   const cu = safeText(uid);
//   const legacy = customer?.child || null;
//   const children = Array.isArray(customer?.children) ? customer.children : [];

//   if (cu) {
//     const hit =
//       children.find((ch) => safeText(ch?.uid) === cu) ||
//       (safeText(legacy?.uid) === cu ? legacy : null);
//     return hit || null;
//   }

//   if (children.length === 1 && safeText(children[0]?.uid)) return children[0];
//   if (safeText(legacy?.uid)) return legacy;
//   return null;
// }

// function offerHolidayLabel(offer, body) {
//   return (
//     safeText(body?.holidayLabel) ||
//     safeText(offer?.holidayWeekName) ||
//     safeText(offer?.holidayLabel) ||
//     safeText(offer?.holidayWeek) ||
//     safeText(offer?.holiday_name) ||
//     safeText(offer?.holidayName) ||
//     safeText(offer?.holiday) ||
//     "-"
//   );
// }

// function normalizeSiblingGender(raw) {
//   const g = safeText(raw).toLowerCase();
//   if (g === "male" || g === "m" || g === "männlich") return "männlich";
//   if (g === "female" || g === "f" || g === "weiblich") return "weiblich";
//   return safeText(raw) || "—";
// }

// function normalizeChildGender(raw) {
//   const g = safeText(raw).toLowerCase();
//   if (g === "male" || g === "m" || g === "männlich") return "männlich";
//   if (g === "female" || g === "f" || g === "weiblich") return "weiblich";
//   return "";
// }

// function calcAge(birthDate) {
//   if (!birthDate) return 10;

//   const d = new Date(birthDate);
//   if (Number.isNaN(d.getTime())) return 10;

//   return Math.max(
//     5,
//     Math.min(
//       19,
//       Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000)),
//     ),
//   );
// }

// function inferLevel(age) {
//   if (age <= 8) return "U8";
//   if (age <= 10) return "U10";
//   if (age <= 12) return "U12";
//   if (age <= 14) return "U14";
//   if (age <= 16) return "U16";
//   return "U18";
// }

// function formatDateOnlyDe(value) {
//   if (!value) return "-";
//   const iso = /T/.test(String(value)) ? String(value) : `${value}T00:00:00`;
//   const d = new Date(iso);
//   if (Number.isNaN(d.getTime())) return safeText(value);

//   return new Intl.DateTimeFormat("de-DE", {
//     day: "2-digit",
//     month: "2-digit",
//     year: "numeric",
//   }).format(d);
// }

// function formatRangeDe(from, to) {
//   const a = formatDateOnlyDe(from);
//   const b = formatDateOnlyDe(to);

//   if (a === "-" && b === "-") return "-";
//   if (a !== "-" && b !== "-") return `${a} – ${b}`;
//   return a !== "-" ? a : b;
// }

// function buildParentName(customer) {
//   const salutation = safeText(customer?.parent?.salutation);
//   const firstName = safeText(customer?.parent?.firstName);
//   const lastName = safeText(customer?.parent?.lastName);
//   return [salutation, firstName, lastName].filter(Boolean).join(" ") || "-";
// }

// function buildAddress(customer) {
//   const street = safeText(customer?.address?.street);
//   const houseNo = safeText(customer?.address?.houseNo);
//   const zip = safeText(customer?.address?.zip);
//   const city = safeText(customer?.address?.city);
//   const left = [street, houseNo].filter(Boolean).join(" ");
//   const right = [zip, city].filter(Boolean).join(" ");
//   return [left, right].filter(Boolean).join(", ") || "-";
// }

// function genderLabel(raw) {
//   const g = safeText(raw).toLowerCase();
//   if (g === "male" || g === "m" || g === "männlich") return "männlich";
//   if (g === "female" || g === "f" || g === "weiblich") return "weiblich";
//   return g || "-";
// }

// function offerHolidayFrom(offer) {
//   return (
//     safeText(offer?.holidayDateFrom) ||
//     safeText(offer?.holidayFrom) ||
//     safeText(offer?.dateFrom) ||
//     safeText(offer?.startDate) ||
//     ""
//   );
// }

// function offerHolidayTo(offer) {
//   return (
//     safeText(offer?.holidayDateTo) ||
//     safeText(offer?.holidayTo) ||
//     safeText(offer?.dateTo) ||
//     safeText(offer?.endDate) ||
//     ""
//   );
// }

// function buildInvoiceTo(customer) {
//   return {
//     parent: {
//       salutation: safeText(customer?.parent?.salutation),
//       firstName: safeText(customer?.parent?.firstName),
//       lastName: safeText(customer?.parent?.lastName),
//       email: safeEmail(customer?.parent?.email),
//       phone: safeText(customer?.parent?.phone),
//       phone2: safeText(customer?.parent?.phone2),
//     },
//     address: {
//       street: safeText(customer?.address?.street),
//       houseNo: safeText(customer?.address?.houseNo),
//       zip: safeText(customer?.address?.zip),
//       city: safeText(customer?.address?.city),
//     },
//   };
// }

// function isCampOffer(offer) {
//   return safeText(offer?.type) === "Camp";
// }

// function isPowerOffer(offer) {
//   const cat = safeText(offer?.category).toLowerCase();
//   const sub = safeText(offer?.sub_type).toLowerCase();
//   return cat === "powertraining" || sub === "powertraining";
// }

// function isHolidayOffer(offer) {
//   const cat = safeText(offer?.category).toLowerCase().replace(/\s+/g, "");
//   const text =
//     `${safeText(offer?.type)} ${safeText(offer?.sub_type)}`.toLowerCase();

//   return (
//     cat === "holiday" ||
//     cat === "holidayprograms" ||
//     /camp|feriencamp|holiday|powertraining|power training/.test(text)
//   );
// }

// function buildChildLine(child, body) {
//   const first = safeText(child?.firstName) || safeText(body?.firstName);
//   const last = safeText(child?.lastName) || safeText(body?.lastName);
//   const gender = normalizeChildGender(child?.gender || body?.childGender);
//   const name = [first, last].filter(Boolean).join(" ").trim() || "-";
//   return gender ? `${name} (${gender})` : name;
// }

// function hasRealSibling(body) {
//   return (
//     body?.hasSibling === true &&
//     [
//       body?.siblingGender,
//       body?.siblingBirthDate,
//       body?.siblingFirstName,
//       body?.siblingLastName,
//       body?.siblingTShirtSize,
//     ].some(hasRealValue)
//   );
// }

// function goalkeeperText(flag) {
//   return flag === true ? "Ja (+40€)" : "Nein";
// }

// function buildCampMessage({ offer, customer, child, body }) {
//   const lines = [
//     "Anmeldung Ferienprogramm",
//     `Ferien: ${offerHolidayLabel(offer, body)}`,
//     `Zeitraum: ${formatRangeDe(body?.holidayFrom, body?.holidayTo)}`,
//     `T-Shirt-Größe (Kind): ${safeText(body?.mainTShirtSize) || "—"}`,
//     `Torwartschule (Kind): ${goalkeeperText(body?.mainGoalkeeperSchool)}`,
//     `Geschwisterkind: ${hasRealSibling(body) ? "Ja" : "Nein"}`,
//     `Kind: ${buildChildLine(child, body)}`,
//     `Geburtstag: ${formatDateOnlyDe(child?.birthDate || body?.childBirthDate)}`,
//     `Kontakt: ${buildParentName(customer)}`,
//     `Adresse: ${buildAddress(customer)}`,
//     `Telefon: ${safeText(customer?.parent?.phone) || "-"}`,
//     `Gutschein: ${safeText(body?.voucher) || "-"}`,
//     `Quelle: ${safeText(body?.source) || "-"}`,
//   ];

//   if (!hasRealSibling(body)) return lines.join("\n");

//   return [
//     ...lines,
//     "Geschwister dazu buchen",
//     `Geschlecht (Geschwister): ${normalizeSiblingGender(body?.siblingGender)}`,
//     `Geburtstag (Geschwister): ${formatDateOnlyDe(body?.siblingBirthDate)}`,
//     `Vorname (Geschwister): ${safeText(body?.siblingFirstName) || "—"}`,
//     `Nachname (Geschwister): ${safeText(body?.siblingLastName) || "—"}`,
//     `T-Shirt-Größe (Geschwister): ${safeText(body?.siblingTShirtSize) || "—"}`,
//     `Torwartschule (Geschwister): ${goalkeeperText(
//       body?.siblingGoalkeeperSchool,
//     )}`,
//   ].join("\n");
// }

// function buildPowerMessage({ offer, customer, child, body }) {
//   const kind = buildChildLine(child, body);

//   return [
//     "Anmeldung Ferienprogramm",
//     `Ferien: ${offerHolidayLabel(offer, body)}`,
//     `Zeitraum: ${formatRangeDe(
//       offerHolidayFrom(offer),
//       offerHolidayTo(offer),
//     )}`,
//     "Ausgewählte Tage: —",
//     `Kind: ${kind || "-"}`,
//     `Geburtstag: ${formatDateOnlyDe(child?.birthDate || body?.childBirthDate)}`,
//     `Kontakt: ${buildParentName(customer)}`,
//     `Adresse: ${buildAddress(customer)}`,
//     `Telefon: ${safeText(customer?.parent?.phone) || "-"}`,
//     `Gutschein: ${safeText(body?.voucher) || "-"}`,
//     `Quelle: ${safeText(body?.source) || "-"}`,
//   ].join("\n");
// }

// function buildHolidayMeta({ offer, body, child }) {
//   return {
//     holidayType: isCampOffer(offer)
//       ? "camp"
//       : isPowerOffer(offer)
//         ? "powertraining"
//         : "holiday",
//     holidayLabel:
//       safeText(body?.holidayLabel) || offerHolidayLabel(offer, body),
//     holidayFrom: safeText(body?.holidayFrom) || offerHolidayFrom(offer),
//     holidayTo: safeText(body?.holidayTo) || offerHolidayTo(offer),
//     mainTShirtSize: safeText(body?.mainTShirtSize),
//     mainGoalkeeperSchool: body?.mainGoalkeeperSchool === true,
//     hasSibling: hasRealSibling(body),
//     siblingGender: normalizeSiblingGender(body?.siblingGender),
//     siblingBirthDate: safeText(body?.siblingBirthDate),
//     siblingFirstName: safeText(body?.siblingFirstName),
//     siblingLastName: safeText(body?.siblingLastName),
//     siblingTShirtSize: safeText(body?.siblingTShirtSize),
//     siblingGoalkeeperSchool: body?.siblingGoalkeeperSchool === true,
//     childGender: normalizeChildGender(body?.childGender || child?.gender),
//     childBirthDate: child?.birthDate || body?.childBirthDate || null,
//     voucher: safeText(body?.voucher),
//     source: safeText(body?.source),
//   };
// }

// function buildMirrorBookingSubdoc({ booking, offer, child, when }) {
//   return {
//     _id: booking._id,
//     bookingId: booking._id,
//     offerId: offer._id,
//     offerTitle: booking.offerTitle,
//     offerType: booking.offerType,
//     venue: booking.venue,
//     date: when,
//     status: "active",
//     createdAt: booking.createdAt || new Date(),
//     priceAtBooking: booking.priceAtBooking,
//     childUid: safeText(child?.uid),
//     childFirstName: safeText(child?.firstName),
//     childLastName: safeText(child?.lastName),
//   };
// }

// async function addAdminBooking(req, res, requireOwner, requireId) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const id = requireId(req, res);
//     if (!id) return;

//     const { offerId, date, childUid } = req.body || {};
//     if (!offerId || !mongoose.isValidObjectId(offerId)) {
//       return res.status(400).json({ error: "Invalid offerId" });
//     }

//     const offer = await Offer.findOne({ _id: offerId, owner }).lean();
//     if (!offer) return res.status(404).json({ error: "Offer not found" });

//     const customer = await Customer.findOne({ _id: id, owner });
//     if (!customer) return res.status(404).json({ error: "Customer not found" });

//     const children = Array.isArray(customer.children) ? customer.children : [];
//     const multiChild = children.filter((c) => safeText(c?.uid)).length >= 2;
//     const pickedChild = pickChildFromCustomer(customer, childUid);

//     if (multiChild && !safeText(childUid)) {
//       return res.status(400).json({
//         ok: false,
//         error: "MISSING_CHILD_UID",
//         message: "childUid is required for multi-child customers.",
//       });
//     }

//     if (!pickedChild) {
//       return res.status(400).json({
//         ok: false,
//         error: "INVALID_CHILD_UID",
//         message: "Selected childUid not found on customer.",
//       });
//     }

//     const isHoliday = isHolidayOffer(offer);
//     const isCamp = isCampOffer(offer);
//     const isPower = isPowerOffer(offer);
//     const age = calcAge(pickedChild?.birthDate);
//     const level = inferLevel(age);
//     const when = date ? new Date(date) : new Date();
//     const holidayLabel =
//       safeText(req.body?.holidayLabel) || offerHolidayLabel(offer, req.body);
//     const holidayFrom =
//       safeText(req.body?.holidayFrom) || offerHolidayFrom(offer);
//     const holidayTo = safeText(req.body?.holidayTo) || offerHolidayTo(offer);

//     const body = {
//       offerId: String(offer._id),
//       source: "admin_booking",
//       skipAutoCheckout: true,
//       customerId: String(customer._id),
//       childUid: safeText(pickedChild?.uid),
//       firstName: safeText(pickedChild?.firstName),
//       lastName: safeText(pickedChild?.lastName),
//       childBirthDate: pickedChild?.birthDate || null,
//       childGender:
//         normalizeChildGender(req.body?.childGender) ||
//         normalizeChildGender(pickedChild?.gender),
//       email: safeEmail(customer?.parent?.email),
//       age,
//       level,
//       date: when.toISOString().slice(0, 10),
//       invoiceTo: buildInvoiceTo(customer),
//       holidayLabel,
//       holidayFrom,
//       holidayTo,
//       voucher: safeText(req.body?.voucher),
//       sourceLabel: safeText(req.body?.source),
//       // source: safeText(req.body?.source),
//       mainTShirtSize: safeText(req.body?.mainTShirtSize),
//       mainGoalkeeperSchool: req.body?.mainGoalkeeperSchool === true,
//       hasSibling: req.body?.hasSibling === true,
//       siblingGender: safeText(req.body?.siblingGender),
//       siblingBirthDate: safeText(req.body?.siblingBirthDate),
//       siblingFirstName: safeText(req.body?.siblingFirstName),
//       siblingLastName: safeText(req.body?.siblingLastName),
//       siblingTShirtSize: safeText(req.body?.siblingTShirtSize),
//       siblingGoalkeeperSchool: req.body?.siblingGoalkeeperSchool === true,
//       meta: buildHolidayMeta({
//         offer,
//         body: {
//           ...req.body,
//           holidayLabel,
//           holidayFrom,
//           holidayTo,
//           childGender:
//             normalizeChildGender(req.body?.childGender) ||
//             normalizeChildGender(pickedChild?.gender),
//         },
//         child: pickedChild,
//       }),
//       message: customer?.notes || "",
//     };

//     if (isCamp) {
//       body.message = buildCampMessage({
//         offer,
//         customer,
//         child: pickedChild,
//         body,
//       });
//     }

//     if (isPower) {
//       body.message = buildPowerMessage({
//         offer,
//         customer,
//         child: pickedChild,
//         body,
//       });
//     }

//     const result = await createBookingCore({
//       body,
//       providerId: String(owner),
//     });

//     if (!result?.data?.ok || !result?.data?.booking?._id) {
//       return res.status(result?.status || 500).json(
//         result?.data || {
//           ok: false,
//           error: "Booking creation failed",
//         },
//       );
//     }

//     const booking = await Booking.findById(result.data.booking._id);
//     if (!booking) {
//       return res.status(500).json({
//         ok: false,
//         error: "Booking was created but could not be reloaded.",
//       });
//     }

//     if (!Array.isArray(customer.bookings)) customer.bookings = [];

//     customer.bookings.push(
//       buildMirrorBookingSubdoc({
//         booking,
//         offer,
//         child: pickedChild,
//         when,
//       }),
//     );

//     const bookingSubdoc =
//       customer.bookings.id(booking._id) ||
//       customer.bookings[customer.bookings.length - 1] ||
//       null;

//     if (!isHoliday) {
//       await assignInvoiceData({
//         booking: bookingSubdoc,
//         offer,
//         providerId: String(owner),
//       });

//       booking.invoiceNumber = bookingSubdoc?.invoiceNumber;
//       booking.invoiceNo = bookingSubdoc?.invoiceNo;
//       booking.invoiceDate = bookingSubdoc?.invoiceDate;
//       await booking.save();
//     }

//     await customer.save();

//     return res.status(201).json({
//       ok: true,
//       booking,
//       isHoliday,
//     });
//   } catch (err) {
//     const status = Number(err?.status) || 500;
//     const payload = err?.payload || {
//       ok: false,
//       code: "SERVER",
//       error: "Server error",
//       detail: String(err?.message || err),
//     };

//     console.error("[customers/:id/bookings]", err);
//     return res.status(status).json(payload);
//   }
// }

// module.exports = { addAdminBooking };
