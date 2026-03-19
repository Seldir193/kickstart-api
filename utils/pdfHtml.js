// utils/pdfHtml.js

"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const Handlebars = require("handlebars");
const htmlToPdf = require("html-pdf-node");

function projectRoot() {
  return path.resolve(__dirname, "..");
}
function safeRead(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function toISODate(v) {
  const d = toDate(v);
  return d ? d.toISOString().slice(0, 10) : "";
}
function toDEDate(v) {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat("de-DE").format(d) : "";
}

function fileToDataUrl(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    const ext = (path.extname(absPath).slice(1) || "png").toLowerCase();
    const mime =
      ext === "svg"
        ? "image/svg+xml"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}

function inlineCssLinks(html, tplDir) {
  return html.replace(
    /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    (_m, href) => {
      const abs1 = path.isAbsolute(href) ? href : path.resolve(tplDir, href);
      let css = safeRead(abs1);
      if (css) return `<style>\n${css}\n</style>`;
      const abs2 = path.resolve(projectRoot(), href);
      css = safeRead(abs2);
      return css ? `<style>\n${css}\n</style>` : "";
    },
  );
}

function getBrand() {
  const rawLogo =
    process.env.BRAND_LOGO_URL ||
    process.env.BRAND_LOGO_PATH ||
    process.env.PDF_LOGO ||
    "";

  let logoUrl = "";
  if (/^https?:\/\//i.test(rawLogo)) {
    logoUrl = rawLogo;
  } else if (rawLogo) {
    const abs = path.isAbsolute(rawLogo)
      ? rawLogo
      : path.resolve(process.cwd(), rawLogo);
    if (fs.existsSync(abs)) {
      logoUrl = fileToDataUrl(abs) || pathToFileURL(abs).toString();
    }
  }

  return {
    company: process.env.BRAND_COMPANY || "Münchner Fussball Schule NRW",
    addr1: process.env.BRAND_ADDR_LINE1 || "Hochfelder Str. 33",
    addr2: process.env.BRAND_ADDR_LINE2 || "47226 Duisburg",
    email: process.env.BRAND_EMAIL || "info@muenchner-fussball-schule.ruhr",
    website:
      process.env.BRAND_WEBSITE_URL ||
      "https://www.muenchner-fussball-schule.ruhr",
    iban: process.env.BRAND_IBAN || "DE13350400380595090200",
    bic: process.env.BRAND_BIC || "COBADEFFXXX",
    taxId: process.env.BRAND_TAXID || "",
    logoUrl,
  };
}

Handlebars.registerHelper("fmtMoney", function (value, currency) {
  const num = Number(value ?? 0);
  const cur = (currency && String(currency)) || "EUR";
  try {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: cur,
    }).format(num);
  } catch {
    const fixed = Number.isFinite(num) ? num.toFixed(2) : "0.00";
    return `${fixed} ${cur}`;
  }
});

Handlebars.registerHelper("fmtDate", function (input) {
  return toDEDate(input);
});

Handlebars.registerHelper("fullName", function (obj) {
  if (!obj) return "";
  const parts = [obj.salutation, obj.firstName, obj.lastName].filter(Boolean);
  return parts.join(" ");
});

Handlebars.registerHelper("courseOnly", function (title) {
  if (!title) return "";
  const s = String(title);

  const cut = s.split(/\s*(?:[•|]|—|–)\s*/);
  return (cut[0] || "").trim();
});

Handlebars.registerHelper("eq", (a, b) => a === b);

Handlebars.registerHelper("or", (...args) => {
  const values = args.slice(0, -1);
  return values.some(Boolean);
});

Handlebars.registerHelper("formalGreeting", function (parent) {
  const p = parent || {};
  const salutation = String(p.salutation || "")
    .trim()
    .toLowerCase();
  const lastName = String(p.lastName || "").trim();

  if (salutation.includes("frau")) {
    return lastName
      ? `Sehr geehrte Frau ${lastName},`
      : "Sehr geehrte Damen und Herren,";
  }

  if (salutation.includes("herr")) {
    return lastName
      ? `Sehr geehrter Herr ${lastName},`
      : "Sehr geehrte Damen und Herren,";
  }

  return "Sehr geehrte Damen und Herren,";
});

function isWeeklyOffer(offer) {
  const cat = String(offer?.category || "").trim();
  const type = String(offer?.type || "").trim();
  const sub = String(offer?.sub_type || "").trim();
  const title = String(offer?.title || "").trim();

  const lc = (s) => s.toLowerCase();

  const isExplicitNonWeekly =
    ["individual", "holiday", "clubprograms", "club", "camp"].includes(
      lc(cat),
    ) ||
    ["PersonalTraining", "AthleticTraining"].includes(type) ||
    lc(sub).includes("powertraining") ||
    /rent\s*a\s*coach|rentacoach|coach\s*education|trainerfortbildung|trainerausbildung/i.test(
      [cat, type, sub, title].join(" "),
    );

  if (isExplicitNonWeekly) return false;

  if (cat === "Weekly") return true;
  if (type === "Foerdertraining" || type === "Kindergarten") return true;

  return false;
}

function resolveHbsPath(baseName) {
  const name = String(baseName || "").trim();
  const file = name.endsWith(".hbs") ? name : `${name}.hbs`;
  const dirs = [
    process.env.PDF_TEMPLATES_DIR &&
      path.resolve(projectRoot(), process.env.PDF_TEMPLATES_DIR),
    path.resolve(projectRoot(), "templates", "pdf"),
    path.resolve(process.cwd(), "templates", "pdf"),
  ].filter(Boolean);
  for (const dir of dirs) {
    const p = path.resolve(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function compileTemplate(baseName, data) {
  const filePath = resolveHbsPath(baseName);
  let html = filePath ? safeRead(filePath) : null;

  console.log("[PDF TEMPLATE PATH]", {
    baseName,
    filePath,
  });

  if (!html) {
    html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>PDF</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#111827;margin:24px">
  <h1>{{brand.company}}</h1>
  <div>Kein Template gefunden: ${baseName}.hbs</div>
</body></html>`;
  } else {
    html = inlineCssLinks(html, path.dirname(filePath));
  }

  const tpl = Handlebars.compile(html, { noEscape: true });
  return tpl(data);
}

async function renderPdf(html, options = {}) {
  const file = { content: html };
  const opts = {
    format: "A4",
    margin: { top: "15mm", right: "15mm", bottom: "18mm", left: "15mm" },
    printBackground: true,
    preferCSSPageSize: true,
    ...options,
  };
  return htmlToPdf.generatePdf(file, opts);
}

function splitChildName(fullName) {
  const raw = String(fullName || "").trim();
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

function hydrateCustomerWithBooking(customer = {}, booking = {}) {
  const parent = { ...(customer?.parent || {}) };
  const child = {};

  if (!parent.firstName && booking.firstName) {
    parent.firstName = booking.firstName;
  }

  if (!parent.lastName && booking.lastName) {
    parent.lastName = booking.lastName;
  }

  const childFromName = splitChildName(booking.childName);
  const bookingChildFirst =
    String(booking?.childFirstName || "").trim() || childFromName.firstName;
  const bookingChildLast =
    String(booking?.childLastName || "").trim() || childFromName.lastName;

  if (bookingChildFirst) {
    child.firstName = bookingChildFirst;
  }

  if (bookingChildLast) {
    child.lastName = bookingChildLast;
  }

  if (!parent.email && booking.email) {
    parent.email = booking.email;
  }

  return {
    userId: String(customer?.userId ?? customer?._id ?? "-"),
    parent,
    child,
    address: customer?.address || {},
  };
}

function applyOfferSnapshot(booking = {}, offer) {
  const out = { ...booking };
  if (offer) {
    out.offerTitle =
      out.offerTitle || offer.title || offer.sub_type || offer.type || "";
    out.offerType = out.offerType || offer.sub_type || offer.type || "";
    out.venue = out.venue || offer.location || "";
  }
  if (!out.offer && (out.offerTitle || out.offerType)) {
    out.offer = out.offerTitle || out.offerType;
  }
  return out;
}

function normalizeBookingForPdf(booking = {}) {
  const out = { ...booking };
  if (!out.venue && out.offerLocation) out.venue = out.offerLocation;
  out.cancelDate =
    out.cancelDate || out.cancellationDate || out.canceledAt || new Date();
  out.date = out.date || out.createdAt || new Date();
  out.dateISO = toISODate(out.date);
  out.dateDE = toDEDate(out.date);
  return out;
}

async function bookingPdfBufferHTML(booking) {
  const brand = getBrand();

  const dateDE = booking?.date
    ? new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(new Date(booking.date))
    : "";

  const html = compileTemplate("booking-confirmation", {
    brand,
    booking: {
      confirmationCode: booking?.confirmationCode || "",
      fullName:
        booking?.fullName ||
        [booking?.firstName, booking?.lastName].filter(Boolean).join(" "),
      email: booking?.email || "",
      program: booking?.program || booking?.level || "",
      date: dateDE,
      dateISO: booking?.date || "",
      message: booking?.message || "",
      status: booking?.status || "",
      confirmedAt: booking?.confirmedAt || null,
    },
  });

  return renderPdf(html);
}

async function buildParticipationPdfHTML({
  customer,
  booking,
  offer,
  invoiceNo,
  invoiceDate,
  monthlyAmount,
  firstMonthAmount,
  venue,
  isWeekly,
  pricing,
  invoice,
}) {
  const brand = getBrand();

  const parent = { ...(customer?.parent || {}) };
  if (Object.prototype.hasOwnProperty.call(parent, "email"))
    delete parent.email;
  const child = { ...(customer?.child || {}) };

  const weekly =
    typeof isWeekly === "boolean" ? isWeekly : isWeeklyOffer(offer);

  const finalVenue = venue || booking?.venue || offer?.location || "";

  const title =
    booking?.offerTitle ||
    booking?.offerType ||
    booking?.offer ||
    offer?.sub_type ||
    offer?.title ||
    "-";

  function weekdayFromISO(iso) {
    if (!iso) return "";
    const d = new Date(/\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso}T00:00:00` : iso);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("de-DE", { weekday: "long" }).format(d);
  }

  //teil2
  function timeRangeFromOffer(off, weekdayName = "") {
    if (!off) return "";
    const join = (f, t) =>
      [f, t]
        .filter(Boolean)
        .map(String)
        .map((s) => s.trim())
        .join(" – ");
    const norm = (v) => String(v || "").toLowerCase();
    const w = norm(weekdayName);

    if (Array.isArray(off.days) && off.days.length) {
      let cand =
        off.days.find(
          (d) =>
            norm(d?.day) === w || norm(d?.weekday) === w || norm(d?.tag) === w,
        ) || off.days[0];

      if (cand && typeof cand === "object") {
        const from =
          cand.timeFrom ??
          cand.from ??
          cand.start ??
          (cand.time && (cand.time.from ?? cand.timeStart));
        const to =
          cand.timeTo ??
          cand.to ??
          cand.end ??
          (cand.time && (cand.time.to ?? cand.timeEnd));
        if (from || to) return join(from, to);
        const t = cand.time ?? cand.zeit ?? cand.uhrzeit;
        if (t)
          return String(t)
            .replace(/\s*-\s*/g, " – ")
            .trim();
      }
    }

    const from = off.timeFrom ?? off.from ?? off.start;
    const to = off.timeTo ?? off.to ?? off.end;
    if (from || to) return join(from, to);
    const t = off.time ?? off.zeit ?? off.uhrzeit;
    return t
      ? String(t)
          .replace(/\s*-\s*/g, " – ")
          .trim()
      : "";
  }

  const bookingDate = booking?.date || booking?.createdAt || null;

  const derivedDay = weekly
    ? booking?.dayTimes ||
      booking?.kurstag ||
      booking?.weekday ||
      weekdayFromISO(bookingDate)
    : "";

  const derivedTime = weekly
    ? booking?.timeDisplay ||
      booking?.kurszeit ||
      booking?.time ||
      booking?.uhrzeit ||
      timeRangeFromOffer(offer, derivedDay)
    : "";

  const dayTimes = weekly ? derivedDay : "";
  const timeDisplay = weekly ? derivedTime : "";

  const effInvoice = { ...(invoice || {}) };
  const effPricing = { ...(pricing || {}) };

  if (invoiceNo && !effInvoice.number) effInvoice.number = invoiceNo;
  if (invoiceDate && !effInvoice.date) effInvoice.date = invoiceDate;

  if (weekly && typeof monthlyAmount === "number") {
    effInvoice.monthly = monthlyAmount;
    effPricing.monthly = monthlyAmount;
  }
  if (weekly && typeof firstMonthAmount === "number") {
    effInvoice.firstMonth = firstMonthAmount;
    effPricing.firstMonth = firstMonthAmount;
  }

  const currency = effInvoice.currency || effPricing.currency || "EUR";
  effInvoice.currency = currency;
  effPricing.currency = currency;

  let discount = null;

  if (!weekly && booking) {
    if (booking.discount) {
      discount = { ...booking.discount };
    } else {
      const meta =
        booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

      const basePrice =
        typeof meta.basePrice === "number" ? Number(meta.basePrice) : undefined;

      const grossPrice =
        typeof meta.grossPrice === "number"
          ? Number(meta.grossPrice)
          : basePrice;

      const mainGoalkeeperSurcharge = Number(meta.mainGoalkeeperSurcharge || 0);
      const siblingGoalkeeperSurcharge = Number(
        meta.siblingGoalkeeperSurcharge || 0,
      );

      const goalkeeperTotal =
        meta.goalkeeperTotal != null
          ? Number(meta.goalkeeperTotal)
          : mainGoalkeeperSurcharge + siblingGoalkeeperSurcharge;

      const siblingDiscount = Number(meta.siblingDiscount || 0);
      const mainMemberDiscount = Number(meta.mainMemberDiscount || 0);
      const siblingMemberDiscount = Number(meta.siblingMemberDiscount || 0);

      const memberDiscount =
        meta.memberDiscount != null
          ? Number(meta.memberDiscount)
          : mainMemberDiscount + siblingMemberDiscount;

      const voucherDiscount = Number(meta.voucherDiscount || 0);

      const totalDiscount =
        meta.totalDiscount != null
          ? Number(meta.totalDiscount)
          : siblingDiscount + memberDiscount + voucherDiscount;

      const finalPrice =
        typeof booking.priceAtBooking === "number"
          ? Number(booking.priceAtBooking)
          : grossPrice != null
            ? Number(grossPrice) - Number(totalDiscount)
            : undefined;

      discount = {
        basePrice,
        grossPrice,
        mainGoalkeeperSurcharge,
        siblingGoalkeeperSurcharge,
        goalkeeperTotal,
        siblingDiscount,
        mainMemberDiscount,
        siblingMemberDiscount,
        memberDiscount,
        voucherCode: String(meta.voucherCode || meta.voucher || "").trim(),
        voucherDiscount,
        totalDiscount,
        finalPrice,
      };
    }
    if (discount) {
      discount.voucherCode = String(discount.voucherCode || "").trim();
      discount.voucherDiscount = Number(discount.voucherDiscount || 0);
      discount.hasVoucher = Boolean(
        discount.voucherCode || discount.voucherDiscount > 0,
      );
      discount.voucherLabel = discount.voucherCode
        ? `Gutschein (${discount.voucherCode})`
        : "Gutschein";
    }
  }

  // let discount = null;

  // if (!weekly && booking) {
  //   if (booking.discount) {
  //     discount = { ...booking.discount };
  //   } else {
  //     const meta =
  //       booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

  //     const siblingDiscount = Number(meta.siblingDiscount || 0);
  //     const memberDiscount = Number(meta.memberDiscount || 0);
  //     const totalDiscount =
  //       meta.totalDiscount != null
  //         ? Number(meta.totalDiscount)
  //         : siblingDiscount + memberDiscount;

  //     const finalPrice =
  //       typeof booking.priceAtBooking === "number"
  //         ? Number(booking.priceAtBooking)
  //         : undefined;

  //     const lastRefBase =
  //       Array.isArray(booking.invoiceRefs) && booking.invoiceRefs.length
  //         ? booking.invoiceRefs[booking.invoiceRefs.length - 1]?.basePrice
  //         : undefined;

  //     const basePrice =
  //       typeof meta.basePrice === "number"
  //         ? Number(meta.basePrice)
  //         : typeof effInvoice.basePrice === "number"
  //           ? Number(effInvoice.basePrice)
  //           : typeof lastRefBase === "number"
  //             ? Number(lastRefBase)
  //             : finalPrice != null && Number.isFinite(totalDiscount)
  //               ? Number(finalPrice) + Number(totalDiscount)
  //               : undefined;

  //     discount = {
  //       basePrice,
  //       siblingDiscount,
  //       memberDiscount,
  //       totalDiscount,
  //       finalPrice,
  //     };
  //   }
  // }

  let effectiveSingle;
  if (!weekly) {
    if (
      discount?.finalPrice != null &&
      Number.isFinite(Number(discount.finalPrice))
    ) {
      effectiveSingle = Number(discount.finalPrice);
    } else if (
      effInvoice.single != null &&
      Number.isFinite(Number(effInvoice.single))
    ) {
      effectiveSingle = Number(effInvoice.single);
    } else if (
      effPricing.single != null &&
      Number.isFinite(Number(effPricing.single))
    ) {
      effectiveSingle = Number(effPricing.single);
    }

    if (effectiveSingle != null) {
      effInvoice.single = effectiveSingle;
      effPricing.single = effectiveSingle;
      if (
        discount &&
        (discount.finalPrice == null ||
          !Number.isFinite(Number(discount.finalPrice)))
      ) {
        discount.finalPrice = effectiveSingle;
      }
    }
  }

  const bookingCtx = {
    ...(booking || {}),
    offerTitle: title,
    date: booking?.date || "",
    status: booking?.status || "active",
    venue: finalVenue,
    offer: booking?.offer || title,
    dayTimes,
    timeDisplay,
  };

  if (discount) bookingCtx.discount = discount;

  const invNo = String(
    effInvoice.number ||
      invoiceNo ||
      booking?.invoiceNo ||
      booking?.invoiceNumber ||
      "",
  ).trim();

  const byNo = /^GS[-/]/i.test(invNo);

  const byNegative =
    (typeof booking?.priceAtBooking === "number" &&
      booking.priceAtBooking < 0) ||
    (typeof effInvoice.single === "number" && effInvoice.single < 0) ||
    (typeof effPricing.single === "number" && effPricing.single < 0);

  const flags = {
    isWeekly: weekly,
    isOneOff: !weekly,
    isCreditNote: byNo || byNegative,
  };

  console.log("[PDF DEBUG bookingCtx.discount]", {
    offerTitle: bookingCtx?.offerTitle,
    offer: bookingCtx?.offer,
    priceAtBooking: bookingCtx?.priceAtBooking,
    discount: bookingCtx?.discount || null,
  });

  const html = compileTemplate("participation", {
    brand,
    flags,
    customer: {
      userId: customer?.userId ?? "-",
      parent,
      child,
      address: customer?.address || {},
    },
    booking: bookingCtx,
    pricing: effPricing,
    invoice: effInvoice,
  });

  console.log("[PDF HTML DEBUG voucher]", {
    hasVoucherWord: html.includes("Gutschein"),
    hasVoucherCode: html.includes(
      String(bookingCtx?.discount?.voucherCode || ""),
    ),
    hasVoucherAmount: html.includes(
      String(bookingCtx?.discount?.voucherDiscount || ""),
    ),
  });

  const voucherIndex = html.indexOf("Gutschein");
  console.log(
    "[PDF HTML DEBUG snippet]",
    voucherIndex >= 0
      ? html.slice(Math.max(0, voucherIndex - 250), voucherIndex + 400)
      : "NO_GUTSCHEIN_IN_HTML",
  );

  return renderPdf(html);
}

async function buildCancellationPdfHTML({
  customer,
  booking,
  offer,
  requestDate,
  endDate,
  date,
  reason,
  cancellationNo,
  referenceInvoice,
}) {
  const brand = getBrand();

  const hydrated = hydrateCustomerWithBooking(customer, booking);

  const withOffer = applyOfferSnapshot(booking, offer);
  const normBooking = normalizeBookingForPdf(withOffer);
  const cancelDate = date || normBooking.cancelDate;
  const reqDate = requestDate || cancelDate;
  const endDateEff = endDate || normBooking.endDate || null;

  const parent = { ...hydrated.parent };
  if (Object.prototype.hasOwnProperty.call(parent, "email"))
    delete parent.email;
  const child = { ...hydrated.child };

  const effectiveCancellationNo =
    cancellationNo ||
    normBooking.cancellationNo ||
    normBooking.cancellationNumber ||
    `KND-${String(normBooking._id || "")
      .slice(-6)
      .toUpperCase()}`;

  const refInvoiceNo =
    (referenceInvoice && referenceInvoice.number) ||
    normBooking.refInvoiceNo ||
    normBooking.originalInvoiceNo ||
    normBooking.invoiceNo ||
    normBooking.invoiceNumber ||
    "";

  const refInvoiceDate =
    (referenceInvoice && referenceInvoice.date) ||
    normBooking.refInvoiceDate ||
    normBooking.originalInvoiceDate ||
    normBooking.invoiceDate ||
    "";
  const refInvoiceDateDE = toDEDate(refInvoiceDate);

  const html = compileTemplate("cancellation", {
    brand,
    customer: {
      userId: hydrated.userId,
      parent,
      child,
      address: hydrated.address,
    },
    booking: {
      offerTitle:
        normBooking.offerTitle ||
        normBooking.offerType ||
        normBooking.offer ||
        "-",

      offerType: normBooking.offerType || "",
      offer: normBooking.offer || "",
      venue: normBooking.venue || "",
      cancelDate,
      cancellationNo: effectiveCancellationNo,
      refInvoiceNo,
      refInvoiceDate,
      refInvoiceDateDE,
    },
    details: {
      requestDate: toDate(reqDate) || toDate(cancelDate) || new Date(),
      endDate: toDate(endDateEff),
      cancelDate: toDate(cancelDate) || new Date(),
      reason: reason || normBooking.cancelReason || "",
    },
  });
  return renderPdf(html);
}

async function buildStornoPdfHTML({
  customer,
  booking,
  offer,
  amount = 0,
  currency = "EUR",
  stornoNo,
  referenceInvoice,
}) {
  const brand = getBrand();

  const hydrated = hydrateCustomerWithBooking(customer, booking);
  const withOffer = applyOfferSnapshot(booking, offer);
  const normBooking = normalizeBookingForPdf(withOffer);

  const amountNum = Number.isFinite(Number(amount))
    ? Number(amount)
    : offer && typeof offer.price === "number"
      ? offer.price
      : 0;

  const curr = String(currency || "EUR");
  const taxNote = "Umsatzsteuerbefreit nach § 19 UStG";

  const parent = { ...hydrated.parent };
  if (Object.prototype.hasOwnProperty.call(parent, "email"))
    delete parent.email;
  const child = { ...hydrated.child };

  const effectiveStornoNo =
    stornoNo ||
    normBooking.stornoNo ||
    `STORNO-${String(normBooking._id || "")
      .slice(-6)
      .toUpperCase()}`;

  const refInvoiceNo =
    (referenceInvoice && referenceInvoice.number) ||
    normBooking.refInvoiceNo ||
    normBooking.originalInvoiceNo ||
    normBooking.invoiceNo ||
    normBooking.invoiceNumber ||
    "";

  const refInvoiceDate =
    (referenceInvoice && referenceInvoice.date) ||
    normBooking.refInvoiceDate ||
    normBooking.originalInvoiceDate ||
    normBooking.invoiceDate ||
    "";
  const refInvoiceDateDE = toDEDate(refInvoiceDate);

  const html = compileTemplate("storno", {
    brand,
    customer: {
      userId: hydrated.userId,
      parent,
      child,
      address: hydrated.address,
    },
    booking: {
      ...normBooking,
      offerTitle:
        normBooking.offerTitle ||
        normBooking.offerType ||
        normBooking.offer ||
        "-",
      offerType: normBooking.offerType || "",
      offer: normBooking.offer || "",
      venue: normBooking.venue || "",
      cancelDate: normBooking.cancelDate,
      stornoNo: effectiveStornoNo,
      refInvoiceNo,
      refInvoiceDate,
      refInvoiceDateDE,
    },
    amount: amountNum,
    currency: curr,
    taxNote,
  });

  return renderPdf(html);
}

function euro(value, currency = "EUR") {
  const n = Number(value || 0);
  try {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function stageLabel(stage) {
  const s = String(stage || "").trim();
  if (s === "reminder") return "Zahlungserinnerung";
  if (s === "dunning1") return "1. Mahnung";
  if (s === "dunning2") return "2. Mahnung";
  if (s === "final") return "Letzte Mahnung";
  return "Mahnung";
}

function bookingDocNo(booking = {}) {
  return (
    booking?.invoiceNo || booking?.invoiceNumber || booking?.refInvoiceNo || ""
  );
}

function bookingBaseAmount(booking = {}) {
  const candidates = [
    booking?.priceAtBooking,
    booking?.stornoAmount,
    booking?.amount,
  ];

  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }

  return 0;
}

async function buildDunningPdfHTML({
  customer,
  booking,
  stage,
  issuedAt,
  dueAt,
  feeSnapshot,
  freeText,
}) {
  const brand = getBrand();
  const hydrated = hydrateCustomerWithBooking(customer, booking);
  const normBooking = normalizeBookingForPdf(booking || {});

  const parent = { ...(hydrated.parent || {}) };
  if (Object.prototype.hasOwnProperty.call(parent, "email")) {
    delete parent.email;
  }

  const baseAmount = bookingBaseAmount(normBooking);
  const returnBankFee = Number(feeSnapshot?.returnBankFee || 0);
  const dunningFee = Number(feeSnapshot?.dunningFee || 0);
  const processingFee = Number(feeSnapshot?.processingFee || 0);

  const totalExtraFees = Number(
    feeSnapshot?.totalExtraFees != null
      ? feeSnapshot.totalExtraFees
      : returnBankFee + dunningFee + processingFee,
  );

  const totalDue = Math.round((baseAmount + totalExtraFees) * 100) / 100;

  const currency = String(
    feeSnapshot?.currency || normBooking.currency || "EUR",
  );

  const html = compileTemplate("dunning", {
    brand,
    customer: {
      userId: hydrated.userId,
      parent,
      child: hydrated.child || {},
      address: hydrated.address || {},
    },

    booking: {
      ...normBooking,
      docNo: bookingDocNo(normBooking),
      docDate: normBooking.refInvoiceDate || normBooking.invoiceDate || "",
      offerTitle:
        normBooking.offerTitle ||
        normBooking.offerType ||
        normBooking.offer ||
        "-",
    },
    dunning: {
      stage: String(stage || ""),
      stageLabel: stageLabel(stage),
      issuedAt: issuedAt || new Date(),
      dueAt: dueAt || null,
      freeText: String(freeText || "").trim(),
      baseAmount,
      returnBankFee,
      dunningFee,
      processingFee,
      totalExtraFees,
      totalDue,
      currency,
      baseAmountText: euro(baseAmount, currency),
      returnBankFeeText: euro(returnBankFee, currency),
      dunningFeeText: euro(dunningFee, currency),
      processingFeeText: euro(processingFee, currency),
      totalDueText: euro(totalDue, currency),
    },
  });

  return renderPdf(html);
}

async function buildWeeklyContractPdfHTML({ contract } = {}) {
  const brand = getBrand();

  const html = compileTemplate("weekly-contract", {
    brand,
    contract: contract || {},
  });

  return renderPdf(html);
}

async function buildWeeklyRecurringInvoicePdfHTML({
  customer,
  booking,
  offer,
  invoice,
}) {
  const brand = getBrand();

  const parent = { ...(customer?.parent || {}) };
  if (Object.prototype.hasOwnProperty.call(parent, "email")) {
    delete parent.email;
  }

  const child = { ...(customer?.child || {}) };

  const bookingCtx = {
    ...(booking || {}),
    offer:
      booking?.offer ||
      booking?.offerTitle ||
      booking?.offerType ||
      offer?.title ||
      offer?.sub_type ||
      offer?.type ||
      "",
    venue: booking?.venue || offer?.location || "",
  };

  const html = compileTemplate("weekly-recurring-invoice", {
    brand,
    customer: {
      userId: customer?.userId ?? "-",
      parent,
      child,
      address: customer?.address || {},
    },
    booking: bookingCtx,
    invoice: {
      ...invoice,
      date: invoice?.date || "",
      number: invoice?.number || "",
      amount: invoice?.amount,
      currency: invoice?.currency || "EUR",
      billingMonth: invoice?.billingMonth || "",
      billingMonthLabel: invoice?.billingMonthLabel || "",
      periodStart: invoice?.periodStart || "",
      periodEnd: invoice?.periodEnd || "",
      periodStartDisplay:
        invoice?.periodStartDisplay || invoice?.periodStart || "",
      periodEndDisplay: invoice?.periodEndDisplay || invoice?.periodEnd || "",
    },
  });

  return renderPdf(html);
}

module.exports = {
  bookingPdfBufferHTML,
  buildParticipationPdfHTML,
  buildCancellationPdfHTML,
  buildStornoPdfHTML,
  buildDunningPdfHTML,
  buildWeeklyContractPdfHTML,
  buildWeeklyRecurringInvoicePdfHTML,
};
