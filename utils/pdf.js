// utils/pdf.js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

/* ===================== Config / Design Tokens ===================== */
const mm = (v) => (v * 72) / 25.4; // mm -> pt

const BRAND = {
  company: process.env.BRAND_COMPANY || 'KickStart Academy',
  addr1:   process.env.BRAND_ADDR_LINE1 || 'Beispielstraße 1',
  addr2:   process.env.BRAND_ADDR_LINE2 || '47000 Duisburg',
  email:   process.env.BRAND_EMAIL || 'info@kickstart-academy.de',
  iban:    process.env.BRAND_IBAN || 'DE00 0000 0000 0000 00',
  bic:     process.env.BRAND_BIC  || 'GENODEF1XXX',
  taxId:   process.env.BRAND_TAXID|| 'DE000000000',

  logoPath: process.env.BRAND_LOGO_PATH
    ? path.resolve(process.cwd(), process.env.BRAND_LOGO_PATH)
    : path.resolve(__dirname, '../assets/img/mfsLogo.png'),

  // Optional: volle A4-Hintergrundgrafik (macht 1:1 Look)
  bgPath: process.env.PDF_BG_PATH
    ? path.resolve(process.cwd(), process.env.PDF_BG_PATH)
    : null,

  // Farben (neutral + Akzent)
  color: '#111827', // Text
  grey:  '#6B7280', // Labels
  line:  '#E5E7EB', // feine Linien
  accent:'#1F2937', // Titel/Section

  // Layout
  margin: mm(20),        // ~20mm rundum
  gridGap: mm(6),        // Abstand zwischen Label/Value
  rowGap:  mm(3),        // vertikaler Abstand zwischen Rows
  h1: 18, h2: 12, p: 10, pBig: 11,
};

/* ===================== Helpers ===================== */
function safeExists(p) {
  try { return p && fs.existsSync(p); } catch { return false; }
}
function fmtDate(d) {
  if (!d) return '-';
  const t = new Date(d);
  return isNaN(t.getTime()) ? String(d) : t.toLocaleDateString('de-DE');
}
function fmtMoney(amount = 0, currency = 'EUR') {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency })
    .format(Number(amount) || 0);
}
function collectBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function newDoc() {
  return new PDFDocument({
    size: 'A4',
    margin: BRAND.margin,
    autoFirstPage: true,
    bufferPages: true,
  });
}

/* ===================== Background & Header ===================== */
function drawBackground(doc) {
  if (safeExists(BRAND.bgPath)) {
    try {
      const { width, height } = doc.page;
      // volle Seite, randlos
      doc.image(BRAND.bgPath, 0, 0, { width, height });
    } catch (e) {
      console.warn('[pdf] background failed:', e.message);
    }
  }
}

function drawBrandHeader(doc, title) {
  const { width, margins, height } = doc.page;
  const xL = margins.left;
  const xR = width - margins.right;
  const topY = margins.top;

  // BG zuerst
  drawBackground(doc);

  // Logo links
  if (safeExists(BRAND.logoPath)) {
    try { doc.image(BRAND.logoPath, xL, topY, { width: mm(28) }); } catch {}
  }

  // Absender rechts
  doc.font('Helvetica').fillColor(BRAND.grey).fontSize(BRAND.p);
  const rightBlock = [BRAND.company, BRAND.addr1, BRAND.addr2, BRAND.email].join('\n');
  doc.text(rightBlock, xR - mm(60), topY, { width: mm(60), align: 'right' });

  // Linie
  const barY = topY + mm(20);
  doc.moveTo(xL, barY).lineTo(xR, barY).lineWidth(0.5).strokeColor(BRAND.line).stroke();

  // Titel
  doc.fillColor(BRAND.accent).font('Helvetica-Bold').fontSize(BRAND.h1)
     .text(title, xL, barY + mm(5));

  // dünne Linie unter Titel
  const afterTitleY = doc.y + mm(2);
  doc.moveTo(xL, afterTitleY).lineTo(xR, afterTitleY).lineWidth(0.5).strokeColor(BRAND.line).stroke();

  doc.moveDown(0.5);
}

/* ===================== Section & Rows ===================== */
function sectionTitle(doc, label) {
  const { width, margins } = doc.page;
  doc.moveDown(0.8)
     .font('Helvetica-Bold').fontSize(BRAND.h2)
     .fillColor(BRAND.accent)
     .text(label);

  const y = doc.y + mm(1.5);
  doc.moveTo(margins.left, y).lineTo(width - margins.right, y)
     .lineWidth(0.5).strokeColor(BRAND.line).stroke();
  doc.moveDown(0.4);
}

/** zweispaltige "Form Rows" (Label links, Value rechts), mehrere Zeilen */
function formRows(doc, pairs, opts = {}) {
  const { width, margins } = doc.page;
  const xL = margins.left;
  const xR = width - margins.right;

  const labelW = opts.labelW || mm(38);
  const gap    = BRAND.gridGap;
  const valW   = xR - (xL + labelW + gap);

  pairs.forEach(({ label, value }, idx) => {
    // Label
    doc.font('Helvetica').fillColor(BRAND.grey).fontSize(BRAND.p)
       .text(String(label ?? '') + ':', xL, doc.y + mm(1), { width: labelW });

    // Value
    doc.font('Helvetica').fillColor(BRAND.color).fontSize(BRAND.pBig)
       .text(String(value ?? '-'), xL + labelW + gap, doc.y - mm(1), { width: valW });

    // Linie unter Row
    const y = doc.y + mm(2);
    doc.moveTo(xL, y).lineTo(xR, y).lineWidth(0.5).strokeColor(BRAND.line).stroke();

    // vertikaler Abstand
    doc.moveDown(BRAND.rowGap / 10);
  });
}

/* ===================== Meta Grid (2 cols) ===================== */
function metaGrid(doc, leftPairs, rightPairs) {
  const { width, margins } = doc.page;
  const xL = margins.left;
  const colW = (width - margins.left - margins.right - mm(6)) / 2;

  const startY = doc.y + mm(2);

  // left column
  doc.save();
  doc.text('', xL, startY);
  formRows(doc, leftPairs, { labelW: mm(36) });
  const leftEndY = doc.y;
  doc.restore();

  // right column
  doc.save();
  doc.text('', xL + colW + mm(6), startY);
  formRows(doc, rightPairs, { labelW: mm(36) });
  const rightEndY = doc.y;
  doc.restore();

  doc.y = Math.max(leftEndY, rightEndY);
}

/* ===================== Simple Table (for Storno) ===================== */
function drawTable(doc, { headers, rows, widths }) {
  const { width, margins, height } = doc.page;
  const xL = margins.left;
  const xR = width - margins.right;

  const colX = [];
  let cursorX = xL;
  (widths || [mm(100), mm(20), mm(30), mm(30)]).forEach(w => {
    colX.push(cursorX);
    cursorX += w;
  });
  const rowHeight = mm(8);

  // Header
  doc.font('Helvetica-Bold').fontSize(BRAND.p).fillColor(BRAND.accent);
  headers.forEach((h, i) => {
    doc.text(h, colX[i], doc.y + mm(1), { width: (widths[i] || mm(30)) });
  });
  const hy = doc.y + mm(3.5);
  doc.moveTo(xL, hy).lineTo(xR, hy).lineWidth(0.6).strokeColor(BRAND.line).stroke();

  // Rows
  doc.font('Helvetica').fillColor(BRAND.color);
  rows.forEach((r, idx) => {
    // page-break check
    if (doc.y + rowHeight > height - margins.bottom - mm(20)) {
      doc.addPage();
      drawBrandHeader(doc, 'Storno-Rechnung');
      sectionTitle(doc, 'Positionen');
      // redraw header
      doc.font('Helvetica-Bold').fontSize(BRAND.p).fillColor(BRAND.accent);
      headers.forEach((h, i) => {
        doc.text(h, colX[i], doc.y + mm(1), { width: (widths[i] || mm(30)) });
      });
      const hy2 = doc.y + mm(3.5);
      doc.moveTo(xL, hy2).lineTo(xR, hy2).lineWidth(0.6).strokeColor(BRAND.line).stroke();
      doc.font('Helvetica').fillColor(BRAND.color);
    }

    // cells
    r.forEach((cell, i) => {
      const opt = { width: (widths[i] || mm(30)) };
      doc.text(String(cell ?? ''), colX[i], doc.y + mm(1), opt);
    });

    const ry = doc.y + mm(3.5);
    doc.moveTo(xL, ry).lineTo(xR, ry).lineWidth(0.4).strokeColor(BRAND.line).stroke();
  });
}

/* ===================== Footer ===================== */
function drawFooter(doc) {
  const { width, height, margins } = doc.page;
  const xL = margins.left;
  const xR = width - margins.right;
  const y  = height - margins.bottom - mm(18);

  doc.moveTo(xL, y).lineTo(xR, y).lineWidth(0.5).strokeColor(BRAND.line).stroke();

  doc.font('Helvetica').fillColor(BRAND.grey).fontSize(9);
  const lines = [
    `${BRAND.company} • ${BRAND.addr2} • ${BRAND.email}`,
    `IBAN: ${BRAND.iban} • BIC: ${BRAND.bic}`,
    `Steuer-ID: ${BRAND.taxId}`,
  ];
  doc.text(lines.join('\n'), xL, y + mm(2));
}

/* ===================== Builders ===================== */
async function buildParticipationPdf({ customer, booking }) {
  const doc = newDoc();
  const buf = collectBuffer(doc);

  drawBrandHeader(doc, 'Teilnahmebestätigung');

  sectionTitle(doc, 'Kunde');
  formRows(doc, [
    { label: 'Kundennummer', value: customer?.userId ?? '-' },
    { label: 'Erziehungsberechtigte/r', value: [customer?.parent?.salutation, customer?.parent?.firstName, customer?.parent?.lastName].filter(Boolean).join(' ') || '-' },
    { label: 'E-Mail', value: customer?.parent?.email || '-' },
    { label: 'Teilnehmer (Kind)', value: [customer?.child?.firstName, customer?.child?.lastName].filter(Boolean).join(' ') || '-' },
  ]);

  sectionTitle(doc, 'Buchung');
  formRows(doc, [
    { label: 'Angebot', value: booking?.offerTitle || booking?.offerType || '-' },
    { label: 'Startdatum', value: fmtDate(booking?.date) },
    { label: 'Status', value: (booking?.status === 'cancelled' ? 'Cancelled' : (booking?.status || 'Active')) },
  ]);

  drawFooter(doc);
  doc.end();
  return buf;
}

async function buildCancellationPdf({ customer, booking, date, reason }) {
  const doc = newDoc();
  const buf = collectBuffer(doc);

  drawBrandHeader(doc, 'Kündigungsbestätigung');

  sectionTitle(doc, 'Kunde');
  formRows(doc, [
    { label: 'Kundennummer', value: customer?.userId ?? '-' },
    { label: 'Erziehungsberechtigte/r', value: [customer?.parent?.salutation, customer?.parent?.firstName, customer?.parent?.lastName].filter(Boolean).join(' ') || '-' },
    { label: 'E-Mail', value: customer?.parent?.email || '-' },
    { label: 'Teilnehmer (Kind)', value: [customer?.child?.firstName, customer?.child?.lastName].filter(Boolean).join(' ') || '-' },
  ]);

  sectionTitle(doc, 'Buchung');
  formRows(doc, [
    { label: 'Angebot', value: booking?.offerTitle || booking?.offerType || '-' },
  ]);

  sectionTitle(doc, 'Details');
  formRows(doc, [
    { label: 'Kündigungsdatum', value: fmtDate(date || booking?.cancelDate) },
    ...(reason ? [{ label: 'Grund', value: reason }] : []),
  ]);

  drawFooter(doc);
  doc.end();
  return buf;
}

async function buildStornoPdf({ customer, booking, amount = 0, currency = 'EUR' }) {
  const doc = newDoc();
  const buf = collectBuffer(doc);

  drawBrandHeader(doc, 'Storno-Rechnung');

  // Meta in 2 Spalten (Rechnungsstil)
  metaGrid(doc,
    [
      { label: 'Kundennummer', value: customer?.userId ?? '-' },
      { label: 'Erziehungsberechtigte/r', value: [customer?.parent?.salutation, customer?.parent?.firstName, customer?.parent?.lastName].filter(Boolean).join(' ') || '-' },
      { label: 'E-Mail', value: customer?.parent?.email || '-' },
    ],
    [
      { label: 'Rechnungsdatum', value: fmtDate(booking?.cancelDate || new Date()) },
      { label: 'Vorgang', value: 'Storno' },
      { label: 'Angebot', value: booking?.offerTitle || booking?.offerType || '-' },
    ],
  );

  // Positionen
  sectionTitle(doc, 'Positionen');
  const qty = 1;
  const unit = fmtMoney(amount, currency);
  const total = fmtMoney(amount * qty, currency);

  drawTable(doc, {
    headers: ['Beschreibung', 'Menge', 'Einzelpreis', 'Gesamt'],
    widths:  [mm(90), mm(20), mm(35), mm(35)],
    rows: [
      [
        `Storno – ${booking?.offerTitle || booking?.offerType || 'Angebot'}`,
        String(qty),
        unit,
        total,
      ],
    ],
  });

  // Summe
  doc.moveDown(1);
  const { width, margins } = doc.page;
  const sumX = width - margins.right - mm(35);
  doc.font('Helvetica-Bold').fontSize(BRAND.pBig).fillColor(BRAND.accent)
     .text('Gesamt', sumX - mm(35), doc.y, { width: mm(35), align: 'right' });
  doc.font('Helvetica-Bold').fontSize(BRAND.pBig).fillColor(BRAND.color)
     .text(total, sumX, doc.y, { width: mm(35), align: 'right' });

  drawFooter(doc);
  doc.end();
  return buf;
}

/* ===== Legacy simple booking PDF (falls noch benötigt) ===== */
async function bookingPdfBuffer(booking) {
  const doc = newDoc();
  const buf = collectBuffer(doc);

  drawBrandHeader(doc, 'Buchungsbestätigung');

  sectionTitle(doc, 'Buchung');
  formRows(doc, [
    { label: 'Bestätigungsnummer', value: booking?.confirmationCode || '-' },
    { label: 'Name', value: booking?.fullName || [booking?.firstName, booking?.lastName].filter(Boolean).join(' ') || '-' },
    { label: 'E-Mail', value: booking?.email || '-' },
    { label: 'Programm', value: booking?.program || booking?.level || '-' },
    { label: 'Datum', value: fmtDate(booking?.date) },
    ...(booking?.message ? [{ label: 'Nachricht', value: booking.message }] : []),
  ]);

  drawFooter(doc);
  doc.end();
  return buf;
}

/* ===================== Exports ===================== */
module.exports = {
  bookingPdfBuffer,
  buildParticipationPdf,
  buildCancellationPdf,
  buildStornoPdf,
};

















