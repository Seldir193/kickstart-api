//routes\payments\stripe\lib\strings.js
"use strict";

function safeStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function normEmail(v) {
  const s = safeStr(v).toLowerCase();
  return s && s.includes("@") ? s : "";
}

function safeUrl(v) {
  const s = safeStr(v);
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

module.exports = { safeStr, normEmail, safeUrl };
