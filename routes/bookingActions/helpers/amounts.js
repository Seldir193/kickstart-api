const mongoose = require("mongoose");

const Booking = require("../../../models/Booking");

const { prorateForStart, normCurrency } = require("../../../utils/billing");

async function resolveAmountsFromBookingRef(ref) {
  const currency = normCurrency(ref.currency || "EUR");

  const monthlyRaw =
    ref.priceMonthly ?? ref.monthlyAmount ?? ref.priceAtBooking ?? null;

  const firstRaw = ref.priceFirstMonth ?? ref.firstMonthAmount ?? null;

  const startISO = ref.date
    ? new Date(ref.date).toISOString().slice(0, 10)
    : null;
  const startDay = startISO ? Number(String(startISO).slice(8, 10)) : null;

  const monthly = monthlyRaw != null ? Number(monthlyRaw) : null;
  let first = firstRaw != null ? Number(firstRaw) : null;

  if (monthly != null && startISO && startDay && startDay !== 1) {
    const needsProrata =
      first == null || !Number.isFinite(first) || first === monthly;
    if (needsProrata) {
      first = prorateForStart(startISO, monthly).firstMonthPrice;
    }
  }

  if (monthly != null) {
    return {
      currency,
      priceMonthly: monthly,
      priceFirstMonth: first != null && Number.isFinite(first) ? first : null,
    };
  }

  if (ref.bookingId && mongoose.isValidObjectId(String(ref.bookingId))) {
    const b = await Booking.findById(ref.bookingId)
      .select(
        "currency priceMonthly priceFirstMonth priceAtBooking date createdAt",
      )
      .lean();

    if (b) {
      const m = b.priceMonthly ?? b.priceAtBooking ?? null;
      const monthly2 = m != null ? Number(m) : null;

      const iso = b.date
        ? new Date(b.date).toISOString().slice(0, 10)
        : b.createdAt
          ? new Date(b.createdAt).toISOString().slice(0, 10)
          : null;

      let first2 = b.priceFirstMonth != null ? Number(b.priceFirstMonth) : null;
      const day2 = iso ? Number(String(iso).slice(8, 10)) : null;

      if (monthly2 != null && iso && day2 && day2 !== 1) {
        const needsProrata =
          first2 == null || !Number.isFinite(first2) || first2 === monthly2;
        if (needsProrata) {
          first2 = prorateForStart(iso, monthly2).firstMonthPrice;
        }
      }

      return {
        currency: normCurrency(b.currency || currency),
        priceMonthly: monthly2,
        priceFirstMonth:
          first2 != null && Number.isFinite(first2) ? first2 : null,
      };
    }
  }

  return { currency, priceMonthly: null, priceFirstMonth: null };
}

module.exports = { resolveAmountsFromBookingRef };
