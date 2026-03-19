// routes/bookingActions/handlers/listInvoicesAction.js
const mongoose = require("mongoose");

const Customer = require("../../../models/Customer");

const { prorateForStart, nextPeriodStart } = require("../../../utils/billing");

const { requireOwner } = require("../helpers/provider");
const { resolveAmountsFromBookingRef } = require("../helpers/amounts");
const { isoLocal } = require("../helpers/date");

function norm(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function matchesQuery(q, row, customer) {
  const qq = norm(q);
  if (!qq) return true;

  const customerNo = norm(customer?.userId);
  const invoiceNo = norm(row?.invoiceNo);

  if (customerNo && customerNo.includes(qq)) return true;
  if (invoiceNo && invoiceNo.includes(qq)) return true;

  const hay = norm(`${row?.title || ""} ${row?.type || ""}`);
  return hay.includes(qq);
}

async function listInvoicesAction(req, res) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const cid = String(req.params.cid || "").trim();
    if (!mongoose.isValidObjectId(cid)) {
      return res.status(400).json({ error: "Invalid customer id" });
    }

    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 5)));
    const skip = Math.max(0, Number(req.query.skip || 0));
    const q = String(req.query.q || "").trim();

    const customer = await Customer.findOne({ _id: cid, owner }).lean();
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const out = [];

    for (const b of customer.bookings || []) {
      if (!b || !b.offerId) continue;

      const resolved = await resolveAmountsFromBookingRef(b);
      const priceMonthly = resolved.priceMonthly;
      const priceFirstMonth = resolved.priceFirstMonth;
      const currency = resolved.currency;

      const startISO = b.date ? isoLocal(b.date) : null;

      const hasInvoiceRefs =
        Array.isArray(b.invoiceRefs) && b.invoiceRefs.length > 0;
      if (hasInvoiceRefs) {
        for (const r of b.invoiceRefs) {
          if (!r?.number) continue;
          out.push({
            bookingId: String(b._id),
            type: "invoice",
            title:
              (b.offerTitle || b.offerType || "Rechnung") + ` (${r.number})`,
            date: r.date
              ? new Date(r.date).toISOString().slice(0, 10)
              : startISO || "",
            amount:
              typeof r.amount === "number"
                ? Number(r.amount)
                : priceMonthly != null
                  ? Number(priceMonthly)
                  : 0,
            currency,
            invoiceNo: r.number,
            customerNumber: customer.userId,
          });
        }
        continue;
      }

      const isWeekly = startISO && priceMonthly != null;

      if (isWeekly) {
        const pm = Number(priceMonthly);
        const startDay = Number(String(startISO).slice(8, 10));

        let firstAmount = null;

        if (startDay !== 1) {
          firstAmount = prorateForStart(startISO, pm).firstMonthPrice;
        } else {
          firstAmount = priceFirstMonth != null ? Number(priceFirstMonth) : pm;
        }

        out.push({
          bookingId: String(b._id),
          type: "first-month",
          title: b.offerTitle || b.offerType || "Abo (1. Monat)",
          date: startISO,
          amount: Number(firstAmount),
          currency,
          invoiceNo: b.invoiceNumber || b.invoiceNo || "",
          customerNumber: customer.userId,
        });

        const recurISO = nextPeriodStart(startISO);
        if (recurISO) {
          out.push({
            bookingId: String(b._id),
            type: "recurring",
            title: (b.offerTitle || b.offerType || "Abo") + " (monatlich)",
            date: recurISO,
            amount: pm,
            currency,
            invoiceNo: b.invoiceNumber || b.invoiceNo || "",
            customerNumber: customer.userId,
          });
        }

        continue;
      }

      const oneOffAmount =
        typeof b.priceAtBooking === "number" ? Number(b.priceAtBooking) : null;

      const issueDate =
        startISO ||
        (b.createdAt ? new Date(b.createdAt).toISOString().slice(0, 10) : null);

      if (oneOffAmount == null || !issueDate) continue;

      out.push({
        bookingId: String(b._id),
        type: "one-off",
        title: b.offerTitle || b.offerType || "Rechnung",
        date: issueDate,
        amount: oneOffAmount,
        currency,
        invoiceNo: b.invoiceNumber || b.invoiceNo || "",
        customerNumber: customer.userId,
      });
    }

    const filtered = out.filter((row) => matchesQuery(q, row, customer));
    filtered.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const items = filtered.slice(skip, skip + limit);
    return res.json({ ok: true, total: filtered.length, items });
  } catch (err) {
    console.error("[invoices] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { listInvoicesAction };

// //routes\bookingActions\handlers\listInvoicesAction.js
// const mongoose = require("mongoose");

// const Customer = require("../../../models/Customer");

// const { prorateForStart, nextPeriodStart } = require("../../../utils/billing");

// const { requireOwner } = require("../helpers/provider");
// const { resolveAmountsFromBookingRef } = require("../helpers/amounts");
// const { isoLocal } = require("../helpers/date");

// async function listInvoicesAction(req, res) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const cid = String(req.params.cid || "").trim();
//     if (!mongoose.isValidObjectId(cid)) {
//       return res.status(400).json({ error: "Invalid customer id" });
//     }

//     const limit = Math.max(1, Math.min(50, Number(req.query.limit || 5)));
//     const skip = Math.max(0, Number(req.query.skip || 0));

//     const customer = await Customer.findOne({ _id: cid, owner }).lean();
//     if (!customer) return res.status(404).json({ error: "Customer not found" });

//     const out = [];

//     for (const b of customer.bookings || []) {
//       if (!b || !b.offerId) continue;

//       const resolved = await resolveAmountsFromBookingRef(b);
//       const priceMonthly = resolved.priceMonthly;
//       const priceFirstMonth = resolved.priceFirstMonth;
//       const currency = resolved.currency;

//       const startISO = b.date ? isoLocal(b.date) : null;

//       const hasInvoiceRefs =
//         Array.isArray(b.invoiceRefs) && b.invoiceRefs.length > 0;
//       if (hasInvoiceRefs) {
//         for (const r of b.invoiceRefs) {
//           if (!r?.number) continue;
//           out.push({
//             bookingId: String(b._id),
//             type: "invoice",
//             title:
//               (b.offerTitle || b.offerType || "Rechnung") + ` (${r.number})`,
//             date: r.date
//               ? new Date(r.date).toISOString().slice(0, 10)
//               : startISO || "",
//             amount:
//               typeof r.amount === "number"
//                 ? Number(r.amount)
//                 : priceMonthly != null
//                   ? Number(priceMonthly)
//                   : 0,
//             currency,
//             invoiceNo: r.number,
//           });
//         }
//         continue;
//       }

//       const isWeekly = startISO && priceMonthly != null;

//       if (isWeekly) {
//         const pm = Number(priceMonthly);
//         const startDay = Number(String(startISO).slice(8, 10));

//         let firstAmount = null;

//         if (startDay !== 1) {
//           firstAmount = prorateForStart(startISO, pm).firstMonthPrice;
//         } else {
//           firstAmount = priceFirstMonth != null ? Number(priceFirstMonth) : pm;
//         }

//         out.push({
//           bookingId: String(b._id),
//           type: "first-month",
//           title: b.offerTitle || b.offerType || "Abo (1. Monat)",
//           date: startISO,
//           amount: Number(firstAmount),
//           currency,
//         });

//         const recurISO = nextPeriodStart(startISO);
//         if (recurISO) {
//           out.push({
//             bookingId: String(b._id),
//             type: "recurring",
//             title: (b.offerTitle || b.offerType || "Abo") + " (monatlich)",
//             date: recurISO,
//             amount: pm,
//             currency,
//           });
//         }

//         continue;
//       }

//       const oneOffAmount =
//         typeof b.priceAtBooking === "number" ? Number(b.priceAtBooking) : null;

//       const issueDate =
//         startISO ||
//         (b.createdAt ? new Date(b.createdAt).toISOString().slice(0, 10) : null);

//       if (oneOffAmount == null || !issueDate) continue;

//       out.push({
//         bookingId: String(b._id),
//         type: "one-off",
//         title: b.offerTitle || b.offerType || "Rechnung",
//         date: issueDate,
//         amount: oneOffAmount,
//         currency,
//       });
//     }

//     out.sort((a, b) => String(a.date).localeCompare(String(b.date)));

//     const items = out.slice(skip, skip + limit);
//     return res.json({ ok: true, total: out.length, items });
//   } catch (err) {
//     console.error("[invoices] error:", err);
//     return res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { listInvoicesAction };
