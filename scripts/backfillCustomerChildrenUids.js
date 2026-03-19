"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const Customer = require("../models/Customer");

function safeText(v) {
  return String(v ?? "").trim();
}

function isoDay(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function newUid() {
  const g = globalThis?.crypto;
  if (g?.randomUUID) return g.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sameChild(a, b) {
  const af = safeText(a?.firstName).toLowerCase();
  const al = safeText(a?.lastName).toLowerCase();
  const bf = safeText(b?.firstName).toLowerCase();
  const bl = safeText(b?.lastName).toLowerCase();
  return (
    af === bf && al === bl && isoDay(a?.birthDate) === isoDay(b?.birthDate)
  );
}

function hasChildData(ch) {
  return !!(safeText(ch?.firstName) || safeText(ch?.lastName));
}

function normalizeChild(ch, uid) {
  return {
    uid: safeText(uid) || newUid(),
    firstName: safeText(ch?.firstName),
    lastName: safeText(ch?.lastName),
    birthDate: ch?.birthDate ? new Date(ch.birthDate) : null,
    gender: safeText(ch?.gender),
    club: safeText(ch?.club),
  };
}

async function run() {
  const mongoUrl =
    process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_URI;

  if (!mongoUrl) {
    throw new Error("Missing MONGO_URL / MONGODB_URI / MONGO_URI");
  }

  await mongoose.connect(mongoUrl);

  let touchedCustomers = 0;
  let touchedChildren = 0;

  const cursor = Customer.find({}).lean().cursor();

  for await (const c of cursor) {
    const set = {};
    let changed = false;

    const children = Array.isArray(c?.children) ? c.children : [];
    const legacy = c?.child || null;

    const nextChildren = children.map((ch) => {
      if (!ch) return ch;
      const uid = safeText(ch.uid);
      if (uid) return ch;
      touchedChildren += 1;
      changed = true;
      return { ...ch, uid: newUid() };
    });

    const hasLegacy = legacy && hasChildData(legacy);

    let legacyUid = hasLegacy ? safeText(legacy.uid) : "";
    if (hasLegacy && !legacyUid) {
      const hit = nextChildren.find((x) => sameChild(x, legacy));
      legacyUid = safeText(hit?.uid) || newUid();
      touchedChildren += 1;
      changed = true;
      set["child.uid"] = legacyUid;
    }

    if (hasLegacy) {
      const exists = nextChildren.some((x) => sameChild(x, legacy));
      if (!exists) {
        nextChildren.push(normalizeChild(legacy, legacyUid));
        touchedChildren += 1;
        changed = true;
      }
    }

    if (
      !Array.isArray(c?.children) ||
      nextChildren.length !== children.length
    ) {
      set.children = nextChildren;
      changed = true;
    } else {
      const changedAny = nextChildren.some(
        (ch, i) => safeText(ch?.uid) !== safeText(children[i]?.uid),
      );
      if (changedAny) {
        set.children = nextChildren;
        changed = true;
      }
    }

    if (!changed) continue;

    await Customer.collection.updateOne({ _id: c._id }, { $set: set });
    touchedCustomers += 1;
  }

  console.log(JSON.stringify({ ok: true, touchedCustomers, touchedChildren }));
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
