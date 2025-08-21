// utils/pdf.js
const PDFDocument = require('pdfkit');

function bookingPdfBuffer(booking) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', ch => chunks.push(ch));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(20).text('Buchungsbestätigung', { align: 'right' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#666')
      .text('KickStart Academy', { align: 'right' })
      .text('Duisburg, NRW', { align: 'right' })
      .text('info@kickstart-academy.de', { align: 'right' })
      .fillColor('#000');

    doc.moveDown();
    doc.fontSize(14).text(`Bestätigungsnummer: ${booking.confirmationCode || '-'}`);
    doc.moveDown(0.5);

    // Kundendaten
    doc.fontSize(12).text('Kundendaten', { underline: true });
    doc.moveDown(0.3);
    doc.text(`Name: ${booking.fullName}`);
    doc.text(`E-Mail: ${booking.email}`);
    doc.text(`Programm: ${booking.program}`);
    doc.text(`Datum: ${booking.date}`);
    doc.text(`Alter: ${booking.age}`);
    if (booking.message) doc.text(`Nachricht: ${booking.message}`);

    doc.moveDown();
    doc.text(`Status: ${booking.status}`);
    if (booking.confirmedAt) {
      doc.text(`Bestätigt am: ${new Date(booking.confirmedAt).toLocaleString('de-DE')}`);
    }

    doc.moveDown(2);
    doc.fontSize(10).fillColor('#666')
      .text('Dies ist eine automatisch erzeugte Bestätigung. Bei Fragen kontaktieren Sie uns bitte.', { align: 'left' });

    doc.end();
  });
}

module.exports = { bookingPdfBuffer };
