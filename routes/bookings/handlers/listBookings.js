//routes\bookings\handlers\listBookings.js
"use strict";

const Booking = require("../../../models/Booking");
const Offer = require("../../../models/Offer");

const { resolveOwner } = require("../helpers/owner");
const { buildFilter } = require("../helpers/buildFilter");
const { buildOfferFilterForProgram } = require("../helpers/programFilters");

async function listBookings(req, res) {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res
        .status(500)
        .json({ ok: false, error: "DEFAULT_OWNER_ID missing/invalid" });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 10),
    );
    const skip = (page - 1) * limit;

    // Program-Filter aus Query
    const programKey = String(req.query.program || "all");

    // Basis-Filter (Status, Suche, includeHoliday-Logik, usw.)
    const filter = buildFilter(req.query, ownerId);

    // ==== Program-Filter über Offer -> offerId ====
    if (programKey && programKey !== "all") {
      const offerFilter = buildOfferFilterForProgram(programKey);

      if (offerFilter) {
        // passende Offers für diesen Kurs finden (nur für diesen Owner)
        const offerIds = await Offer.find({
          owner: ownerId,
          ...offerFilter,
        })
          .distinct("_id")
          .exec();

        if (!offerIds.length) {
          // keine passenden Offers -> keine Bookings
          const emptyCounts = {
            pending: 0,
            processing: 0,
            confirmed: 0,
            cancelled: 0,
            deleted: 0,
          };
          return res.json({
            ok: true,
            items: [],
            bookings: [],
            total: 0,
            page,
            limit,
            pages: 1,
            counts: emptyCounts,
          });
        }

        // Filter um offerId-Einschränkung erweitern
        filter.offerId = { $in: offerIds };
      }
    }

    // gleiche Filter-Teile auch für die Aggregation verwenden,
    // damit Counts und Liste übereinstimmen
    const matchForCounts = { ...filter };

    if (filter.status) matchForCounts.status = filter.status;
    if (filter.date) matchForCounts.date = filter.date;
    if (filter.$and) matchForCounts.$and = filter.$and;
    if (filter.$or) matchForCounts.$or = filter.$or;
    if (filter.offerId) matchForCounts.offerId = filter.offerId;

    const [items, total, grouped] = await Promise.all([
      Booking.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Booking.countDocuments(filter),
      Booking.aggregate([
        { $match: matchForCounts },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
    ]);

    const counts = {
      pending: 0,
      processing: 0,
      confirmed: 0,
      cancelled: 0,
      deleted: 0,
    };
    for (const g of grouped) {
      const key = g._id || "pending";
      if (counts[key] !== undefined) counts[key] = g.n;
    }

    return res.json({
      ok: true,
      items,
      bookings: items,
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      counts,
    });
  } catch (err) {
    console.error("[admin/bookings] list failed:", err);
    return res.status(500).json({ ok: false, error: "List failed" });
  }
}

module.exports = { listBookings };
