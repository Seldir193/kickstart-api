"use strict";

const Customer = require("../../../../models/Customer");
const { stripeClient } = require("./stripeClient");
const { safeStr } = require("./strings");

function stripeEmail(customerDoc, booking) {
  return (
    safeStr(booking?.invoiceTo?.parent?.email) ||
    safeStr(customerDoc?.parent?.email) ||
    safeStr(customerDoc?.email) ||
    safeStr(booking?.email)
  )
    .toLowerCase()
    .trim();
}

function stripeName(customerDoc, booking) {
  const bookingName = `${safeStr(
    booking?.invoiceTo?.parent?.firstName,
  )} ${safeStr(booking?.invoiceTo?.parent?.lastName)}`.trim();

  if (bookingName) return bookingName;

  return `${safeStr(customerDoc?.parent?.firstName)} ${safeStr(
    customerDoc?.parent?.lastName,
  )}`.trim();
}

function stripePhone(customerDoc, booking) {
  return (
    safeStr(booking?.invoiceTo?.parent?.phone) ||
    safeStr(customerDoc?.parent?.phone) ||
    ""
  ).trim();
}

async function updateStripeCustomer(stripeCustomerId, customerDoc, booking) {
  const stripe = stripeClient();
  const email = stripeEmail(customerDoc, booking);
  const name = stripeName(customerDoc, booking);
  const phone = stripePhone(customerDoc, booking);

  await stripe.customers.update(stripeCustomerId, {
    email: email || undefined,
    name: name || undefined,
    phone: phone || undefined,
    metadata: {
      customerId: String(customerDoc._id),
      ownerId: String(customerDoc.owner),
    },
  });

  return stripeCustomerId;
}

async function createStripeCustomer(customerDoc, booking) {
  const stripe = stripeClient();
  const email = stripeEmail(customerDoc, booking);
  const name = stripeName(customerDoc, booking);
  const phone = stripePhone(customerDoc, booking);

  const created = await stripe.customers.create({
    email: email || undefined,
    name: name || undefined,
    phone: phone || undefined,
    metadata: {
      customerId: String(customerDoc._id),
      ownerId: String(customerDoc.owner),
    },
  });

  customerDoc.stripeCustomerId = created.id;
  await customerDoc.save();
  return created.id;
}

function isMissingStripeCustomerError(error) {
  return (
    error?.code === "resource_missing" ||
    safeStr(error?.raw?.code) === "resource_missing" ||
    /No such customer/i.test(safeStr(error?.message))
  );
}

async function recreateStripeCustomer(customerDoc, booking) {
  customerDoc.stripeCustomerId = "";
  await customerDoc.save();
  return createStripeCustomer(customerDoc, booking);
}

async function getOrCreateStripeCustomer(booking) {
  if (!booking?.customerId) return "";

  const customerDoc = await Customer.findById(booking.customerId);
  if (!customerDoc) return "";

  const stripeCustomerId = safeStr(customerDoc.stripeCustomerId);
  if (!stripeCustomerId) {
    return createStripeCustomer(customerDoc, booking);
  }

  try {
    return await updateStripeCustomer(stripeCustomerId, customerDoc, booking);
  } catch (e) {
    if (!isMissingStripeCustomerError(e)) throw e;

    console.warn("[stripeCustomer] stale stripe customer id, recreating", {
      customerId: String(customerDoc._id || ""),
      staleStripeCustomerId: stripeCustomerId,
      message: e?.message || e,
    });

    return recreateStripeCustomer(customerDoc, booking);
  }
}

module.exports = { getOrCreateStripeCustomer };

// //routes\payments\stripe\lib\stripeCustomer.js
// "use strict";

// const Customer = require("../../../../models/Customer");
// const { stripeClient } = require("./stripeClient");
// const { safeStr } = require("./strings");

// function stripeEmail(customerDoc, booking) {
//   return (
//     safeStr(booking?.invoiceTo?.parent?.email) ||
//     safeStr(customerDoc?.parent?.email) ||
//     safeStr(customerDoc?.email) ||
//     safeStr(booking?.email)
//   )
//     .toLowerCase()
//     .trim();
// }

// function stripeName(customerDoc, booking) {
//   const bookingName = `${safeStr(
//     booking?.invoiceTo?.parent?.firstName,
//   )} ${safeStr(booking?.invoiceTo?.parent?.lastName)}`.trim();

//   if (bookingName) return bookingName;

//   return `${safeStr(customerDoc?.parent?.firstName)} ${safeStr(
//     customerDoc?.parent?.lastName,
//   )}`.trim();
// }

// function stripePhone(customerDoc, booking) {
//   return (
//     safeStr(booking?.invoiceTo?.parent?.phone) ||
//     safeStr(customerDoc?.parent?.phone) ||
//     ""
//   ).trim();
// }

// async function updateStripeCustomer(stripeCustomerId, customerDoc, booking) {
//   const stripe = stripeClient();
//   const email = stripeEmail(customerDoc, booking);
//   const name = stripeName(customerDoc, booking);
//   const phone = stripePhone(customerDoc, booking);

//   await stripe.customers.update(stripeCustomerId, {
//     email: email || undefined,
//     name: name || undefined,
//     phone: phone || undefined,
//     metadata: {
//       customerId: String(customerDoc._id),
//       ownerId: String(customerDoc.owner),
//     },
//   });

//   return stripeCustomerId;
// }

// async function createStripeCustomer(customerDoc, booking) {
//   const stripe = stripeClient();
//   const email = stripeEmail(customerDoc, booking);
//   const name = stripeName(customerDoc, booking);
//   const phone = stripePhone(customerDoc, booking);

//   const created = await stripe.customers.create({
//     email: email || undefined,
//     name: name || undefined,
//     phone: phone || undefined,
//     metadata: {
//       customerId: String(customerDoc._id),
//       ownerId: String(customerDoc.owner),
//     },
//   });

//   customerDoc.stripeCustomerId = created.id;
//   await customerDoc.save();
//   return created.id;
// }

// async function getOrCreateStripeCustomer(booking) {
//   if (!booking?.customerId) return "";

//   const customerDoc = await Customer.findById(booking.customerId);
//   if (!customerDoc) return "";

//   const stripeCustomerId = safeStr(customerDoc.stripeCustomerId);
//   if (stripeCustomerId) {
//     return updateStripeCustomer(stripeCustomerId, customerDoc, booking);
//   }

//   return createStripeCustomer(customerDoc, booking);
// }

// module.exports = { getOrCreateStripeCustomer };

// //routes\payments\stripe\lib\stripeCustomer.js
// "use strict";

// const Customer = require("../../../../models/Customer");
// const { stripeClient } = require("./stripeClient");
// const { safeStr } = require("./strings");

// async function getOrCreateStripeCustomer(booking) {
//   if (!booking?.customerId) return "";
//   const customerDoc = await Customer.findById(booking.customerId);
//   if (!customerDoc) return "";
//   if (safeStr(customerDoc.stripeCustomerId))
//     return customerDoc.stripeCustomerId;

//   const stripe = stripeClient();
//   const email =
//     safeStr(customerDoc.parent?.email) ||
//     safeStr(customerDoc.email) ||
//     safeStr(booking.email);

//   const name = `${safeStr(customerDoc.parent?.firstName)} ${safeStr(
//     customerDoc.parent?.lastName,
//   )}`.trim();

//   const created = await stripe.customers.create({
//     email: email ? email.toLowerCase() : undefined,
//     name: name || undefined,
//     metadata: {
//       customerId: String(customerDoc._id),
//       ownerId: String(customerDoc.owner),
//     },
//   });

//   customerDoc.stripeCustomerId = created.id;
//   await customerDoc.save();
//   return created.id;
// }

// module.exports = { getOrCreateStripeCustomer };
