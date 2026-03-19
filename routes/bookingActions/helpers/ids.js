const mongoose = require("mongoose");

function requireIds(req, res) {
  const cid = String(req.params.cid || "").trim();
  const bid = String(req.params.bid || "").trim();
  if (!mongoose.isValidObjectId(cid)) {
    res.status(400).json({ error: "Invalid customer id" });
    return null;
  }
  if (!mongoose.isValidObjectId(bid)) {
    res.status(400).json({ error: "Invalid booking id" });
    return null;
  }
  return { cid, bid };
}

module.exports = { requireIds };
