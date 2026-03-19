"use strict";

const Customer = require("../../../models/Customer");

async function cancelCustomerAll(
  req,
  res,
  requireOwner,
  requireId,
  formatCancellationNo,
  buildCancellationPdf,
  sendCancellationEmail,
) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const { date, reason } = req.body || {};
    const cancelAt = date ? new Date(date) : new Date();

    const customer = await Customer.findOneAndUpdate(
      { _id: id, owner },
      {
        $set: {
          canceledAt: new Date(),
          cancellationDate: cancelAt,
          cancellationReason: String(reason || ""),
          cancellationNo: formatCancellationNo(),
        },
      },
      { new: true },
    ).lean();

    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const pdf = await buildCancellationPdf({
      customer,
      booking: {},
      offer: null,
      date: cancelAt,
      reason,
      cancellationNo: customer.cancellationNo,
    });

    await sendCancellationEmail({
      to: customer.parent.email,
      customer,
      booking: {},
      offer: null,
      date: cancelAt,
      reason,
      pdfBuffer: pdf,
    });

    res.json({ ok: true, customer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
}

module.exports = { cancelCustomerAll };
