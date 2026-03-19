"use strict";

const crypto = require("crypto");

function safeText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

function createRevocationTokenPair() {
  const rawToken = crypto.randomBytes(24).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, tokenHash };
}

function websiteBaseUrl() {
  return (
    safeText(process.env.PUBLIC_BASE_URL) ||
    safeText(process.env.BRAND_WEBSITE_URL) ||
    "http://localhost:3000"
  );
}

async function ensureRevocationLink(booking) {
  const { rawToken, tokenHash } = createRevocationTokenPair();

  booking.revocationTokenHash = tokenHash;
  booking.revocationTokenExpires = new Date(
    Date.now() + 1000 * 60 * 60 * 24 * 30,
  );

  await booking.save();

  const base = websiteBaseUrl();
  const revocationUrl = `${String(base).replace(/\/+$/, "")}/weekly/revoke?token=${encodeURIComponent(rawToken)}`;

  return {
    created: true,
    revocationUrl,
  };
}

module.exports = {
  createRevocationTokenPair,
  websiteBaseUrl,
  ensureRevocationLink,
};
// "use strict";

// const crypto = require("crypto");

// function safeText(v) {
//   if (v === null || v === undefined) return "";
//   if (typeof v === "string") return v.trim();
//   if (typeof v === "number") return String(v);
//   return "";
// }

// function createRevocationTokenPair() {
//   const rawToken = crypto.randomBytes(24).toString("hex");
//   const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

//   return { rawToken, tokenHash };
// }

// function websiteBaseUrl() {
//   return (
//     safeText(process.env.PUBLIC_BASE_URL) ||
//     safeText(process.env.BRAND_WEBSITE_URL) ||
//     "http://localhost:3000"
//     //"https://dortmunder-fussballschule.de"
//   );
// }

// async function ensureRevocationLink(booking) {
//   const hasHash = safeText(booking?.revocationTokenHash);
//   const hasExp = booking?.revocationTokenExpires;

//   if (hasHash && hasExp) {
//     return { created: false, revocationUrl: "" };
//   }

//   const { rawToken, tokenHash } = createRevocationTokenPair();

//   booking.revocationTokenHash = tokenHash;
//   booking.revocationTokenExpires = new Date(
//     Date.now() + 1000 * 60 * 60 * 24 * 30,
//   );

//   await booking.save();

//   const base = websiteBaseUrl();
//   const revocationUrl = `${String(base).replace(/\/+$/, "")}/weekly/revoke?token=${encodeURIComponent(rawToken)}`;

//   return {
//     created: true,
//     revocationUrl,
//   };
// }

// module.exports = {
//   createRevocationTokenPair,
//   websiteBaseUrl,
//   ensureRevocationLink,
// };
