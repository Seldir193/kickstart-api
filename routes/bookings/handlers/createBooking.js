//routes\bookings\handlers\createBooking.js
"use strict";

const crypto = require("crypto");

const Booking = require("../../../models/Booking");
const Offer = require("../../../models/Offer");

const { childHasActiveWeeklyBooking } = require("../../../utils/relations");

const {
  sendBookingAckEmail,
  sendBookingConfirmedEmail,
  sendBookingProcessingEmail,
} = require("../../../utils/mailer");

const { validate } = require("../helpers/validate");
const { escapeRegex } = require("../helpers/regex");
const { prorateForStart } = require("../helpers/pricing");
const {
  detectSiblingFlag,
  isNonTrialProgram,
  isHolidayProgram,
  isCampOffer,
  isPowertrainingOffer,
  isWeeklyOffer,
  isIndividualOffer,
  isClubProgramOffer,
} = require("../helpers/offerTypes");

const {
  createPaymentCheckout,
} = require("../../payments/stripe/lib/createPaymentCheckout");
const {
  createSubscriptionCheckout,
} = require("../../payments/stripe/lib/createSubscriptionCheckout");
const Customer = require("../../../models/Customer");

const Voucher = require("../../../models/Voucher");

function safeText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

function safeEmail(v) {
  return safeText(v).toLowerCase();
}

function bookingSourceFromBody(body) {
  return safeText(body?.source) === "admin_booking"
    ? "admin_booking"
    : "online_request";
}

function normLower(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase();
}

function normName(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase();
}

function hasText(v) {
  return String(v ?? "").trim() !== "";
}

function sameName(a, b) {
  return normName(a) === normName(b);
}

function pickFirst(...vals) {
  for (const v of vals) {
    const s = safeText(v);
    if (s) return s;
  }
  return "";
}

function metaFromBody(body) {
  return body?.meta && typeof body.meta === "object" ? body.meta : {};
}

function normalizeGender(raw) {
  const g = safeText(raw).toLowerCase();
  if (g === "male" || g === "m" || g === "männlich") return "männlich";
  if (g === "female" || g === "f" || g === "weiblich") return "weiblich";
  return safeText(raw);
}

function parseBool(raw) {
  const t = safeText(raw).toLowerCase();
  return (
    t === "true" ||
    t === "1" ||
    t === "yes" ||
    t === "ja" ||
    t === "on" ||
    raw === true
  );
}

function holidayLabelFromOffer(offer) {
  return pickFirst(
    offer?.holidayWeekName,
    offer?.holidayLabel,
    offer?.holidayWeek,
    offer?.holiday_name,
    offer?.holidayName,
    offer?.holiday,
  );
}

function holidayFromOffer(offer) {
  return pickFirst(
    offer?.holidayDateFrom,
    offer?.holidayFrom,
    offer?.dateFrom,
    offer?.startDate,
  );
}

function holidayToOffer(offer) {
  return pickFirst(
    offer?.holidayDateTo,
    offer?.holidayTo,
    offer?.dateTo,
    offer?.endDate,
  );
}

function normalizeVoucherRaw(v) {
  return safeText(v).toUpperCase();
}

function parseLabeledValue(message, label) {
  const t = String(message || "");
  const m = t.match(new RegExp(`${label}\\s*:\\s*([^\\n]+)`, "i"));
  return m ? String(m[1] || "").trim() : "";
}

function buildHolidayMetaFromBody(body, offer) {
  const msg = safeText(body?.message);
  const existingMeta = metaFromBody(body);

  return {
    holidayType: pickFirst(
      existingMeta?.holidayType,
      body?.holidayType,
      isCampOffer(offer)
        ? "camp"
        : isPowertrainingOffer(offer)
          ? "powertraining"
          : isHolidayProgram(offer)
            ? "holiday"
            : "",
    ),
    holidayLabel: pickFirst(
      existingMeta?.holidayLabel,
      body?.holidayLabel,
      body?.holidayWeekName,
      body?.holidayName,
      body?.holiday,
      parseLabeledValue(msg, "Ferien"),
      holidayLabelFromOffer(offer),
    ),
    holidayFrom: pickFirst(
      existingMeta?.holidayFrom,
      body?.holidayFrom,
      body?.dateFrom,
      body?.startDate,
      holidayFromOffer(offer),
    ),
    holidayTo: pickFirst(
      existingMeta?.holidayTo,
      body?.holidayTo,
      body?.dateTo,
      body?.endDate,
      holidayToOffer(offer),
    ),
    mainTShirtSize: pickFirst(
      existingMeta?.mainTShirtSize,
      body?.mainTShirtSize,
      body?.childTShirtSize,
      body?.tShirtSize,
      body?.shirtSize,
      parseLabeledValue(msg, "T-Shirt-Größe (Kind)"),
    ),
    mainGoalkeeperSchool:
      existingMeta?.mainGoalkeeperSchool === true ||
      body?.mainGoalkeeperSchool === true ||
      body?.childGoalkeeperSchool === true ||
      parseBool(body?.goalkeeperSchool) ||
      parseBool(parseLabeledValue(msg, "Torwartschule (Kind)")),
    hasSibling:
      existingMeta?.hasSibling === true ||
      detectSiblingFlag(body) ||
      parseBool(body?.hasSibling) ||
      parseBool(body?.sibling) ||
      parseBool(parseLabeledValue(msg, "Geschwisterkind")),
    siblingGender: pickFirst(
      normalizeGender(existingMeta?.siblingGender),
      normalizeGender(body?.siblingGender),
      normalizeGender(body?.siblingSex),
      normalizeGender(body?.sibling?.gender),
      normalizeGender(parseLabeledValue(msg, "Geschlecht (Geschwister)")),
    ),
    siblingBirthDate: pickFirst(
      existingMeta?.siblingBirthDate,
      body?.siblingBirthDate,
      body?.siblingBirthday,
      body?.siblingDateOfBirth,
      body?.sibling?.birthDate,
      parseLabeledValue(msg, "Geburtstag (Geschwister)"),
    ),
    siblingFirstName: pickFirst(
      existingMeta?.siblingFirstName,
      body?.siblingFirstName,
      body?.siblingFirstname,
      body?.sibling?.firstName,
      parseLabeledValue(msg, "Vorname (Geschwister)"),
    ),
    siblingLastName: pickFirst(
      existingMeta?.siblingLastName,
      body?.siblingLastName,
      body?.siblingLastname,
      body?.sibling?.lastName,
      parseLabeledValue(msg, "Nachname (Geschwister)"),
    ),
    siblingTShirtSize: pickFirst(
      existingMeta?.siblingTShirtSize,
      body?.siblingTShirtSize,
      body?.siblingShirtSize,
      body?.siblingTshirtSize,
      body?.sibling?.tShirtSize,
      parseLabeledValue(msg, "T-Shirt-Größe (Geschwister)"),
    ),
    siblingGoalkeeperSchool:
      existingMeta?.siblingGoalkeeperSchool === true ||
      body?.siblingGoalkeeperSchool === true ||
      body?.sibling?.goalkeeperSchool === true ||
      parseBool(body?.siblingGoalkeeper) ||
      parseBool(parseLabeledValue(msg, "Torwartschule (Geschwister)")),
    childGender: pickFirst(
      normalizeGender(existingMeta?.childGender),
      normalizeGender(body?.childGender),
      normalizeGender(body?.gender),
      normalizeGender(body?.child?.gender),
    ),
    childBirthDate: pickFirst(
      existingMeta?.childBirthDate,
      body?.childBirthDate,
      body?.birthDate,
      body?.child?.birthDate,
    ),
    voucher: normalizeVoucherRaw(
      pickFirst(
        existingMeta?.voucher,
        existingMeta?.voucherCode,
        body?.voucher,
        body?.voucherCode,
        parseLabeledValue(msg, "Gutschein"),
        parseLabeledValue(msg, "Gutscheincode"),
      ),
    ),

    voucherCode: normalizeVoucherRaw(
      pickFirst(
        existingMeta?.voucherCode,
        existingMeta?.voucher,
        body?.voucherCode,
        body?.voucher,
        parseLabeledValue(msg, "Gutschein"),
        parseLabeledValue(msg, "Gutscheincode"),
      ),
    ),
  };
}

async function assertParentEmailNameMatch({
  ownerId,
  invoiceTo,
  fallbackEmail,
}) {
  const emailLower = normLower(invoiceTo?.parent?.email || fallbackEmail);
  if (!emailLower) return;

  const existing = await Customer.findOne({
    owner: ownerId,
    emailLower,
  })
    .select("parent.firstName parent.lastName emailLower")
    .lean();

  if (!existing) return;

  const exFirst = String(existing?.parent?.firstName || "").trim();
  const exLast = String(existing?.parent?.lastName || "").trim();
  const inFirst = String(invoiceTo?.parent?.firstName || "").trim();
  const inLast = String(invoiceTo?.parent?.lastName || "").trim();

  if (!hasText(exFirst) || !hasText(exLast)) return;
  if (!hasText(inFirst) || !hasText(inLast)) return;

  const okFirst = sameName(exFirst, inFirst);
  const okLast = sameName(exLast, inLast);

  if (!okFirst || !okLast) {
    throw httpError(409, {
      ok: false,
      code: "EMAIL_PARENT_NAME_MISMATCH",
      error:
        "Email already exists with a different parent name. Please use the original parent name or a different email.",
    });
  }
}

function buildInvoiceToParent(body, invParent, msg) {
  const salutation = pickFirst(
    invParent.salutation,
    body?.salutation,
    body?.parentSalutation,
    body?.parent?.salutation,
    parseLabeledValue(msg, "Anrede"),
  );

  const firstName = pickFirst(
    invParent.firstName,
    body?.parentFirstName,
    body?.parent?.firstName,
    body?.invoiceParentFirstName,
    body?.invoiceToParentFirstName,
    parseLabeledValue(msg, "Eltern Vorname"),
    parseLabeledValue(msg, "Vorname"),
  );

  const lastName = pickFirst(
    invParent.lastName,
    body?.parentLastName,
    body?.parent?.lastName,
    body?.invoiceParentLastName,
    body?.invoiceToParentLastName,
    parseLabeledValue(msg, "Eltern Nachname"),
    parseLabeledValue(msg, "Nachname"),
  );

  const email = pickFirst(
    invParent.email,
    body?.parentEmail,
    body?.parent?.email,
    body?.invoiceParentEmail,
    body?.invoiceToParentEmail,
    parseLabeledValue(msg, "E-Mail"),
    parseLabeledValue(msg, "Email"),
    body?.email,
  );

  const phone = pickFirst(
    invParent.phone,
    body?.parentPhone,
    body?.parent?.phone,
    body?.invoiceParentPhone,
    body?.invoiceToParentPhone,
    parseLabeledValue(msg, "Telefon"),
  );

  const phone2 = pickFirst(
    invParent.phone2,
    body?.parentPhone2,
    body?.parent?.phone2,
  );

  return {
    salutation,
    firstName,
    lastName,
    email: safeEmail(email),
    phone,
    phone2,
  };
}

function parseAddressCompact(raw) {
  if (typeof raw !== "string") {
    return { street: "", houseNo: "", zip: "", city: "" };
  }

  const s = raw.trim();
  if (!s) return { street: "", houseNo: "", zip: "", city: "" };

  const mZip = s.match(/(\d{4,5})\s+([^,]+)$/);
  const zip = mZip ? mZip[1] : "";
  const city = mZip ? safeText(mZip[2]) : "";
  const head = safeText(
    s.replace(mZip ? mZip[0] : "", "").replace(/[,]+$/g, ""),
  );
  const mStreet = head.match(/^(.+?)\s+(\d+\w*)$/);
  const street = mStreet ? safeText(mStreet[1]) : head;
  const houseNo = mStreet ? safeText(mStreet[2]) : "";

  return { street, houseNo, zip, city };
}

function buildInvoiceToAddress(body, invAddr, msg) {
  const addrObj =
    body?.address && typeof body.address === "object" ? body.address : null;

  const pAddrObj =
    body?.parentAddress && typeof body.parentAddress === "object"
      ? body.parentAddress
      : null;

  const compact = pickFirst(
    body?.invoiceAddress,
    parseLabeledValue(msg, "Adresse"),
    typeof body?.address === "string" ? body.address : "",
  );

  const parsed = parseAddressCompact(compact);

  const street = pickFirst(
    invAddr.street,
    addrObj?.street,
    pAddrObj?.street,
    body?.street,
    body?.addressStreet,
    body?.parentStreet,
    body?.invoiceStreet,
    parsed.street,
    parseLabeledValue(msg, "Straße"),
  );

  const houseNo = pickFirst(
    invAddr.houseNo,
    addrObj?.houseNo,
    pAddrObj?.houseNo,
    body?.houseNo,
    body?.houseNumber,
    body?.addressHouseNo,
    body?.parentHouseNo,
    body?.invoiceHouseNo,
    parsed.houseNo,
    parseLabeledValue(msg, "Hausnummer"),
  );

  const zip = pickFirst(
    invAddr.zip,
    addrObj?.zip,
    pAddrObj?.zip,
    body?.zip,
    body?.postalCode,
    body?.addressZip,
    body?.parentZip,
    body?.invoiceZip,
    parsed.zip,
    parseLabeledValue(msg, "PLZ"),
  );

  const city = pickFirst(
    invAddr.city,
    addrObj?.city,
    pAddrObj?.city,
    body?.city,
    body?.addressCity,
    body?.parentCity,
    body?.invoiceCity,
    parsed.city,
    parseLabeledValue(msg, "Ort"),
    parseLabeledValue(msg, "Stadt"),
  );

  return { street, houseNo, zip, city };
}

function buildInvoiceToFromBody(body) {
  const inv =
    body && typeof body.invoiceTo === "object" ? body.invoiceTo : null;
  const invParent = inv && typeof inv.parent === "object" ? inv.parent : {};
  const invAddr = inv && typeof inv.address === "object" ? inv.address : {};
  const msg = safeText(body?.message);

  return {
    parent: buildInvoiceToParent(body, invParent, msg),
    address: buildInvoiceToAddress(body, invAddr, msg),
  };
}

function httpError(status, payload) {
  const e = new Error(payload?.error || payload?.code || "Error");
  e.status = status;
  e.payload = payload;
  return e;
}

function requireOfferId(body) {
  if (body?.offerId) return String(body.offerId);
  throw httpError(400, {
    ok: false,
    code: "VALIDATION",
    error: "offerId is required",
  });
}

async function loadOffer(offerId) {
  const offer = await Offer.findById(String(offerId))
    .select(
      "_id owner title type category sub_type location onlineActive price holidayWeekName holidayLabel holidayWeek holiday_name holidayName holiday holidayDateFrom holidayFrom dateFrom startDate holidayDateTo holidayTo dateTo endDate",
    )
    .lean();

  if (!offer) throw httpError(400, { ok: false, error: "Offer not found" });
  if (offer.onlineActive === false) {
    throw httpError(400, { ok: false, error: "Offer not bookable" });
  }

  return offer;
}

function assertProviderMatch(providerId, offer) {
  const pid = safeText(providerId);
  if (pid && String(offer.owner) !== pid) {
    throw httpError(403, {
      ok: false,
      error: "Offer does not belong to this provider",
    });
  }
}

function bookingNames(body) {
  return { first: safeText(body?.firstName), last: safeText(body?.lastName) };
}

function birthDateFromBody(body) {
  return (
    body?.childBirthDate || body?.birthDate || body?.child?.birthDate || null
  );
}

async function hasWeekly({ offer, first, last, birthDateRaw, parentEmail }) {
  return childHasActiveWeeklyBooking({
    ownerId: offer.owner,
    firstName: first,
    lastName: last,
    birthDate: birthDateRaw || null,
    parentEmail,
  });
}

function normalizeKey(v) {
  return safeText(v).toLowerCase();
}

function joinedOfferText(offer, doc) {
  const category = normalizeKey(offer?.category);
  const type = normalizeKey(offer?.type);
  const subType = normalizeKey(offer?.sub_type);
  const offerType = normalizeKey(doc?.offerType);
  const offerTitle = normalizeKey(doc?.offerTitle);

  return [category, type, subType, offerType, offerTitle]
    .filter(Boolean)
    .join(" ");
}

function isRentACoachKey(text) {
  return /rent[\s_-]*a[\s_-]*coach|rentacoach/.test(text);
}

function isCoachEducationKey(text) {
  return /coach[\s_-]*education|coacheducation/.test(text);
}

function isTrainingCampKey(text) {
  return /trainings?[\s_-]*camps?/.test(text) || /\bcamp\b/.test(text);
}

function clubProgramCourseKey(offer, doc) {
  const text = joinedOfferText(offer, doc);
  console.log("DEBUG clubProgramCourseKey text", text);

  if (isRentACoachKey(text)) return "clubprogram:rentacoach";
  if (isCoachEducationKey(text)) return "clubprogram:coacheducation";
  if (isTrainingCampKey(text)) return "clubprogram:trainingcamp";

  return "";
}

async function loadOfferMap(ids) {
  const offerIds = ids.filter(Boolean);
  if (!offerIds.length) return new Map();

  const offers = await Offer.find({ _id: { $in: offerIds } })
    .select("_id category type sub_type title")
    .lean();

  return new Map(offers.map((offer) => [String(offer._id), offer]));
}

async function findDuplicateBooking({
  offer,
  first,
  last,
  date,
  restrictByDate,
}) {
  if (!first || !last) return null;

  const query = {
    owner: offer.owner,
    offerId: offer._id,
    firstName: { $regex: `^${escapeRegex(first)}$`, $options: "i" },
    lastName: { $regex: `^${escapeRegex(last)}$`, $options: "i" },
    status: { $ne: "deleted" },
  };

  if (restrictByDate && date) {
    query.date = String(date);
  }

  return Booking.findOne(query);
}

function isApprovedForRebook(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
  const approvedAt = String(meta.paymentApprovedAt || "").trim();
  const subEligible = meta.subscriptionEligible === true;
  return !!approvedAt || subEligible;
}

function bookingMeta(booking) {
  return booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
}

function isFutureEndDate(value) {
  if (!value) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return d > startOfToday();
}

function isRevokedOrClosedBooking(booking) {
  const meta = bookingMeta(booking);
  const status = safeText(booking?.status);
  const paymentStatus = safeText(booking?.paymentStatus);
  const isWeeklyEligible = meta.subscriptionEligible === true;

  if (paymentStatus === "returned") return true;
  if (status === "storno") return true;
  if (hasText(meta.revocationProcessedAt)) return true;
  if (hasText(meta.stripeRefundId)) return true;

  if (status === "cancelled") {
    if (isWeeklyEligible) {
      return !isFutureEndDate(booking?.endDate);
    }
    return true;
  }

  return false;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function isEndedOnOrBeforeToday(dateValue) {
  if (!dateValue) return false;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return false;
  return d <= startOfToday();
}

function isExpiredWeeklyBooking(booking, offer) {
  const { isWeekly } = weeklyFlags(offer);
  if (!isWeekly) return false;
  return isEndedOnOrBeforeToday(booking?.endDate);
}

async function findBlockingClubProgramDuplicate({ offer, first, last, email }) {
  const courseKey = clubProgramCourseKey(offer, null);
  if (!courseKey || !first || !last || !email) return null;

  const docs = await Booking.find({
    owner: offer.owner,
    email: safeEmail(email),
    firstName: { $regex: `^${escapeRegex(first)}$`, $options: "i" },
    lastName: { $regex: `^${escapeRegex(last)}$`, $options: "i" },
    status: { $ne: "deleted" },
  })
    .sort({ createdAt: -1 })
    .select(
      "_id offerId offerType offerTitle status paymentStatus endDate meta",
    );

  const offerIds = docs.map((doc) => String(doc.offerId || "")).filter(Boolean);
  const offerMap = await loadOfferMap(offerIds);

  console.log("DEBUG duplicate search", {
    owner: String(offer.owner),
    first,
    last,
    email,
    courseKey,
  });
  console.log(
    "DEBUG duplicate docs",
    docs.map((doc) => {
      const docOffer = offerMap.get(String(doc.offerId || ""));
      return {
        id: String(doc._id),
        offerId: String(doc.offerId || ""),
        offerType: doc.offerType,
        offerTitle: doc.offerTitle,
        status: doc.status,
        paymentStatus: doc.paymentStatus,
        key: clubProgramCourseKey(docOffer, doc),
        closed: isRevokedOrClosedBooking(doc),
        hasOffer: !!docOffer,
      };
    }),
  );

  return (
    docs.find((doc) => {
      const docOffer = offerMap.get(String(doc.offerId || ""));
      const docKey = clubProgramCourseKey(docOffer, doc);
      const sameOffer = String(doc.offerId || "") === String(offer._id || "");

      if (docKey !== courseKey) return false;
      if (!sameOffer) return false;
      return !isRevokedOrClosedBooking(doc);
    }) || null
  );
}

async function assertNoDuplicate({ offer, first, last, date, restrictByDate }) {
  if (!first || !last) return;

  const query = {
    offerId: offer._id,
    firstName: { $regex: `^${escapeRegex(first)}$`, $options: "i" },
    lastName: { $regex: `^${escapeRegex(last)}$`, $options: "i" },
    status: { $ne: "deleted" },
  };

  if (restrictByDate && date) {
    query.date = String(date);
  }

  const exists = await Booking.findOne(query).lean();
  if (!exists) return;

  throw httpError(409, {
    ok: false,
    code: "DUPLICATE",
    errors: {
      firstName:
        "A booking with this first/last name already exists for this offer.",
      lastName: "Please use different names or contact us.",
    },
  });
}

function weeklyFlags(offer) {
  const cat = String(offer?.category || "").trim();
  const type = String(offer?.type || "").trim();
  const sub = String(offer?.sub_type || "")
    .trim()
    .toLowerCase();

  const isExplicitNonWeekly =
    cat === "RentACoach" ||
    cat === "ClubPrograms" ||
    cat === "Individual" ||
    cat === "Powertraining" ||
    cat === "Holiday" ||
    cat === "HolidayPrograms" ||
    sub.startsWith("rentacoach") ||
    sub.includes("coacheducation") ||
    sub.includes("trainingcamp") ||
    sub.includes("trainingscamp");

  const isWeekly =
    !isExplicitNonWeekly &&
    (cat === "Weekly" || type === "Foerdertraining" || type === "Kindergarten");

  const monthlyPrice =
    isWeekly && typeof offer.price === "number" ? offer.price : null;

  return { isWeekly, monthlyPrice };
}

function computeProrate({ isWeekly, monthlyPrice, date }) {
  if (!isWeekly || monthlyPrice == null) {
    return {
      daysInMonth: null,
      daysRemaining: null,
      factor: null,
      firstMonthPrice: null,
      monthlyPrice: null,
    };
  }

  return prorateForStart(date, monthlyPrice);
}

// function computePrices({ isWeekly, monthlyPrice, finalPrice, pro }) {
//   return {
//     currency: "EUR",
//     priceAtBooking: finalPrice != null ? finalPrice : undefined,
//     priceMonthly:
//       isWeekly && monthlyPrice != null
//         ? monthlyPrice
//         : finalPrice != null
//           ? finalPrice
//           : null,
//     priceFirstMonth:
//       isWeekly && pro?.firstMonthPrice != null
//         ? Number(pro.firstMonthPrice)
//         : null,
//   };
// }

function computePrices({ isWeekly, monthlyPrice, finalPrice, pro }) {
  return {
    currency: "EUR",
    priceAtBooking: finalPrice != null ? finalPrice : undefined,
    priceMonthly: isWeekly && monthlyPrice != null ? monthlyPrice : null,
    priceFirstMonth:
      isWeekly && pro?.firstMonthPrice != null
        ? Number(pro.firstMonthPrice)
        : null,
  };
}

function isVoucherRelevantOneTimeOffer(offer) {
  const category = safeText(offer?.category);
  return (
    category === "Holiday" ||
    category === "RentACoach" ||
    category === "ClubPrograms" ||
    category === "Individual"
  );
}

function childVoucherQuery({ body, first, last, birthDateRaw, email }) {
  const childUid = safeText(body?.childUid);

  if (childUid) {
    return { childUid };
  }

  const query = {
    firstName: { $regex: `^${escapeRegex(first)}$`, $options: "i" },
    lastName: { $regex: `^${escapeRegex(last)}$`, $options: "i" },
  };

  const birthDate = safeText(
    body?.childBirthDate || birthDateRaw || body?.child?.birthDate,
  );

  if (birthDate) query["meta.childBirthDate"] = birthDate;
  if (email) query.email = safeEmail(email);

  return query;
}

async function findVoucherUsageForChild({
  ownerId,
  voucherCode,
  body,
  first,
  last,
  birthDateRaw,
  email,
}) {
  if (!voucherCode) return null;

  return Booking.findOne({
    owner: ownerId,
    status: { $ne: "deleted" },
    ...childVoucherQuery({
      body,
      first,
      last,
      birthDateRaw,
      email,
    }),
    $or: [{ "meta.voucherCode": voucherCode }, { "meta.voucher": voucherCode }],
  })
    .sort({ createdAt: -1 })
    .select("_id status paymentStatus endDate meta");
}

async function assertVoucherUnusedForChild({
  ownerId,
  voucherCode,
  body,
  first,
  last,
  birthDateRaw,
  email,
}) {
  if (!voucherCode) return;

  const existing = await findVoucherUsageForChild({
    ownerId,
    voucherCode,
    body,
    first,
    last,
    birthDateRaw,
    email,
  });

  if (!existing) return;
  if (isRevokedOrClosedBooking(existing)) return;

  throw httpError(409, {
    ok: false,
    code: "VOUCHER_ALREADY_USED",
    error: "This voucher has already been used for this child.",
  });
}

function shouldAutoConfirmOnCreate({ isWeekly, isIndividual, isClub, source }) {
  if (source !== "online_request") return false;
  if (isClub === true) return false;
  return isWeekly === true || isIndividual === true;
}

function shouldAutoProcessingOnCreate({ isClub, isHoliday, isCamp, isPower }) {
  return (
    isClub === true || isHoliday === true || isCamp === true || isPower === true
  );
}

function bookingStatus({ autoConfirm, autoProcessing }) {
  if (autoConfirm) return "confirmed";
  if (autoProcessing) return "processing";
  return "pending";
}

function makeConfirmationCode() {
  return "KS-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

async function applyAutoConfirmState(created) {
  let changed = false;

  if (!created.confirmationCode) {
    created.confirmationCode = makeConfirmationCode();
    changed = true;
  }

  if (created.status !== "confirmed") {
    created.status = "confirmed";
    changed = true;
  }

  if (!created.confirmedAt) {
    created.confirmedAt = new Date();
    changed = true;
  }

  if (changed) await created.save();
}

async function sendConfirmedSafe({ created, offer, isNonTrial }) {
  try {
    await sendBookingConfirmedEmail({
      to: created.email,
      booking: created,
      offer,
      isNonTrial,
    });
  } catch (e) {
    console.warn("[bookings] confirmed email failed:", e?.message || e);
  }
}
async function sendProcessingSafe({ created, offer, isNonTrial }) {
  try {
    await sendBookingProcessingEmail({
      to: created.email,
      booking: created,
      offer,
      isNonTrial,
    });
  } catch (e) {
    console.warn("[bookings] processing email failed:", e?.message || e);
  }
}

// function bookingStatus({ isHoliday, isCamp, isPower }) {
//   return isHoliday || isCamp || isPower ? "processing" : "pending";
// }

async function createBookingDoc({
  body,
  offer,
  autoConfirm,
  autoProcessing,
  first,
  last,
  meta,
  finalPrice,
  pro,
  isWeekly,
  monthlyPrice,
}) {
  const prices = computePrices({
    isWeekly,
    monthlyPrice,
    finalPrice,
    pro,
  });

  const source = bookingSourceFromBody(body);

  return Booking.create({
    owner: offer.owner,
    source,
    offerId: offer._id,
    customerId: body?.customerId || undefined,
    childUid: safeText(body?.childUid),
    firstName: first,
    lastName: last,
    email: safeEmail(body?.email),
    // age: Number(body?.age),
    // date: String(body?.date),
    // level: String(body?.level),

    age: body?.age == null || body?.age === "" ? undefined : Number(body.age),
    date: String(body?.date),
    level: safeText(body?.level) || undefined,
    offerTitle: offer.title || "",
    offerType: offer.sub_type || offer.type || "",
    venue: offer.location || "",
    message: body?.message ? String(body.message) : "",
    status: bookingStatus({ autoConfirm, autoProcessing }),
    confirmedAt: autoConfirm ? new Date() : undefined,
    confirmationCode: autoConfirm ? makeConfirmationCode() : undefined,
    adminNote: body?.adminNote || "",
    ...prices,
    invoiceTo: buildInvoiceToFromBody(body),
    meta: { ...meta },
  });
}

async function sendAckSafe({
  created,
  offer,
  pro,
  isNonTrial,
  isHoliday,
  isClub,
}) {
  if (isHoliday && !isClub) return;

  try {
    await sendBookingAckEmail({
      to: created.email,
      offer,
      booking: created,
      pro,
      isNonTrial,
    });
  } catch (e) {
    console.warn("[bookings] ack email failed:", e?.message || e);
  }
}

async function ensureHolidayConfirmationCode({ created, isHoliday }) {
  if (!isHoliday) return;

  try {
    if (created.confirmationCode) return;
    created.confirmationCode =
      "KS-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    await created.save();
  } catch (e) {
    console.error(
      "[bookings] holiday confirmation code failed:",
      e?.message || e,
    );
  }
}

function normalizeVoucherCode(v) {
  return safeText(v).toUpperCase();
}

// async function loadVoucherAmount({ ownerId, code }) {
//   const normalizedCode = normalizeVoucherCode(code);
//   if (!normalizedCode) return 0;

//   const voucher = await Voucher.findOne({
//     owner: ownerId,
//     code: normalizedCode,
//     active: true,
//   })
//     .select("amount code")
//     .lean();

//   if (!voucher) return 0;

//   const amount = Number(voucher.amount);
//   return Number.isFinite(amount) && amount > 0 ? amount : 0;
// }

// async function computeDiscounts({
//   body,
//   offer,
//   isCamp,
//   first,
//   last,
//   birthDateRaw,
//   hasSibling,
//   parentEmail,
//   meta,
//   invoiceTo,
// }) {
//   let siblingDiscount = 0;
//   let mainMemberDiscount = 0;
//   let siblingMemberDiscount = 0;

//   if (isCamp && hasSibling) siblingDiscount = 14;

//   if (isCamp) {
//     const mainHasWeekly = await hasWeekly({
//       offer,
//       first,
//       last,
//       birthDateRaw,
//       parentEmail,
//     });

//     mainMemberDiscount = mainHasWeekly ? 14 : 0;

//     const siblingHasWeekly = hasSibling
//       ? await hasSiblingWeeklyMembership({
//           offer,
//           meta,
//           invoiceTo,
//           fallbackEmail: parentEmail,
//         })
//       : false;

//     siblingMemberDiscount = siblingHasWeekly ? 14 : 0;
//   }

//   const memberDiscount = mainMemberDiscount + siblingMemberDiscount;

//   const mainGoalkeeperSurcharge = goalkeeperSurcharge(
//     meta?.mainGoalkeeperSchool === true,
//   );

//   const siblingGoalkeeperSurcharge = goalkeeperSurcharge(
//     meta?.siblingGoalkeeperSchool === true,
//   );

//   const goalkeeperTotal = mainGoalkeeperSurcharge + siblingGoalkeeperSurcharge;

//   const voucherCode = normalizeVoucherCode(meta?.voucher || body?.voucher);
//   const voucherDiscount = voucherCode
//     ? await loadVoucherAmount({
//         ownerId: offer.owner,
//         code: voucherCode,
//       })
//     : 0;

//   const totalDiscount = siblingDiscount + memberDiscount + voucherDiscount;

//   return {
//     siblingDiscount,
//     memberDiscount,
//     mainMemberDiscount,
//     siblingMemberDiscount,
//     mainGoalkeeperSurcharge,
//     siblingGoalkeeperSurcharge,
//     goalkeeperTotal,
//     voucherCode,
//     voucherDiscount,
//     totalDiscount,
//   };
// }

async function computeDiscounts({
  body,
  offer,
  isCamp,
  isVoucherAllowed,
  first,
  last,
  birthDateRaw,
  hasSibling,
  parentEmail,
  meta,
  invoiceTo,
}) {
  let siblingDiscount = 0;
  let mainMemberDiscount = 0;
  let siblingMemberDiscount = 0;

  if (isCamp && hasSibling) siblingDiscount = 14;

  if (isCamp) {
    const mainHasWeekly = await hasWeekly({
      offer,
      first,
      last,
      birthDateRaw,
      parentEmail,
    });

    mainMemberDiscount = mainHasWeekly ? 14 : 0;

    const siblingHasWeekly = hasSibling
      ? await hasSiblingWeeklyMembership({
          offer,
          meta,
          invoiceTo,
          fallbackEmail: parentEmail,
        })
      : false;

    siblingMemberDiscount = siblingHasWeekly ? 14 : 0;
  }

  const memberDiscount = mainMemberDiscount + siblingMemberDiscount;

  const mainGoalkeeperSurcharge = goalkeeperSurcharge(
    meta?.mainGoalkeeperSchool === true,
  );

  const siblingGoalkeeperSurcharge = goalkeeperSurcharge(
    meta?.siblingGoalkeeperSchool === true,
  );

  const goalkeeperTotal = mainGoalkeeperSurcharge + siblingGoalkeeperSurcharge;

  const voucherCode = normalizeVoucherCode(meta?.voucherCode || meta?.voucher);

  const voucherDiscount =
    isVoucherAllowed && voucherCode
      ? await loadVoucherAmount({
          ownerId: offer.owner,
          code: voucherCode,
        })
      : 0;

  const totalDiscount = siblingDiscount + memberDiscount + voucherDiscount;

  return {
    siblingDiscount,
    memberDiscount,
    mainMemberDiscount,
    siblingMemberDiscount,
    mainGoalkeeperSurcharge,
    siblingGoalkeeperSurcharge,
    goalkeeperTotal,
    voucherCode,
    voucherDiscount,
    totalDiscount,
  };
}

async function loadVoucherAmount({ ownerId, code }) {
  const normalizedCode = normalizeVoucherCode(code);
  if (!normalizedCode) return 0;

  const voucher = await Voucher.findOne({
    owner: ownerId,
    code: normalizedCode,
    active: true,
  })
    .select("amount code")
    .lean();

  if (!voucher) return 0;

  const amount = Number(voucher.amount);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function goalkeeperSurcharge(enabled) {
  return enabled === true ? 40 : 0;
}

async function hasSiblingWeeklyMembership({
  offer,
  meta,
  invoiceTo,
  fallbackEmail,
}) {
  const first = safeText(meta?.siblingFirstName);
  const last = safeText(meta?.siblingLastName);
  const birthDateRaw = meta?.siblingBirthDate || null;
  const parentEmail = safeEmail(invoiceTo?.parent?.email || fallbackEmail);

  if (!first || !last) return false;

  return hasWeekly({
    offer,
    first,
    last,
    birthDateRaw,
    parentEmail,
  });
}

function voucherDiscountFromBody(body, meta) {
  const raw =
    body?.voucherDiscount ??
    body?.voucherAmount ??
    meta?.voucherDiscount ??
    meta?.voucherAmount;

  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function buildCreateContext(body, providerId) {
  const errors = validate(body);
  if (Object.keys(errors).length) {
    throw httpError(400, { ok: false, code: "VALIDATION", errors });
  }

  const offerId = requireOfferId(body);
  const offer = await loadOffer(offerId);
  assertProviderMatch(providerId, offer);

  const { first, last } = bookingNames(body);
  const birthDateRaw = birthDateFromBody(body);
  const meta = metaFromBody(body);

  return {
    offer,
    first,
    last,
    birthDateRaw,
    meta,
    isNonTrial: isNonTrialProgram(offer),
    isHoliday: isHolidayProgram(offer),
    isCamp: isCampOffer(offer),
    isPower: isPowertrainingOffer(offer),
    isWeekly: isWeeklyOffer(offer),
    isIndividual: isIndividualOffer(offer),
    isClub: isClubProgramOffer(offer),
    hasSibling: detectSiblingFlag(body),
  };
}

function clubDuplicateLogPayload(ctx, customerEmail) {
  return {
    isClub: ctx.isClub,
    offerId: String(ctx.offer?._id || ""),
    offerTitle: ctx.offer?.title,
    offerType: ctx.offer?.type,
    offerCategory: ctx.offer?.category,
    first: ctx.first,
    last: ctx.last,
    email: customerEmail,
    courseKey: clubProgramCourseKey(ctx.offer, {
      offerType: ctx.offer?.type,
      offerTitle: ctx.offer?.title,
    }),
  };
}

async function createBookingCore({ body, providerId }) {
  const ctx = await buildCreateContext(body, providerId);
  const invoiceTo = buildInvoiceToFromBody(body);
  const bookingSource = bookingSourceFromBody(body);

  await assertParentEmailNameMatch({
    ownerId: ctx.offer.owner,
    invoiceTo,
    fallbackEmail: body.email,
  });

  const restrictByDate = ctx.isIndividual === true;
  const customerEmail = safeEmail(invoiceTo?.parent?.email || body.email);

  const existing = ctx.isClub
    ? await findBlockingClubProgramDuplicate({
        offer: ctx.offer,
        first: ctx.first,
        last: ctx.last,
        email: customerEmail,
      })
    : await findDuplicateBooking({
        offer: ctx.offer,
        first: ctx.first,
        last: ctx.last,
        date: body.date,
        restrictByDate,
      });

  if (ctx.isClub && existing) {
    throw httpError(409, {
      ok: false,
      code: "DUPLICATE",
      errors: {
        firstName:
          "A booking or request for this course already exists for this customer.",
        lastName:
          "Please revoke the existing course first before booking again.",
      },
    });
  }

  if (existing) {
    const reusable =
      isApprovedForRebook(existing) &&
      existing.paymentStatus !== "paid" &&
      !isRevokedOrClosedBooking(existing);

    if (reusable) {
      const { isWeekly, monthlyPrice } = weeklyFlags(ctx.offer);
      const pro = computeProrate({
        isWeekly,
        monthlyPrice,
        date: body.date,
      });

      if (isWeekly) {
        const out = await createSubscriptionCheckout({ booking: existing });
        if (!out?.ok || !out.url) {
          return {
            status: 500,
            data: { ok: false, code: out?.code || "SERVER" },
          };
        }

        return {
          status: 200,
          data: {
            ok: true,
            booking: existing,
            prorate: pro,
            reused: true,
            checkoutUrl: out.url,
          },
        };
      }

      const out = await createPaymentCheckout({ booking: existing });
      if (!out?.ok || !out.url) {
        return {
          status: 500,
          data: { ok: false, code: out?.code || "SERVER" },
        };
      }

      return {
        status: 200,
        data: {
          ok: true,
          booking: existing,
          prorate: pro,
          reused: true,
          checkoutUrl: out.url,
        },
      };
    }

    const isClosedForDuplicate =
      isRevokedOrClosedBooking(existing) ||
      isExpiredWeeklyBooking(existing, ctx.offer);

    if (!isClosedForDuplicate) {
      await assertNoDuplicate({
        offer: ctx.offer,
        first: ctx.first,
        last: ctx.last,
        date: body.date,
        restrictByDate,
      });
    }
  } else if (!ctx.isClub) {
    await assertNoDuplicate({
      offer: ctx.offer,
      first: ctx.first,
      last: ctx.last,
      date: body.date,
      restrictByDate,
    });
  }

  const basePrice =
    typeof ctx.offer.price === "number" ? ctx.offer.price : null;

  const { isWeekly, monthlyPrice } = weeklyFlags(ctx.offer);
  const pro = computeProrate({
    isWeekly,
    monthlyPrice,
    date: body.date,
  });

  const autoConfirm = shouldAutoConfirmOnCreate({
    isWeekly,
    isIndividual: ctx.isIndividual,
    isClub: ctx.isClub,
    source: bookingSource,
  });

  const autoProcessing = shouldAutoProcessingOnCreate({
    isClub: ctx.isClub,
    isHoliday: ctx.isHoliday,
    isCamp: ctx.isCamp,
    isPower: ctx.isPower,
  });

  const isTeam = ctx.isClub === true;
  const needsWeeklyMembership =
    ctx.isPower === true || ctx.isIndividual === true;

  const autoCheckout = ctx.isCamp === true || ctx.isPower === true;
  const skipAutoCheckout =
    body?.skipAutoCheckout === true ||
    safeText(body?.source) === "admin_booking";

  if (needsWeeklyMembership) {
    const okWeekly = await hasWeekly({
      offer: ctx.offer,
      first: ctx.first,
      last: ctx.last,
      birthDateRaw: ctx.birthDateRaw,
      parentEmail: safeEmail(body.email),
    });

    if (!okWeekly) {
      return {
        status: 403,
        data: {
          ok: false,
          code: "WEEKLY_REQUIRED",
          error: "WEEKLY_REQUIRED",
        },
      };
    }
  }

  // const discounts = await computeDiscounts({
  //   body,
  //   offer: ctx.offer,
  //   isCamp: ctx.isCamp,
  //   first: ctx.first,
  //   last: ctx.last,
  //   birthDateRaw: ctx.birthDateRaw,
  //   hasSibling: ctx.hasSibling,
  //   parentEmail: safeEmail(invoiceTo?.parent?.email || body.email),
  //   meta: {
  //     ...buildHolidayMetaFromBody(body, ctx.offer),
  //     ...ctx.meta,
  //   },
  //   invoiceTo,
  // });
  const mergedHolidayMeta = {
    ...buildHolidayMetaFromBody(body, ctx.offer),
    ...ctx.meta,
  };

  const isVoucherAllowed =
    ctx.isCamp === true ? true : isVoucherRelevantOneTimeOffer(ctx.offer);

  const discounts = await computeDiscounts({
    body,
    offer: ctx.offer,
    isCamp: ctx.isCamp,
    isVoucherAllowed,
    first: ctx.first,
    last: ctx.last,
    birthDateRaw: ctx.birthDateRaw,
    hasSibling: ctx.hasSibling,
    parentEmail: safeEmail(invoiceTo?.parent?.email || body.email),
    meta: mergedHolidayMeta,
    invoiceTo,
  });

  await assertVoucherUnusedForChild({
    ownerId: ctx.offer.owner,
    voucherCode: discounts.voucherCode,
    body,
    first: ctx.first,
    last: ctx.last,
    birthDateRaw: ctx.birthDateRaw,
    email: safeEmail(invoiceTo?.parent?.email || body.email),
  });

  // const grossPrice =
  //   ctx.isCamp && basePrice != null
  //     ? basePrice + Number(discounts.goalkeeperTotal || 0)
  //     : basePrice;

  // const finalPrice =
  //   ctx.isCamp && grossPrice != null
  //     ? Math.max(0, grossPrice - discounts.totalDiscount)
  //     : basePrice;

  const grossPrice =
    ctx.isCamp && basePrice != null
      ? basePrice + Number(discounts.goalkeeperTotal || 0)
      : basePrice;

  const finalPrice =
    !isWeekly && grossPrice != null
      ? Math.max(0, grossPrice - Number(discounts.totalDiscount || 0))
      : basePrice;

  const approvalMeta =
    isTeam || ctx.isIndividual === true
      ? {
          paymentApprovalRequired: true,
          paymentApprovedAt: "",
          paymentApprovalReason: isTeam
            ? "team_training"
            : "individual_training",
        }
      : { paymentApprovalRequired: false };

  // const holidayMeta = buildHolidayMetaFromBody(body, ctx.offer);

  // const mergedHolidayMeta = {
  //   ...holidayMeta,
  //   ...ctx.meta,
  // };

  // const meta = {
  //   ...mergedHolidayMeta,
  //   ...approvalMeta,
  //   basePrice,
  //   grossPrice,
  //   ...discounts,
  // };

  const meta = {
    ...mergedHolidayMeta,
    ...approvalMeta,
    basePrice,
    grossPrice,
    ...discounts,
    voucher: discounts.voucherCode || mergedHolidayMeta.voucher || "",
    voucherCode: discounts.voucherCode || mergedHolidayMeta.voucherCode || "",
  };

  const created = await createBookingDoc({
    body,
    offer: ctx.offer,
    autoConfirm,
    autoProcessing,
    first: ctx.first,
    last: ctx.last,
    meta,
    finalPrice,
    pro,
    isWeekly,
    monthlyPrice,
  });

  await sendAckSafe({
    created,
    offer: ctx.offer,
    pro,
    isNonTrial: ctx.isNonTrial,
    isHoliday: ctx.isHoliday,
    isClub: ctx.isClub,
  });

  if (autoConfirm) {
    await applyAutoConfirmState(created);
    await sendConfirmedSafe({
      created,
      offer: ctx.offer,
      isNonTrial: ctx.isNonTrial,
    });
  }

  if (ctx.isClub) {
    await sendProcessingSafe({
      created,
      offer: ctx.offer,
      isNonTrial: ctx.isNonTrial,
    });
  }

  await ensureHolidayConfirmationCode({
    created,
    isHoliday: ctx.isHoliday,
  });

  if (isTeam) {
    return {
      status: 201,
      data: {
        ok: true,
        booking: created,
        prorate: pro,
        requiresApproval: true,
      },
    };
  }

  if (autoCheckout && !skipAutoCheckout) {
    const out = await createPaymentCheckout({ booking: created });
    if (!out?.ok || !out.url) {
      return {
        status: 500,
        data: { ok: false, code: out?.code || "SERVER" },
      };
    }

    return {
      status: 201,
      data: {
        ok: true,
        booking: created,
        prorate: pro,
        checkoutUrl: out.url,
      },
    };
  }

  return {
    status: 201,
    data: { ok: true, booking: created, prorate: pro },
  };
}

async function createBooking(req, res) {
  try {
    const result = await createBookingCore({
      body: req.body || {},
      providerId: req.get("x-provider-id"),
    });

    return res.status(result.status).json(result.data);
  } catch (err) {
    const status = Number(err?.status) || 500;
    const payload = err?.payload || {
      ok: false,
      code: "SERVER",
      error: "Server error",
    };

    if (status === 500) console.error(err);
    return res.status(status).json(payload);
  }
}

module.exports = {
  createBooking,
  createBookingCore,
};
