




















'use strict';

/**
 * EXAKTES Mapping gemäß deiner DB:
 *
 * Customer:
 *   _id, userId
 *   parent: { salutation, firstName, lastName, email? }
 *   child:  { firstName, lastName }
 *   address:{ street, houseNo, zip, city }
 *
 * Booking (separate Collection ODER embedded):
 *   _id, firstName, lastName, email, age, date (yyyy-mm-dd), level, message,
 *   confirmationCode, confirmedAt, status,
 *   (embedded BookingRef:) cancelDate, cancelReason, offerTitle?, offerType?, venue?
 *
 * Offer:
 *   _id, type, location, title, price
 */

function toISODate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}

/** Customer → Template-Shape (mit Fallbacks aus Booking) */
function shapeCustomer(customer = {}, booking = {}) {
  const parent = customer.parent || {};
  const child  = customer.child  || {};
  const addr   = customer.address|| {};

  return {
    userId : String(customer.userId ?? customer._id ?? ''),
    parent : {
      salutation: parent.salutation || '',
      firstName : parent.firstName  || booking.firstName || '',
      lastName  : parent.lastName   || booking.lastName  || '',
      email     : parent.email      || booking.email     || '',
    },
    child  : {
      firstName: child.firstName || booking.firstName || '',
      lastName : child.lastName  || booking.lastName  || '',
    },
    address: {
      street : addr.street  || '',
      houseNo: addr.houseNo || '',
      zip    : addr.zip     || '',
      city   : addr.city    || '',
    },
  };
}

/** Booking → Template-Shape (Offer-Felder + Cancel-Felder robust) */
function shapeBooking(booking = {}, offer = {}) {
  return {
    _id       : booking._id || '',
    // Angebot: primär Offer, sekundär Snapshot im Booking
    offerTitle: (offer.title    || booking.offerTitle || ''),
    offerType : (offer.type     || booking.offerType  || ''),
    venue     : (offer.location || booking.venue      || booking.offerLocation || ''),
    // DB-Felder
    date      : toISODate(booking.date),
    status    : booking.status || '',
    cancelDate  : toISODate(booking.cancelDate || booking.cancellationDate || booking.canceledAt || ''),
    cancelReason: booking.cancelReason || booking.cancellationReason || '',
    // zusätzlich
    level     : booking.level || '',
    confirmationCode: booking.confirmationCode || '',
  };
}



// utils/pdfData.js
function shapeStornoData({ customer, booking, offer, amount, currency = 'EUR' }) {
  // amount OHNE Default, nur übernehmen wenn wirklich vorhanden
  const amt = (amount !== undefined && amount !== null && String(amount).trim() !== '')
    ? Number(amount)
    : undefined;

  return {
    customer: shapeCustomer(customer, booking),
    booking : shapeBooking(booking, offer),
    amount  : amt,        // kann undefined sein → erlaubt Fallback auf offer.price
    currency,
  };
}


function shapeCancellationData({ customer, booking, offer, date, reason }) {
  const shapedBooking = shapeBooking(booking, offer);
  return {
    customer: shapeCustomer(customer, booking),
    booking : shapedBooking,
    details : {
      cancelDate: toISODate(date) || shapedBooking.cancelDate,
      reason    : (reason || shapedBooking.cancelReason || ''),
    },
  };
}

function shapeParticipationData({ customer, booking, offer }) {
  return {
    customer: shapeCustomer(customer, booking),
    booking : shapeBooking(booking, offer),
  };
}

module.exports = {
  shapeStornoData,
  shapeCancellationData,
  shapeParticipationData,
};
