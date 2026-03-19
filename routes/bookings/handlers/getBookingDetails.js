"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");
const Customer = require("../../../models/Customer");
const { resolveOwner } = require("../helpers/owner");

function safeText(v) {
  return String(v ?? "").trim();
}

function findChild(customer, childUid, booking) {
  const cu = safeText(childUid || booking?.childUid);
  const children = Array.isArray(customer?.children) ? customer.children : [];
  const legacy = customer?.child || null;

  if (cu) {
    const hit =
      children.find((ch) => safeText(ch?.uid) === cu) ||
      (safeText(legacy?.uid) === cu ? legacy : null);
    if (hit) return hit;
  }

  const byName = children.find((ch) => {
    return (
      safeText(ch?.firstName).toLowerCase() ===
        safeText(booking?.firstName).toLowerCase() &&
      safeText(ch?.lastName).toLowerCase() ===
        safeText(booking?.lastName).toLowerCase()
    );
  });
  if (byName) return byName;

  return legacy || null;
}

function buildAddress(address) {
  const street = safeText(address?.street);
  const houseNo = safeText(address?.houseNo);
  const zip = safeText(address?.zip);
  const city = safeText(address?.city);

  const streetLine = [street, houseNo].filter(Boolean).join(" ").trim();
  const cityLine = [zip, city].filter(Boolean).join(" ").trim();
  return [streetLine, cityLine].filter(Boolean).join(", ").trim();
}

function buildContact(parent) {
  return [
    safeText(parent?.salutation),
    safeText(parent?.firstName),
    safeText(parent?.lastName),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

async function getBookingDetails(req, res) {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res
        .status(500)
        .json({ ok: false, error: "DEFAULT_OWNER_ID missing/invalid" });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid booking id" });
    }

    const booking = await Booking.findOne({ _id: id, owner: ownerId }).lean();
    if (!booking) {
      return res.status(404).json({ ok: false, error: "Booking not found" });
    }

    let detail = null;

    if (booking.source === "admin_booking" && booking.customerId) {
      const customer = await Customer.findOne({
        _id: booking.customerId,
        owner: ownerId,
      }).lean();

      if (customer) {
        const child = findChild(customer, booking.childUid, booking);
        detail = {
          child: child
            ? {
                firstName: safeText(child.firstName),
                lastName: safeText(child.lastName),
                gender: safeText(child.gender),
                birthDate: child.birthDate || null,
              }
            : null,
          parent: {
            salutation: safeText(customer.parent?.salutation),
            firstName: safeText(customer.parent?.firstName),
            lastName: safeText(customer.parent?.lastName),
            phone: safeText(customer.parent?.phone || customer.parent?.phone2),
          },
          contact: buildContact(customer.parent),
          address: buildAddress(customer.address),
        };
      }
    }

    return res.json({
      ok: true,
      booking,
      detail,
    });
  } catch (err) {
    console.error("[admin/bookings/:id] details failed:", err);
    return res.status(500).json({ ok: false, error: "Details failed" });
  }
}

module.exports = { getBookingDetails };
