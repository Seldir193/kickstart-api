// // utils/mailer.js
// utils/mailer.js

//teil1
"use strict";

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const mongoose = require("mongoose");
require("dotenv").config();

const { renderMjmlFile } = require("./mjmlRenderer");

const {
  bookingPdfBuffer,
  buildParticipationPdf,
  buildCancellationPdf,
  buildStornoPdf,
  buildDunningPdf,
} = require("./pdf");

const {
  shapeStornoData,
  shapeCancellationData,
  shapeParticipationData,
} = require("./pdfData");

const Customer = require("../models/Customer");
const Booking = require("../models/Booking");

const {
  ensureRevocationLink,
  websiteBaseUrl,
} = require("./mailer/revocationLinks");

/* ================= Transport ================= */
let transporter;
function getTransporter() {
  if (!transporter) {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const secure =
      String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";

    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls: { minVersion: "TLSv1.2" },
    });
  }
  return transporter;
}

/* ================= Helpers ================= */
const fileExists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

function safeText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

const eur = (n, currency = "EUR") =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(
    Number(n || 0),
  );

const fullName = (p) =>
  [p?.salutation, p?.firstName, p?.lastName].filter(Boolean).join(" ");

function getBrandAndLogoCidAttachment() {
  const brand = {
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
  };

  const rawLogo =
    process.env.BRAND_LOGO_URL ||
    process.env.BRAND_LOGO_PATH ||
    process.env.PDF_LOGO ||
    "";

  if (/^https?:\/\//i.test(rawLogo)) {
    return { brand, logoAttachment: null, logoUrl: rawLogo };
  }

  if (rawLogo) {
    const abs = path.isAbsolute(rawLogo)
      ? rawLogo
      : path.resolve(process.cwd(), rawLogo);
    if (fileExists(abs)) {
      const att = { filename: path.basename(abs), path: abs, cid: "brandLogo" };
      return { brand, logoAttachment: att, logoUrl: "cid:brandLogo" };
    }
  }

  return { brand, logoAttachment: null, logoUrl: "" };
}

async function sendMail({
  to,
  subject,
  text,
  html,
  attachments = [],
  cc,
  bcc,
}) {
  const effectiveBcc = bcc ?? process.env.MAIL_BCC ?? undefined;

  return getTransporter().sendMail({
    from: process.env.FROM_EMAIL || "info@muenchner-fussball-schule.ruhr",
    to,
    subject,
    text: text ?? "",
    html,
    attachments,
    cc,
    bcc: effectiveBcc,
  });
}

function courseOnly(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.split(/\s*(?:[•|]|—|–)\s*/)[0];
  const commaDigit = s.search(/,\s*\d/);
  if (commaDigit > 0) s = s.slice(0, commaDigit);
  const dashAddr = s.search(/\s-\s*\d/);
  if (dashAddr > 0) s = s.slice(0, dashAddr);
  return s.trim();
}

const NON_TRIAL_TYPES = new Set([
  "RentACoach_Generic",
  "RentACoach",
  "ClubProgram_Generic",
  "ClubProgram",
  "CoachEducation",
]);

function buildProgramLabel(offer, booking) {
  if (offer?.title) return courseOnly(offer.title);
  if (booking?.offerTitle) return courseOnly(booking.offerTitle);
  if (booking?.offerType) return courseOnly(booking.offerType);
  if (offer?.sub_type) return courseOnly(offer.sub_type);
  if (offer?.type) return courseOnly(offer.type);
  if (booking?.program) return courseOnly(booking.program);
  if (booking?.level) return courseOnly(booking.level);
  return "Buchung";
}

function parseInquiryMessage(msg) {
  const t = String(msg || "");
  const pick = (label) => {
    const m = t.match(new RegExp(`${label}\\s*:\\s*([^\\n]+)`, "i"));
    return m ? m[1].trim() : "";
  };

  let childRaw = pick("Kind");

  childRaw = childRaw
    .replace(
      /\s*,\s*(Geburts(tag|datum)|Kontakt|Adresse|Telefon|Gutschein|Quelle)\s*:.*/i,
      "",
    )
    .trim();

  const genderMatch = childRaw.match(/\(([^)]+)\)/);
  const gender = genderMatch ? genderMatch[1].trim() : "";
  const child = childRaw.replace(/\s*\([^)]*\)\s*$/, "").trim();

  return {
    child,
    gender,
    birthdate: pick("Geburtstag") || pick("Geburtsdatum"),
    contact: pick("Kontakt"),
    address: pick("Adresse"),
    phone: pick("Telefon"),
    voucher: pick("Gutschein"),
    source: pick("Quelle"),
  };
}

async function sendBookingAckEmail({
  to,
  offer,
  booking,
  pro,
  isNonTrial = false,
}) {
  if (!to) return;
  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const dateDE = booking?.date
    ? new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(new Date(booking.date))
    : "";

  const rawOffer =
    offer?.title ||
    `${offer?.sub_type || offer?.type || ""}${offer?.location ? " • " + offer.location : ""}`;

  const summaryMessage = booking?.message || "";
  const form = parseInquiryMessage(summaryMessage);

  const ctx = {
    brand: { ...brand, logoUrl },
    title: "Eingangsbestätigung deiner Buchungsanfrage",
    // greetingName: booking.firstName || "Sportler",
    greetingName: parentGreetingNameFromBooking(booking),
    summary: {
      offer: courseOnly(rawOffer),
      date: dateDE,
      age: booking.age,
    },
    form,
    isNonTrial,
    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },
  };

  if (isNonTrial) {
    ctx.summary.level = "";
    ctx.summary.age = "";
    ctx.form.child = "";
    ctx.form.birthdate = "";
  }

  const html = renderMjmlFile("templates/emails/booking-ack.mjml", ctx);

  const attachments = logoAttachment ? [logoAttachment] : [];
  await sendMail({
    to,
    subject: "Eingangsbestätigung – deine Buchungsanfrage",
    html,
    text: "",
    attachments,
  });
}

async function sendBookingProcessingEmail({
  to,
  booking,
  offer,
  isNonTrial = false,
}) {
  if (!to) return;
  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const programLabel = buildProgramLabel(offer, booking);

  const ctx = {
    brand: { ...brand, logoUrl },
    title: "Deine Buchung ist in Bearbeitung",
    greetingName: booking.firstName || "Sportler",
    booking: {
      program: programLabel,
      date: booking.date || "",
      code: booking.confirmationCode || "",
    },
    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },
  };

  const html = renderMjmlFile("templates/emails/booking-processing.mjml", ctx);
  const attachments = logoAttachment ? [logoAttachment] : [];
  await sendMail({
    to,
    subject: "Status-Update – in Bearbeitung",
    html,
    text: "",
    attachments,
  });
}

async function sendBookingCancelledEmail({ to, booking }) {
  if (!to || !booking) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: booking.firstName || "Sportfreund",
    headline: "Absage Kurs findet nicht statt",
    program: booking.program || booking.level || "Programm",
    dateDE: booking.date
      ? new Date(booking.date).toLocaleDateString("de-DE")
      : "",
    confirmationCode: booking.confirmationCode || "",
    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },
    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
      website: brand.website,
    },
  };

  const html = renderMjmlFile("templates/emails/booking-cancelled.mjml", ctx);

  const text = [
    `Hallo ${ctx.greetingName},`,
    "",
    `leider müssen wir deine Buchung stornieren.`,
    `Programm: ${ctx.program}`,
    ctx.dateDE ? `Datum: ${ctx.dateDE}` : "",
    ctx.confirmationCode ? `Referenz: ${ctx.confirmationCode}` : "",
    "",
    "Bei Fragen kannst du einfach auf diese E-Mail antworten.",
    "",
    `${ctx.signature.signoff}`,
    ctx.signature.name,
  ]
    .filter(Boolean)
    .join("\n");

  await sendMail({
    to,
    subject: `Absage – ${ctx.program}${ctx.dateDE ? ` am ${ctx.dateDE}` : ""}${ctx.confirmationCode ? ` (${ctx.confirmationCode})` : ""}`,
    text,
    html,
    attachments: logoAttachment ? [logoAttachment] : [],
  });
}

async function sendInvoicePaidEmail({ to, customer, booking, offer }) {
  if (!to || !booking || !offer) return;

  const invoiceNo = String(
    booking?.invoiceNo || booking?.invoiceNumber || "",
  ).trim();
  const invoiceDateRaw = booking?.invoiceDate || "";
  const invoiceDate = invoiceDateRaw ? new Date(invoiceDateRaw) : null;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const pdfBuffer = await buildParticipationPdf({
    customer,
    booking,
    offer,
    invoiceNo,
    invoiceDate: invoiceDateRaw,
    monthlyAmount: booking?.monthlyAmount,
    firstMonthAmount: booking?.firstMonthAmount,
    venue: booking?.venue || offer?.location || "",
  });

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: booking?.firstName || "Kunde",
    headline: "Rechnung",
    note: "Die Rechnung findest du als PDF im Anhang.",
    invoice: {
      invoiceNo: invoiceNo || "",
      invoiceDate: invoiceDate
        ? new Intl.DateTimeFormat("de-DE").format(invoiceDate)
        : "",
      offer:
        booking?.offerTitle ||
        booking?.offerType ||
        offer?.title ||
        offer?.sub_type ||
        offer?.type ||
        "",
      items: [],
      total: "",
      refInvoiceNo: "",
      refInvoiceDate: "",
    },
    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },
    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
    },
  };

  const html = renderMjmlFile("templates/emails/invoice.mjml", ctx);

  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    {
      filename: "Rechnung.pdf",
      content: pdfBuffer,
      contentType: "application/pdf",
    },
  ];

  await sendMail({
    to,
    subject: invoiceNo ? `Rechnung – ${invoiceNo}` : "Rechnung",
    text: "",
    html,
    attachments,
  });
}

//teil2

async function sendPasswordResetMail(to, resetLink) {
  if (!to || !resetLink) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  let html;
  try {
    html = renderMjmlFile("templates/emails/password-reset.mjml", {
      brand: { ...brand, logoUrl },
      title: "Passwort zurücksetzen",
      intro: "Wir haben eine Anfrage erhalten, dein Passwort zurückzusetzen.",
      ctaText: "Neues Passwort festlegen",
      resetLink,
      note: "Dieser Link ist 1 Stunde gültig. Wenn du die Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren.",
      signature: {
        signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
        name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
      },
    });
  } catch {
    html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#111827">
        <p>Hallo,</p>
        <p>wir haben eine Anfrage erhalten, dein Passwort zurückzusetzen.</p>
        <p><a href="${resetLink}" style="display:inline-block;padding:10px 14px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Neues Passwort festlegen</a></p>
        <p>Oder öffne den folgenden Link:<br><a href="${resetLink}">${resetLink}</a></p>
        <p>Dieser Link ist 1 Stunde gültig. Wenn du die Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren.</p>
        <p>${process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen"}<br/>${process.env.MAIL_SIGNER || "Selcuk Kocyigit"}</p>
      </div>
    `;
  }

  const attachments = logoAttachment ? [logoAttachment] : [];
  await sendMail({
    to,
    subject:
      (process.env.APP_NAME || "KickStart Academy") +
      " • Passwort zurücksetzen",
    html,
    text: "",
    attachments,
  });
}

//teil2
async function sendStornoEmail({
  to,
  customer,
  booking,
  offer,
  pdfBuffer,
  amount,
  currency = "EUR",
}) {
  if (!to) return;

  function toFiniteAmount(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" && !String(value).trim()) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  const effectiveAmount =
    toFiniteAmount(amount) ??
    toFiniteAmount(booking?.stornoAmount) ??
    toFiniteAmount(booking?.priceAtBooking) ??
    toFiniteAmount(booking?.amount) ??
    (offer && typeof offer.price === "number" ? offer.price : 0);

  const shaped = shapeStornoData({
    customer,
    booking,
    offer,
    amount: effectiveAmount,
    currency,
  });

  if (offer) {
    shaped.booking.offerTitle = shaped.booking.offerTitle || offer.title || "";
    shaped.booking.offerType =
      shaped.booking.offerType || offer.sub_type || offer.type || "";
    shaped.booking.venue = shaped.booking.venue || offer.location || "";
  }

  const ensureBuf =
    pdfBuffer ||
    (await buildStornoPdf({
      customer: shaped.customer,
      booking: shaped.booking,
      offer,
      amount: effectiveAmount,
      currency: shaped.currency,
    }));

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();
  const signature = {
    signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
    name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
  };

  const stornoNo =
    booking?.stornoNo ||
    shaped.booking?.stornoNo ||
    `STORNO-${String(shaped.booking._id || "")
      .slice(-6)
      .toUpperCase()}`;

  const refInvoiceNo =
    shaped.booking.refInvoiceNo ||
    shaped.booking.originalInvoiceNo ||
    shaped.booking.invoiceNo ||
    shaped.booking.invoiceNumber ||
    "";

  const refInvoiceDate =
    shaped.booking.refInvoiceDate ||
    shaped.booking.originalInvoiceDate ||
    shaped.booking.invoiceDate ||
    "";

  const refInvoiceDateDE = refInvoiceDate
    ? new Intl.DateTimeFormat("de-DE").format(new Date(refInvoiceDate))
    : "";

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: fullName(shaped.customer.parent) || "Kunde",
    headline: "Storno-Rechnung",
    note: "Wir bestätigen die Stornierung. Die Storno-Rechnung findest du im Anhang.",
    invoice: {
      invoiceNo: stornoNo,
      invoiceDate: new Date(
        shaped.booking.cancelDate || Date.now(),
      ).toLocaleDateString("de-DE"),
      offer: shaped.booking.offerTitle || shaped.booking.offerType || "",
      items: [
        {
          desc: "Storno",
          qty: 1,
          amount: eur(effectiveAmount, shaped.currency),
        },
      ],
      total: eur(effectiveAmount, shaped.currency),
      refInvoiceNo,
      refInvoiceDate: refInvoiceDateDE || refInvoiceDate,
    },
    signature,
    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
    },
  };

  const html = renderMjmlFile("templates/emails/invoice.mjml", ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    { filename: "Storno-Rechnung.pdf", content: ensureBuf },
  ];

  await sendMail({
    to,
    subject: "Stornorechnung",
    text: "",
    html,
    attachments,
  });
}

async function sendCreditNoteEmail({
  to,
  customer,
  booking,
  offer,
  creditNo,
  creditDate,
  amount,
  currency = "EUR",
  pdfBuffer,
  reason,
}) {
  if (!to || !pdfBuffer) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const signature = {
    signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
    name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
  };

  const no =
    String(creditNo || booking?.meta?.creditNoteNo || "").trim() ||
    "Gutschrift";

  const d = creditDate ? new Date(creditDate) : new Date();
  const dateDE =
    d && !Number.isNaN(d.getTime())
      ? new Intl.DateTimeFormat("de-DE").format(d)
      : "";

  const title =
    booking?.offerTitle ||
    booking?.offerType ||
    offer?.title ||
    offer?.sub_type ||
    offer?.type ||
    "Buchung";

  const why = String(reason || "").trim();

  const curr = String(currency || booking?.currency || "EUR").trim() || "EUR";
  const amt = Number.isFinite(Number(amount)) ? Number(amount) : 0;

  const refInvoiceNo = String(
    booking?.invoiceNo || booking?.invoiceNumber || "",
  ).trim();

  const refInvoiceDate = booking?.invoiceDate
    ? new Intl.DateTimeFormat("de-DE").format(new Date(booking.invoiceDate))
    : "";

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: fullName(customer?.parent) || "Kunde",
    headline: "Gutschrift",
    note: why
      ? `Wir bestätigen die Rückerstattung. Hinweis: ${why}`
      : "Wir bestätigen die Rückerstattung. Die Gutschrift findest du als PDF im Anhang.",
    invoice: {
      invoiceNo: no,
      invoiceDate: dateDE,
      offer: title,
      items: [{ desc: "Rückerstattung", qty: 1, amount: eur(amt, curr) }],
      total: eur(amt, curr),
      refInvoiceNo,
      refInvoiceDate,
    },
    signature,
    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
    },
  };

  const html = renderMjmlFile("templates/emails/invoice.mjml", ctx);

  const safeNo = String(no).replace(/[^\w.-]+/g, "_");
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    {
      filename: `Gutschrift-${safeNo}.pdf`,
      content: pdfBuffer,
      contentType: "application/pdf",
    },
  ];

  await sendMail({
    to,
    subject: no ? `Gutschrift – ${no}` : "Gutschrift",
    text: "",
    html,
    attachments,
  });
}
//teil2

async function sendBookingConfirmationEmail({ to, booking, pdfBuffer }) {
  if (!to) return;

  const when = booking?.date ? String(booking.date).slice(0, 10) : "-";
  const title = booking?.level || booking?.program || "Buchung";

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#111827">
      <p>Hallo,</p>
      <p>anbei deine Bestätigung.</p>
      <ul>
        <li><strong>Programm:</strong> ${title}</li>
        <li><strong>Datum:</strong> ${when}</li>
      </ul>
      <p>Mit sportlichen Grüßen<br/>Selcuk Kocyigit</p>
    </div>
  `;

  await sendMail({
    to,
    subject: "Bestätigung",
    text: "",
    html,
    attachments: pdfBuffer
      ? [{ filename: "Bestaetigung.pdf", content: pdfBuffer }]
      : [],
  });
}

async function verifySmtp() {
  return getTransporter().verify();
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

function parentPartsFromBooking(booking) {
  const invoiceParent = booking?.invoiceTo?.parent || {};
  const parent = booking?.parent || {};
  const customerParent = booking?.customer?.parent || {};

  return {
    salutation:
      safeText(invoiceParent?.salutation) ||
      safeText(parent?.salutation) ||
      safeText(customerParent?.salutation),
    firstName:
      safeText(invoiceParent?.firstName) ||
      safeText(parent?.firstName) ||
      safeText(customerParent?.firstName),
    lastName:
      safeText(invoiceParent?.lastName) ||
      safeText(parent?.lastName) ||
      safeText(customerParent?.lastName),
    email:
      safeText(invoiceParent?.email) ||
      safeText(parent?.email) ||
      safeText(customerParent?.email) ||
      safeText(booking?.email),
  };
}

function parentGreetingNameFromBooking(booking) {
  const parent = parentPartsFromBooking(booking);
  const full = [safeText(parent.firstName), safeText(parent.lastName)]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (full) return full;

  return "Sportler";
}

function childFullOnlyFromBooking(booking) {
  const childFromName = splitChildName(booking?.childName);
  const childObj =
    booking?.child && typeof booking.child === "object" ? booking.child : null;

  const explicitFirst =
    safeText(booking?.childFirstName) ||
    safeText(childFromName.firstName) ||
    safeText(childObj?.firstName);

  const explicitLast =
    safeText(booking?.childLastName) ||
    safeText(childFromName.lastName) ||
    safeText(childObj?.lastName);

  const explicitCombined = [explicitFirst, explicitLast]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (explicitCombined) return explicitCombined;

  const childRaw =
    safeText(childObj?.fullName) ||
    safeText(childObj?.name) ||
    (typeof booking?.child === "string" ? safeText(booking.child) : "");

  if (childRaw && !/^[a-f\d]{24}$/i.test(childRaw)) {
    return childRaw;
  }

  const hasChildSignal =
    !!safeText(booking?.childUid) ||
    !!safeText(booking?.childId) ||
    !!safeText(booking?.childName) ||
    !!safeText(booking?.childFirstName) ||
    !!safeText(booking?.childLastName) ||
    !!childObj ||
    (typeof booking?.child === "string" &&
      !/^[a-f\d]{24}$/i.test(booking.child));

  if (!hasChildSignal) return "";

  const parent = parentPartsFromBooking(booking);
  const participantFirst = safeText(booking?.firstName);
  const participantLast = safeText(booking?.lastName);
  const participantFull = [participantFirst, participantLast]
    .filter(Boolean)
    .join(" ")
    .trim();

  const parentFull = [safeText(parent.firstName), safeText(parent.lastName)]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!participantFull) return "";
  if (
    parentFull &&
    participantFull.toLowerCase() === parentFull.toLowerCase()
  ) {
    return "";
  }

  return participantFull;
}

function childFullFromBooking(booking) {
  const childFromName = splitChildName(booking?.childName);

  const first =
    safeText(booking?.childFirstName) || safeText(childFromName.firstName);

  const last =
    safeText(booking?.childLastName) || safeText(childFromName.lastName);

  return [first, last].filter(Boolean).join(" ").trim();
}

async function sendCancellationEmail({
  to,
  customer,
  booking,
  offer,
  pdfBuffer,
}) {
  if (!to) return;

  const refInvoiceNo =
    booking?.refInvoiceNo || booking?.invoiceNumber || booking?.invoiceNo || "";
  const refInvoiceDate = booking?.refInvoiceDate || booking?.invoiceDate || "";

  const cancelDate = booking?.cancelDate || new Date();
  const cancelReason = booking?.cancelReason || "";
  const cancellationNo =
    booking?.cancellationNo || booking?.cancellationNumber || "";

  const endDateRaw = booking?.endDate || null;
  const endDateDE = endDateRaw
    ? new Intl.DateTimeFormat("de-DE").format(new Date(endDateRaw))
    : "";

  const childFull = childFullFromBooking(booking, customer);

  const ensureBuf =
    pdfBuffer ||
    (await buildCancellationPdf({
      customer,
      booking,
      offer,
      date: cancelDate || null,
      endDate: endDateRaw || null,
      reason: cancelReason,
      cancellationNo: cancellationNo || undefined,
      refInvoiceNo: refInvoiceNo || undefined,
      refInvoiceDate: refInvoiceDate || undefined,
    }));

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: fullName(customer?.parent) || "Kunde",

    blocks: {
      locationTitle: "Standort",
      bookingTitle: "Deine Buchung",
      invoiceTitle: "Referenzrechnung",
      invoiceNote: "",
    },

    location: {
      club: booking?.venue || offer?.location || "",
      address: [booking?.venue || offer?.location || ""]
        .filter(Boolean)
        .join(", "),
    },

    customer: {
      childFull,
      parentFull: fullName(customer?.parent),
    },

    booking: {
      offer:
        booking?.offerTitle || booking?.offerType || offer?.title || "Buchung",
      bookingDate: booking?.date || "",
      venue: booking?.venue || offer?.location || "",
      cancelDate: cancelDate,
      cancelReason,
    },

    invoice: {
      number: refInvoiceNo || "",
      date: refInvoiceDate
        ? new Intl.DateTimeFormat("de-DE").format(new Date(refInvoiceDate))
        : "",
    },

    cancellation: {
      number: cancellationNo || "",
      date: cancelDate
        ? new Intl.DateTimeFormat("de-DE").format(new Date(cancelDate))
        : "",
      endDate: endDateDE || "",
    },

    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },

    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
      disclaimer:
        "This e-mail may contain confidential and/or privileged information. If you are not the intended recipient, please notify the sender and destroy this e-mail.",
    },
  };

  const html = renderMjmlFile("templates/emails/cancellation.mjml", ctx);

  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    { filename: "Kuendigungsbestaetigung.pdf", content: ensureBuf },
  ];

  await sendMail({
    to,
    subject: "Kündigungsbestätigung",
    text: "",
    html,
    attachments,
  });
}

async function sendBookingCancelledConfirmedEmail({
  to,
  booking,
  offer,
  isNonTrial = false,
}) {
  if (!to) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const dateDE = booking?.date
    ? new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(new Date(booking.date))
    : "";

  const venue = booking?.venue || offer?.location || "";

  const program = buildProgramLabel(offer, booking);

  const dayTimes = booking?.dayTimes || booking?.weekday || "";
  const timeDisplay =
    booking?.timeDisplay || booking?.time || booking?.uhrzeit || "";

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: booking.firstName || "Sportler",
    confirmationCode: booking.confirmationCode || "",
    dateDE,
    booking: { program, dayTimes, timeDisplay, venue },
    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },
  };

  const html = renderMjmlFile(
    "templates/emails/booking-cancelled-confirmed.mjml",
    ctx,
  );

  const attachments = logoAttachment ? [logoAttachment] : [];
  await sendMail({
    to,
    subject: `Absage des bestätigten Termins – ${program}${dateDE ? ` am ${dateDE}` : ""}`,
    text: "",
    html,
    attachments,
  });
}

async function sendParticipationEmail({
  to,
  customer,
  booking,
  offer,
  pdfBuffer,
}) {
  if (!to) return;

  const eur = (n) =>
    typeof n === "number" && Number.isFinite(n)
      ? new Intl.NumberFormat("de-DE", {
          style: "currency",
          currency: "EUR",
        }).format(n)
      : "";

  const fmtDE = (d) =>
    d
      ? new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin" }).format(
          d,
        )
      : "";

  function parseISOorDate(v) {
    if (!v) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    const s = String(v);
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function prorateForStart(startDateObj, monthlyPrice) {
    if (!(startDateObj instanceof Date)) return null;
    if (typeof monthlyPrice !== "number" || !Number.isFinite(monthlyPrice))
      return null;
    const y = startDateObj.getFullYear();
    const m = startDateObj.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const startDay = startDateObj.getDate();
    const daysRemaining = Math.max(0, daysInMonth - startDay + 1);
    const factor = Math.max(0, Math.min(1, daysRemaining / daysInMonth));
    return Math.round(monthlyPrice * factor * 100) / 100;
  }

  const offerCategory = safeText(offer?.category);
  const offerType = safeText(offer?.type);
  const offerSubType = safeText(offer?.sub_type).toLowerCase();

  const isExplicitNonWeekly =
    offerCategory === "ClubPrograms" ||
    offerCategory === "RentACoach" ||
    offerCategory === "Individual" ||
    offerCategory === "Powertraining" ||
    offerCategory === "Holiday" ||
    offerCategory === "HolidayPrograms" ||
    offerSubType.startsWith("rentacoach") ||
    offerSubType.includes("coacheducation") ||
    offerSubType.includes("trainingcamp") ||
    offerSubType.includes("trainingscamp");

  const isWeekly =
    !isExplicitNonWeekly &&
    (offerCategory === "Weekly" ||
      offerType === "Foerdertraining" ||
      offerType === "Kindergarten");

  const revocationUrl = isWeekly
    ? ""
    : (await ensureRevocationLink(booking)).revocationUrl;

  const monthlyRaw = isWeekly
    ? typeof booking?.monthlyAmount === "number"
      ? booking.monthlyAmount
      : typeof booking?.priceMonthly === "number"
        ? booking.priceMonthly
        : typeof offer?.price === "number"
          ? offer.price
          : undefined
    : undefined;
  const monthly =
    typeof monthlyRaw === "number" && Number.isFinite(monthlyRaw)
      ? monthlyRaw
      : undefined;

  const startDateObj = parseISOorDate(booking?.date);
  const startDE = fmtDE(startDateObj);

  const firstMonth = isWeekly
    ? typeof booking?.firstMonthAmount === "number"
      ? booking.firstMonthAmount
      : prorateForStart(startDateObj, monthly)
    : undefined;

  const invoiceNo = booking?.invoiceNumber || booking?.invoiceNo || "";
  const invoiceDate = booking?.invoiceDate || "";
  const invoiceDateDE = invoiceDate ? fmtDE(new Date(invoiceDate)) : "";

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();
  const signature = {
    signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
    name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
  };

  const invParent = booking?.invoiceTo?.parent || {};
  const invAddr = booking?.invoiceTo?.address || {};

  const parentSal = invParent?.salutation || customer?.parent?.salutation || "";
  const parentFn =
    invParent?.firstName ||
    customer?.parent?.firstName ||
    booking?.firstName ||
    "";
  const parentLn =
    invParent?.lastName ||
    customer?.parent?.lastName ||
    booking?.lastName ||
    "";

  const parentFullDisplay = [
    parentSal,
    [parentLn, parentFn].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(" ");

  const childFn = customer?.child?.firstName || booking?.firstName || "";
  const childLn = customer?.child?.lastName || booking?.lastName || "";

  const childFull =
    booking?.childName ||
    [booking?.childFirstName, booking?.childLastName]
      .filter(Boolean)
      .join(" ") ||
    [booking?.firstName, booking?.lastName].filter(Boolean).join(" ") ||
    booking?.child ||
    "";

  const street =
    safeText(invAddr?.street) || safeText(customer?.address?.street);
  const house =
    safeText(invAddr?.houseNo) || safeText(customer?.address?.houseNo);
  const zip = safeText(invAddr?.zip) || safeText(customer?.address?.zip);
  const city = safeText(invAddr?.city) || safeText(customer?.address?.city);

  const addressLine1 = [street, house].filter(Boolean).join(" ").trim();
  const addressLine2 = [zip, city].filter(Boolean).join(" ").trim();
  const addressLine = [addressLine1, addressLine2].filter(Boolean).join(", ");

  const parentEmail =
    invParent?.email ||
    customer?.parent?.email ||
    customer?.email ||
    booking?.email ||
    "";

  const parentPhone =
    invParent?.phone || customer?.parent?.phone || booking?.phone || "";

  const course =
    booking?.offerTitle ||
    booking?.offerType ||
    offer?.title ||
    offer?.sub_type ||
    offer?.type ||
    "Buchung";

  const venue = booking?.venue || offer?.location || "";

  const weekdayDE = (() => {
    if (!booking?.date) return "";
    const d = /^\d{4}-\d{2}-\d{2}$/.test(booking.date)
      ? new Date(`${booking.date}T00:00:00`)
      : new Date(booking.date);
    return d && !Number.isNaN(d.getTime())
      ? new Intl.DateTimeFormat("de-DE", { weekday: "long" }).format(d)
      : "";
  })();

  const formTag =
    booking?.tag || booking?.Tag || booking?.weekday || booking?.wpTag || "";
  const formTime =
    booking?.zeit ||
    booking?.time ||
    booking?.uhrzeit ||
    booking?.preferredTime ||
    "";

  //teil3

  function findTimeRangeFromOffer(off, weekdayName) {
    if (!off) return "";

    const joinRange = (from, to) => {
      const f = from ? String(from).trim() : "";
      const t = to ? String(to).trim() : "";
      return [f, t].filter(Boolean).join(" – ");
    };

    if (Array.isArray(off.days) && off.days.length) {
      const norm = (v) => String(v || "").toLowerCase();
      const weekdayNorm = norm(weekdayName);

      let cand =
        off.days.find(
          (d) =>
            norm(d?.day) === weekdayNorm ||
            norm(d?.weekday) === weekdayNorm ||
            norm(d?.tag) === weekdayNorm,
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

        if (from || to) return joinRange(from, to);

        const t = cand.time ?? cand.zeit ?? cand.uhrzeit;
        if (t)
          return String(t)
            .replace(/\s*-\s*/g, " – ")
            .trim();
      }
    }

    const from = off.timeFrom ?? off.from ?? off.start;
    const to = off.timeTo ?? off.to ?? off.end;
    if (from || to) return joinRange(from, to);

    const t = off.time ?? off.zeit ?? off.uhrzeit;
    return t
      ? String(t)
          .replace(/\s*-\s*/g, " – ")
          .trim()
      : "";
  }

  const offerTime = findTimeRangeFromOffer(offer, weekdayDE);
  const tagDisplay = formTag || weekdayDE || "";
  const timeDisplay = formTime || offerTime || "";
  const dayTimeLine = tagDisplay
    ? timeDisplay
      ? `${tagDisplay}: ${timeDisplay}`
      : tagDisplay
    : timeDisplay || "";

  const ctx = {
    brand: { ...brand, logoUrl },
    revocationUrl,

    greetingName:
      [parentSal, parentFn, parentLn].filter(Boolean).join(" ") || "Kunde",

    blocks: {
      locationTitle: "Standort",
      contactTitle: "Deine Kontaktdaten",
      bookingTitle: "Deine Buchung",
      agentTitle: "Dein Ansprechpartner",
      invoiceTitle: "Die Rechnung",
      invoiceNote: "Die Rechnung findest du als PDF im Anhang.",
    },

    location: {
      club: venue,
      address: venue,
    },

    customer: {
      parentFull: parentFullDisplay,
      childFull: childFull,
      email: parentEmail,
      phone: parentPhone,
      address: addressLine,

      addressLine1,
      addressLine2,
    },

    booking: {
      childFull: childFull,
      offer: course,
      bookingDate: booking?.date || "",
      bookingDateDE: startDE || "",
      venue: venue,
      dayTime: dayTimeLine,
      timeDisplay: timeDisplay,

      dayTimes: tagDisplay,
    },

    price: {
      monthly: monthly != null ? eur(monthly) : "",
      firstMonth: firstMonth != null ? eur(firstMonth) : "",
      currency: "EUR",
      startDate: booking?.date || "",
    },

    invoice: {
      number: invoiceNo || "",
      date: invoiceDateDE || invoiceDate || "",
    },

    signature,
    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
    },
  };

  const ensureBuf =
    pdfBuffer ||
    (await buildParticipationPdf({
      customer,
      booking,
      offer,
      invoiceNo,
      invoiceDate,
      monthlyAmount: monthly,
      firstMonthAmount: firstMonth,
      venue,
    }));

  const html = renderMjmlFile("templates/emails/participation.mjml", ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    { filename: "Teilnahmebestaetigung.pdf", content: ensureBuf },
  ];

  // console.log(
  //   "[sendParticipationEmail] html has revoke text:",
  //   html.includes("Vertrag widerrufen"),
  // );
  // console.log(
  //   "[sendParticipationEmail] html has revoke url:",
  //   html.includes(revocationUrl),
  // );

  await sendMail({
    to,
    subject: "Teilnahmebestätigung",
    text: "",
    html,
    attachments,
  });
}

async function sendBookingConfirmedEmail({
  to,
  booking,
  offer,
  pdfBuffer,
  isNonTrial = false,
}) {
  if (!to) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const dateDE = booking?.date
    ? new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(new Date(booking.date))
    : "";

  const weekdayDE = (() => {
    const s = booking?.date ? String(booking.date) : "";
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s)
      ? new Date(`${s}T00:00:00`)
      : s
        ? new Date(s)
        : null;
    return d && !Number.isNaN(d.getTime())
      ? new Intl.DateTimeFormat("de-DE", { weekday: "long" }).format(d)
      : "";
  })();

  function findTimeRangeFromOffer(off, weekdayName) {
    if (!off) return "";

    const joinRange = (from, to) => {
      const f = from ? String(from).trim() : "";
      const t = to ? String(to).trim() : "";
      return [f, t].filter(Boolean).join(" – ");
    };

    if (Array.isArray(off.days) && off.days.length) {
      const norm = (v) => String(v || "").toLowerCase();
      const weekdayNorm = norm(weekdayName);

      let cand =
        off.days.find(
          (d) =>
            norm(d?.day) === weekdayNorm ||
            norm(d?.weekday) === weekdayNorm ||
            norm(d?.tag) === weekdayNorm,
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

        if (from || to) return joinRange(from, to);

        const t = cand.time ?? cand.zeit ?? cand.uhrzeit;
        if (t)
          return String(t)
            .replace(/\s*-\s*/g, " – ")
            .trim();
      }
    }

    const from = off.timeFrom ?? off.from ?? off.start;
    const to = off.timeTo ?? off.to ?? off.end;
    if (from || to) return joinRange(from, to);

    const t = off.time ?? off.zeit ?? off.uhrzeit;
    return t
      ? String(t)
          .replace(/\s*-\s*/g, " – ")
          .trim()
      : "";
  }

  const childFull = childFullOnlyFromBooking(booking);

  const dayTimes =
    booking.dayTimes || booking.kurstag || booking.weekday || weekdayDE || "";

  const timeDisplay =
    booking.timeDisplay ||
    booking.kurszeit ||
    booking.time ||
    booking.uhrzeit ||
    findTimeRangeFromOffer(offer, weekdayDE) ||
    "";

  const programLabel = buildProgramLabel(offer, booking);

  const offerCategory = safeText(offer?.category);
  const offerType = safeText(offer?.type);
  const offerSubType = safeText(offer?.sub_type).toLowerCase();

  const isExplicitNonWeekly =
    offerCategory === "ClubPrograms" ||
    offerCategory === "RentACoach" ||
    offerCategory === "Individual" ||
    offerCategory === "Powertraining" ||
    offerCategory === "Holiday" ||
    offerCategory === "HolidayPrograms" ||
    offerSubType.startsWith("rentacoach") ||
    offerSubType.includes("coacheducation") ||
    offerSubType.includes("trainingcamp") ||
    offerSubType.includes("trainingscamp") ||
    offerSubType.startsWith("clubprogram");

  const isWeekly =
    !isExplicitNonWeekly &&
    (offerCategory === "Weekly" ||
      offerType === "Foerdertraining" ||
      offerType === "Kindergarten");

  const isNoRevocationInConfirmedMail =
    offerCategory === "ClubPrograms" ||
    offerCategory === "RentACoach" ||
    offerCategory === "Individual" ||
    offerCategory === "Powertraining" ||
    offerCategory === "Holiday" ||
    offerCategory === "HolidayPrograms" ||
    offerSubType.startsWith("rentacoach") ||
    offerSubType.includes("coacheducation") ||
    offerSubType.includes("trainingcamp") ||
    offerSubType.includes("trainingscamp") ||
    offerSubType.startsWith("clubprogram") ||
    offerSubType.includes("powertraining");

  const revocationUrl =
    isWeekly || isNoRevocationInConfirmedMail
      ? ""
      : (await ensureRevocationLink(booking)).revocationUrl;

  const subject = `Termin bestätigt – ${programLabel} am ${booking.date || ""}`;

  const ctx = {
    brand: { ...brand, logoUrl },
    title: "Terminbestätigung",
    //greetingName: booking.firstName || "Sportler",
    greetingName: parentGreetingNameFromBooking(booking),
    revocationUrl,
    booking: {
      program: programLabel,
      date: dateDE,
      code: booking.confirmationCode || "",
      childFull,
      dayTimes,
      timeDisplay,
    },
    isNonTrial,
    childLabel: isNonTrial ? "Name" : "Kind",

    message: "Im Anhang findest du die Terminbestätigung als PDF.",
    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },
  };

  const html = renderMjmlFile("templates/emails/booking-confirmed.mjml", ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    ...(pdfBuffer
      ? [{ filename: "Terminbestaetigung.pdf", content: pdfBuffer }]
      : []),
  ];

  await sendMail({ to, subject, html, attachments, text: "" });
}

async function sendDunningEmail({
  to,
  customer,
  booking,
  stage,
  feeSnapshot,
  dueAt,
  freeText,
  sentAt = new Date(),
  subject: subjectOverride,
}) {
  if (!to) return;

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

  function fmtDateDe(value) {
    if (!value) return "";
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("de-DE").format(d);
  }

  function labelForStage(value) {
    const s = String(value || "").trim();
    if (s === "reminder") return "Zahlungserinnerung";
    if (s === "dunning1") return "1. Mahnung";
    if (s === "dunning2") return "2. Mahnung";
    if (s === "final") return "Letzte Mahnung";
    return "Mahnung";
  }

  //teil3
  function bookingDocNoLocal(doc = {}) {
    return String(
      doc?.invoiceNo ||
        doc?.invoiceNumber ||
        doc?.refInvoiceNo ||
        doc?.cancellationNo ||
        doc?.stornoNo ||
        doc?.stornoNumber ||
        "",
    ).trim();
  }

  function bookingDocDateLocal(doc = {}) {
    return (
      doc?.invoiceDate || doc?.refInvoiceDate || doc?.originalInvoiceDate || ""
    );
  }

  function bookingBaseAmountLocal(doc = {}) {
    const candidates = [
      doc?.priceAtBooking,
      doc?.stornoAmount,
      doc?.amount,
      doc?.price,
    ];

    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }

    return 0;
  }

  function dunningFileNameLocal(currentStage, doc = {}) {
    const labelMap = {
      reminder: "zahlungserinnerung",
      dunning1: "mahnung-1",
      dunning2: "mahnung-2",
      final: "letzte-mahnung",
    };

    const label = labelMap[currentStage] || "mahnung";
    const rawDocNo = bookingDocNoLocal(doc) || String(doc?._id || "dokument");
    const safeDocNo = String(rawDocNo).replace(/[^\w.-]+/g, "_");
    return `${label}-${safeDocNo}.pdf`;
  }

  function salutationLine(parent = {}) {
    const sal = String(parent?.salutation || "").trim();
    const lastName = String(parent?.lastName || "").trim();

    if (sal && lastName) return `${sal} ${lastName},`;
    if (lastName) return `Sehr geehrte/r ${lastName},`;
    return "Sehr geehrte Damen und Herren,";
  }

  function stageMailIntroText({
    stageValue,
    docNoValue,
    docDateTextValue,
    dueAtTextValue,
    returnBankFeeTextValue,
  }) {
    const refLine =
      docNoValue && docDateTextValue
        ? `zu Ihrer Rechnung ${docNoValue} vom ${docDateTextValue}`
        : docNoValue
          ? `zu Ihrer Rechnung ${docNoValue}`
          : "zu Ihrer offenen Forderung";

    if (stageValue === "reminder") {
      const feeLine = returnBankFeeTextValue
        ? ` Dadurch sind zusätzliche Rücklastschriftgebühren in Höhe von ${returnBankFeeTextValue} angefallen, die wir Ihnen weiterberechnen müssen.`
        : "";
      const dueLine = dueAtTextValue
        ? ` Bitte gleichen Sie die offene Forderung bis spätestens ${dueAtTextValue} aus.`
        : " Bitte gleichen Sie die offene Forderung zeitnah aus.";
      return `anbei erhalten Sie unsere Zahlungserinnerung ${refLine}. Die Lastschrift konnte von Ihrer Bank nicht erfolgreich eingelöst werden.${feeLine}${dueLine}`;
    }

    if (stageValue === "dunning1") {
      const dueLine = dueAtTextValue
        ? ` Bitte begleichen Sie den offenen Betrag bis spätestens ${dueAtTextValue}.`
        : " Bitte begleichen Sie den offenen Betrag zeitnah.";
      return `anbei erhalten Sie unsere 1. Mahnung ${refLine}. Trotz unserer zuvor versandten Zahlungserinnerung konnten wir bislang keinen Zahlungseingang feststellen.${dueLine}`;
    }

    if (stageValue === "dunning2") {
      const dueLine = dueAtTextValue
        ? ` Wir fordern Sie erneut auf, den offenen Gesamtbetrag bis spätestens ${dueAtTextValue} zu begleichen.`
        : " Wir fordern Sie erneut auf, den offenen Gesamtbetrag zeitnah zu begleichen.";
      return `anbei erhalten Sie unsere 2. Mahnung ${refLine}. Trotz unserer bisherigen Schreiben konnten wir bislang keinen vollständigen Zahlungseingang feststellen.${dueLine}`;
    }

    if (stageValue === "final") {
      const dueLine = dueAtTextValue
        ? ` Bitte zahlen Sie den offenen Gesamtbetrag letztmalig bis spätestens ${dueAtTextValue}.`
        : " Bitte zahlen Sie den offenen Gesamtbetrag letztmalig unverzüglich.";
      return `anbei erhalten Sie unsere Letzte Mahnung ${refLine}.${dueLine} Sollte die Zahlung nicht fristgerecht eingehen, behalten wir uns vor, ohne weitere Ankündigung gerichtliche Schritte bzw. die Übergabe an ein Inkassoverfahren einzuleiten.`;
    }

    return `anbei erhalten Sie unsere Mahnung ${refLine}.`;
  }

  function stageMailClosingText(stageValue) {
    if (stageValue === "final") {
      return "Hat sich diese Mahnung mit Ihrer Zahlung überschnitten, bitten wir Sie, dieses Schreiben als gegenstandslos zu betrachten.";
    }
    return "Sofern Sie die Zahlung zwischenzeitlich veranlasst haben, bitten wir Sie, dieses Schreiben als gegenstandslos zu betrachten.";
  }

  const parent = customer?.parent || {};
  const greetingName =
    [parent.firstName, parent.lastName].filter(Boolean).join(" ").trim() ||
    "Kunde";

  const fee = feeSnapshot || {};
  const currency = String(fee.currency || booking?.currency || "EUR");

  const baseAmount = bookingBaseAmountLocal(booking || {});
  const returnBankFee = Number(fee.returnBankFee || 0) || 0;
  const dunningFee = Number(fee.dunningFee || 0) || 0;
  const processingFee = Number(fee.processingFee || 0) || 0;

  const totalExtraFees =
    fee.totalExtraFees != null
      ? Number(fee.totalExtraFees) || 0
      : returnBankFee + dunningFee + processingFee;

  const totalDue = Math.round((baseAmount + totalExtraFees) * 100) / 100;

  const stageValue = String(stage || "").trim();
  const stageLabel = labelForStage(stageValue);

  const docNo = bookingDocNoLocal(booking || {});
  const docDate = bookingDocDateLocal(booking || {});
  const docDateText = fmtDateDe(docDate);

  const dueAtText = fmtDateDe(dueAt);

  const bookingTitle =
    booking?.offerTitle || booking?.offerType || booking?.offer || "Buchung";

  const freeTextClean = String(freeText || "").trim();

  const introText = stageMailIntroText({
    stageValue,
    docNoValue: docNo,
    docDateTextValue: docDateText,
    dueAtTextValue: dueAtText,
    returnBankFeeTextValue: euro(returnBankFee, currency),
  });

  const closingText = stageMailClosingText(stageValue);

  const mailModel = {
    greetingName,
    salutation: salutationLine(parent),
    stage: stageValue,
    stageLabel,
    docNo,
    docDate,
    docDateText,
    dueAtText,
    freeText: freeTextClean,
    booking: { offerTitle: bookingTitle },
    baseAmountText: euro(baseAmount, currency),
    returnBankFeeText: euro(returnBankFee, currency),
    dunningFeeText: euro(dunningFee, currency),
    processingFeeText: euro(processingFee, currency),
    totalDueText: euro(totalDue, currency),
    hasReturnBankFee: returnBankFee > 0,
    hasDunningFee: dunningFee > 0,
    hasProcessingFee: processingFee > 0,
    introText,
    closingText,
  };

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const html = renderMjmlFile("templates/emails/dunning-notice.mjml", {
    brand: { ...brand, logoUrl },
    ...mailModel,
    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
    },
    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },
  });

  const subjectDefault = docNo ? `${stageLabel} – ${docNo}` : `${stageLabel}`;

  const subject = String(subjectOverride || subjectDefault).trim();

  const textLines = [
    mailModel.salutation,
    "",
    mailModel.introText,
    "",
    docNo ? `Rechnung: ${docNo}` : "",
    docDateText ? `Rechnungsdatum: ${docDateText}` : "",
    `Offener Rechnungsbetrag: ${mailModel.baseAmountText}`,
    mailModel.hasReturnBankFee
      ? `Rücklastschriftgebühr: ${mailModel.returnBankFeeText}`
      : "",
    mailModel.hasDunningFee ? `Mahngebühr: ${mailModel.dunningFeeText}` : "",
    mailModel.hasProcessingFee
      ? `Bearbeitungsgebühr: ${mailModel.processingFeeText}`
      : "",
    `Gesamt offen: ${mailModel.totalDueText}`,
    dueAtText ? `Fällig bis: ${dueAtText}` : "",
    "",
    mailModel.closingText,
    freeTextClean ? "" : "",
    freeTextClean || "",
    "",
    "Mit sportlichen Grüßen",
    brand.company,
  ].filter((line, index, arr) => {
    if (line !== "") return true;
    return arr[index - 1] !== "";
  });

  const text = textLines.join("\n");

  const dunningPdfBuffer = await buildDunningPdf({
    customer,
    booking,
    stage: stageValue,
    issuedAt: sentAt,
    dueAt,
    feeSnapshot: {
      returnBankFee,
      dunningFee,
      processingFee,
      totalExtraFees,
      currency,
    },
    freeText: freeTextClean,
  });

  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    {
      filename: dunningFileNameLocal(stageValue, booking),
      content: dunningPdfBuffer,
      contentType: "application/pdf",
    },
  ];

  await sendMail({
    to,
    subject,
    text,
    html,
    attachments,
  });

  return { subject, text, html, pdfBuffer: dunningPdfBuffer };
}

async function sendDunningVoidedEmail({ owner, billingDocument, reason }) {
  const ownerStr = owner ? String(owner) : "";
  const doc = billingDocument || {};
  const customerId = doc.customerId ? String(doc.customerId) : "";
  const bookingId = doc.bookingId ? String(doc.bookingId) : "";

  if (!ownerStr || (!customerId && !bookingId)) return;

  const ownerFilter =
    ownerStr && mongoose.isValidObjectId(ownerStr) ? ownerStr : ownerStr;

  const customer =
    customerId && mongoose.isValidObjectId(customerId)
      ? await Customer.findOne({ _id: customerId, owner: ownerFilter }).lean()
      : null;

  const booking =
    bookingId && mongoose.isValidObjectId(bookingId)
      ? await Booking.findOne({ _id: bookingId, owner: ownerFilter }).lean()
      : null;

  const to = String(customer?.parent?.email || booking?.email || "").trim();
  if (!to) return;

  const stage = String(doc.stage || "").trim();
  const invoiceNo = String(doc.invoiceNo || "").trim();
  const stageLabel =
    stage === "reminder"
      ? "Zahlungserinnerung"
      : stage === "dunning1"
        ? "1. Mahnung"
        : stage === "dunning2"
          ? "2. Mahnung"
          : stage === "final"
            ? "Letzte Mahnung"
            : "Mahnung";

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const parent = customer?.parent || {};
  const sal = String(parent?.salutation || "").trim();
  const lastName = String(parent?.lastName || "").trim();
  const salutation =
    sal && lastName
      ? `${sal} ${lastName},`
      : lastName
        ? `Sehr geehrte/r ${lastName},`
        : "Sehr geehrte Damen und Herren,";

  const why = String(reason || "").trim();

  let html;
  try {
    html = renderMjmlFile("templates/emails/dunning-voided.mjml", {
      brand: { ...brand, logoUrl },
      salutation,
      stage,
      stageLabel,
      invoiceNo,
      reason: why,
      signature: {
        signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
        name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
      },
      legal: {
        line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
      },
    });
  } catch {
    html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#111827">
        <p>${salutation}</p>
        <p>hiermit informieren wir Sie, dass die zuvor versandte ${stageLabel}${invoiceNo ? ` (Rechnung ${invoiceNo})` : ""} gegenstandslos ist.</p>
        ${why ? `<p><strong>Hinweis:</strong> ${why}</p>` : ""}
        <p>${process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen"}<br/>${process.env.MAIL_SIGNER || "Selcuk Kocyigit"}</p>
        <p style="color:#6b7280;font-size:12px;margin-top:16px">${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}</p>
      </div>
    `;
  }

  const subject = invoiceNo
    ? `Gegenstandslos – ${stageLabel} – ${invoiceNo}`
    : `Gegenstandslos – ${stageLabel}`;

  const textLines = [
    salutation,
    "",
    `hiermit informieren wir Sie, dass die zuvor versandte ${stageLabel}${invoiceNo ? ` (Rechnung ${invoiceNo})` : ""} gegenstandslos ist.`,
    why ? "" : "",
    why ? `Hinweis: ${why}` : "",
    "",
    process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
    process.env.MAIL_SIGNER || "Selcuk Kocyigit",
  ].filter((line, index, arr) => {
    if (line !== "") return true;
    return arr[index - 1] !== "";
  });

  const attachments = logoAttachment ? [logoAttachment] : [];
  await sendMail({
    to,
    subject,
    text: textLines.join("\n"),
    html,
    attachments,
  });
}

//neu

async function sendWeeklyContractStartEmail({ to, booking, offer, token }) {
  if (!to || !booking || !token) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    process.env.BRAND_WEBSITE_URL ||
    "http://localhost:3000";

  //const actionUrl = `${String(base).replace(/\/+$/, "")}/weekly/start?token=${encodeURIComponent(token)}`;

  const actionUrl = `${String(base).replace(/\/+$/, "")}/weekly/contract?token=${encodeURIComponent(token)}`;

  const programLabel = buildProgramLabel(offer, booking);

  const ctx = {
    brand: { ...brand, logoUrl },
    title: "Zulassung – Vertrag unterschreiben & Abo starten",
    // greetingName: booking.firstName || "Sportler",
    greetingName: parentGreetingNameFromBooking(booking),
    intro:
      "Super – du bist zugelassen. Bitte unterschreibe jetzt den Vertrag. Danach wirst du direkt zur sicheren Zahlung (Abo) weitergeleitet.",
    booking: {
      program: programLabel,
      date: booking?.date || "",
      dateLabel: "Startdatum:",
      code: booking?.confirmationCode || "",
    },
    ctaText: "Vertrag unterschreiben & Abo starten",
    actionUrl,
    note: "Mit Klick auf den Button unterschreibst du digital und startest anschließend den Stripe-Checkout für das Abo.",
    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },
  };

  const html = renderMjmlFile(
    "templates/emails/weekly-contract-start.mjml",
    ctx,
  );

  const attachments = logoAttachment ? [logoAttachment] : [];
  await sendMail({
    to,
    subject: "Zulassung – Vertrag unterschreiben & Abo starten",
    html,
    text: "",
    attachments,
  });
}

async function sendWeeklyContractSignedEmail({
  to,
  booking,
  offer,
  pdfBuffer,
}) {
  if (!to || !booking || !pdfBuffer) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const programLabel = buildProgramLabel(offer, booking);

  const signedAt =
    booking?.meta && typeof booking.meta === "object"
      ? String(booking.meta.contractSignedAt || "").trim()
      : "";

  const ctx = {
    brand: { ...brand, logoUrl },
    title: "Vertrag unterschrieben",
    //greetingName: booking?.firstName || "Sportler",
    greetingName: parentGreetingNameFromBooking(booking),
    intro:
      "Vielen Dank. Dein Vertrag wurde digital unterschrieben. Den Vertrag findest du als PDF im Anhang.",
    booking: {
      program: programLabel,
      date: booking?.date || "",
      code: booking?.confirmationCode || "",
      signedAt,
    },
    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },
  };

  const html = renderMjmlFile(
    "templates/emails/weekly-contract-signed.mjml",
    ctx,
  );

  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    {
      filename: "Vertrag.pdf",
      content: pdfBuffer,
      contentType: "application/pdf",
    },
  ];

  await sendMail({
    to,
    subject: `DFS – Vertrag unterschrieben${programLabel ? ` – ${programLabel}` : ""}`,
    html,
    text: "",
    attachments,
  });
}

async function sendOneTimePaymentLinkEmail({ to, booking, offer, bookingId }) {
  if (!to || !booking || !bookingId) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    process.env.BRAND_WEBSITE_URL ||
    "http://localhost:3000";

  const actionUrl = `${String(base).replace(/\/+$/, "")}/pay?bookingId=${encodeURIComponent(String(bookingId))}`;

  const programLabel = buildProgramLabel(offer, booking);

  const ctx = {
    brand: { ...brand, logoUrl },
    title: "Zahlung freigegeben – jetzt sicher bezahlen",
    greetingName: parentGreetingNameFromBooking(booking),
    // greetingName: booking.firstName || "Sportler",
    intro:
      "Super – deine Zahlung wurde freigegeben. Bitte nutze jetzt den Link, um die Einmalzahlung sicher über Stripe abzuschließen.",
    booking: {
      program: programLabel,
      date: booking?.date || "",
      dateLabel: "Termin:",
      code: booking?.confirmationCode || "",
    },
    ctaText: "Jetzt sicher bezahlen",
    actionUrl,
    note: "Dies ist eine Einmalzahlung. Es gibt keinen Vertrag und kein Abo. Nach erfolgreicher Zahlung erhältst du automatisch die Rechnung als PDF.",
    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },
  };

  const html = renderMjmlFile(
    "templates/emails/weekly-contract-start.mjml",
    ctx,
  );

  const attachments = logoAttachment ? [logoAttachment] : [];

  await sendMail({
    to,
    subject: `DFS – Zahlung freigegeben${programLabel ? ` – ${programLabel}` : ""}`,
    html,
    text: "",
    attachments,
  });
}

async function sendWeeklySubscriptionActiveEmail({
  to,
  booking,
  offer,
  cancelUrl,
  revocationUrl,
}) {
  if (!to || !booking || !cancelUrl) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const programLabel = buildProgramLabel(offer, booking);

  // const tokenData = await ensureRevocationLink(booking);
  // const base = websiteBaseUrl();

  // const fallbackRevocationUrl = `${String(base).replace(/\/+$/, "")}/widerrufen/`;

  const tokenData = await ensureRevocationLink(booking);

  const ctx = {
    brand: { ...brand, logoUrl },
    title: "Abo aktiv – Teilnahme bestätigt",
    greetingName: parentGreetingNameFromBooking(booking),
    // greetingName: booking?.firstName || "Sportler",
    intro:
      "Dein Abo ist jetzt aktiv. Deine Teilnahme ist bestätigt. Über den folgenden Link kannst du dein Abo kündigen.",
    booking: {
      program: programLabel,
      date: booking?.date || "",
      code: booking?.confirmationCode || "",
    },
    // revocationUrl: revocationUrl || fallbackRevocationUrl,
    revocationUrl: tokenData.revocationUrl || "",
    // revocationUrl: tokenData.revocationUrl || fallbackRevocationUrl,
    ctaText: "Abo kündigen",
    actionUrl: cancelUrl,
    note: "Die Kündigung erfolgt gemäß deiner Vertragsbedingungen automatisch zum hinterlegten Kündigungstermin.",
    signature: {
      signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
      name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
    },
  };

  const html = renderMjmlFile(
    "templates/emails/weekly-subscription-active.mjml",
    ctx,
  );

  const attachments = logoAttachment ? [logoAttachment] : [];

  await sendMail({
    to,
    subject: `DFS – Abo aktiv${programLabel ? ` – ${programLabel}` : ""}`,
    html,
    text: "",
    attachments,
  });
}

module.exports = {
  sendMail,
  verifySmtp,

  sendBookingAckEmail,
  sendBookingProcessingEmail,
  sendBookingCancelledEmail,
  sendBookingConfirmedEmail,

  sendParticipationEmail,
  sendCancellationEmail,
  sendStornoEmail,

  sendPasswordResetMail,
  sendBookingConfirmationEmail,

  sendBookingCancelledConfirmedEmail,
  sendDunningEmail,
  sendDunningVoidedEmail,

  sendInvoicePaidEmail,
  sendWeeklyContractStartEmail,

  sendWeeklyContractSignedEmail,
  sendOneTimePaymentLinkEmail,

  sendCreditNoteEmail,
  sendWeeklySubscriptionActiveEmail,
};
