"use strict";

function isCancelAllowed(offer) {
  if (!offer) return false;

  if (String(offer.category) === "Weekly") return true;

  const t = String(offer.type || "");
  if (t === "Foerdertraining" || t === "Kindergarten") return true;

  const sub = String(offer.sub_type || "").toLowerCase();
  if (sub === "powertraining") return false;
  if (t === "PersonalTraining") return false;

  return false;
}

module.exports = { isCancelAllowed };
