"use strict";

const Customer = require("../../../models/Customer");

async function deleteCustomer(req, res, requireOwner, requireId) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const d = await Customer.deleteOne({ _id: id, owner });
    if (!d.deletedCount)
      return res.status(404).json({ error: "Customer not found" });

    res.json({ ok: true, id });
  } catch {
    res.status(400).json({ error: "Invalid customer id" });
  }
}

module.exports = { deleteCustomer };
