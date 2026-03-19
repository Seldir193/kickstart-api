"use strict";

const crypto = require("crypto");
const Customer = require("../../../models/Customer");

function safeText(v) {
  return String(v ?? "").trim();
}

function safeLower(v) {
  return safeText(v).toLowerCase();
}

function birthKey(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function childKey(c) {
  return `${safeLower(c?.firstName)}::${safeLower(c?.lastName)}::${birthKey(
    c?.birthDate,
  )}`;
}

function newUid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function ensureUid(child) {
  if (!child) return "";
  if (safeText(child.uid)) return safeText(child.uid);
  child.uid = newUid();
  return child.uid;
}

function ensureChildren(customer) {
  if (!Array.isArray(customer.children)) customer.children = [];
  return customer.children;
}

function upsertChild(customer, child) {
  const list = ensureChildren(customer);
  const key = childKey(child);
  const hit = list.find((c) => childKey(c) === key);
  if (hit) return ensureUid(hit);

  const next = {
    uid: newUid(),
    firstName: safeText(child.firstName),
    lastName: safeText(child.lastName),
    birthDate: child.birthDate || null,
    gender: "",
    club: safeText(child.club),
  };

  list.push(next);
  if (!safeText(customer.child?.uid)) customer.child = next;
  return next.uid;
}

async function attachChildToExistingCustomer({ ownerId, emailLower, child }) {
  if (!ownerId || !emailLower) return { ok: false, reason: "missing" };
  const hasName = safeText(child?.firstName) || safeText(child?.lastName);
  if (!hasName) return { ok: false, reason: "no_child" };

  const customer = await Customer.findOne({
    owner: ownerId,
    $or: [
      { emailLower },
      { email: emailLower },
      { "parent.email": emailLower },
    ],
  });

  if (!customer) return { ok: false, reason: "no_customer" };

  ensureUid(customer.child);
  for (const c of ensureChildren(customer)) ensureUid(c);

  const uid = upsertChild(customer, child);

  if (!safeText(customer.child?.uid) && customer.children?.[0])
    customer.child = customer.children[0];

  await customer.save();
  return { ok: true, customerId: String(customer._id), childUid: uid };
}

module.exports = { attachChildToExistingCustomer };
