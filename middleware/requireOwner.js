// middleware/requireOwner.js
"use strict";

module.exports = function requireOwner(req, res, next) {
  if (req.isOwner === true) return next();
  return res.status(403).json({ ok: false, error: "Forbidden" });
};
