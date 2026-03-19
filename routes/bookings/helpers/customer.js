//routes\bookings\helpers\customer.js
"use strict";

/* ---------- Customer-Helper ---------- */

function normalizeEmail(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

// Kind aus Payload extrahieren
function extractChildFromPayload(payload) {
  const firstName = String(payload.firstName || "").trim();
  const lastName = String(payload.lastName || "").trim();

  const birthRaw =
    payload.birthDate ||
    payload.birthdate ||
    payload.childBirthDate ||
    payload.childBirthdate ||
    null;

  const birthDate = birthRaw ? new Date(birthRaw) : null;

  return {
    firstName,
    lastName,
    birthDate: isNaN(birthDate?.getTime?.()) ? null : birthDate,
    club: String(payload.club || ""),
  };
}

// prüft, ob ein Child (Name + optional GebDatum) schon im Customer existiert
function hasSameChild(child, target) {
  if (!child || !target) return false;

  const sameName =
    String(child.firstName || "")
      .trim()
      .toLowerCase() ===
      String(target.firstName || "")
        .trim()
        .toLowerCase() &&
    String(child.lastName || "")
      .trim()
      .toLowerCase() ===
      String(target.lastName || "")
        .trim()
        .toLowerCase();

  if (!sameName) return false;

  if (!child.birthDate || !target.birthDate) {
    // kein Geburtsdatum → wir matchen nur auf Namen
    return sameName;
  }

  const a = new Date(child.birthDate);
  const b = new Date(target.birthDate);
  return (
    !isNaN(a.getTime()) &&
    !isNaN(b.getTime()) &&
    a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)
  );
}

module.exports = {
  normalizeEmail,
  extractChildFromPayload,
  hasSameChild,
};
