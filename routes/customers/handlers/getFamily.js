//routes\customers\handlers\getFamily.js
"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../models/Customer");

function safeText(v) {
  return String(v ?? "").trim();
}

function normChild(ch) {
  if (!ch) return null;
  return {
    uid: safeText(ch.uid),
    firstName: safeText(ch.firstName),
    lastName: safeText(ch.lastName),
    birthDate: ch.birthDate || null,
  };
}

function normParent(parent, fallbackEmail = "") {
  if (!parent) {
    return {
      salutation: "",
      firstName: "",
      lastName: "",
      email: safeText(fallbackEmail),
      phone: "",
      phone2: "",
    };
  }

  return {
    salutation: safeText(parent.salutation),
    firstName: safeText(parent.firstName),
    lastName: safeText(parent.lastName),
    email: safeText(parent.email || fallbackEmail),
    phone: safeText(parent.phone),
    phone2: safeText(parent.phone2),
  };
}

function hasParentData(parent) {
  return !!(
    safeText(parent?.salutation) ||
    safeText(parent?.firstName) ||
    safeText(parent?.lastName) ||
    safeText(parent?.email) ||
    safeText(parent?.phone) ||
    safeText(parent?.phone2)
  );
}

function sameParent(a, b) {
  const aEmail = safeText(a?.email).toLowerCase();
  const bEmail = safeText(b?.email).toLowerCase();

  if (aEmail && bEmail) return aEmail === bEmail;

  return (
    safeText(a?.firstName).toLowerCase() ===
      safeText(b?.firstName).toLowerCase() &&
    safeText(a?.lastName).toLowerCase() === safeText(b?.lastName).toLowerCase()
  );
}

function buildParents(member) {
  const list = Array.isArray(member?.parents)
    ? member.parents.map((p) => normParent(p))
    : [];

  const legacy = normParent(member?.parent, member?.email);
  if (hasParentData(legacy) && !list.some((p) => sameParent(p, legacy))) {
    list.push(legacy);
  }

  return list.filter(hasParentData);
}

async function getFamily(req, res) {
  try {
    const ownerId = req.get("x-provider-id") || req.get("X-Provider-Id");
    const rawId = safeText(req.params.id);

    if (!ownerId || !mongoose.isValidObjectId(ownerId)) {
      return res
        .status(401)
        .json({ ok: false, error: "Unauthorized: invalid provider" });
    }

    if (!mongoose.isValidObjectId(rawId)) {
      return res.status(400).json({ ok: false, error: "Invalid customer id" });
    }

    const owner = new mongoose.Types.ObjectId(ownerId);
    const baseId = new mongoose.Types.ObjectId(rawId);

    const baseCustomer = await Customer.findOne({ _id: baseId, owner }).lean();
    if (!baseCustomer) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    const seen = new Set();
    const queue = [String(baseCustomer._id)];

    while (queue.length) {
      const currentId = queue.shift();
      if (!currentId || seen.has(currentId)) continue;
      seen.add(currentId);

      const current = await Customer.findOne({
        _id: new mongoose.Types.ObjectId(currentId),
        owner,
      })
        .select("_id relatedCustomerIds")
        .lean();

      if (!current) continue;

      const forward = (current.relatedCustomerIds || []).map((x) => String(x));
      forward.forEach((rid) => !seen.has(rid) && queue.push(rid));

      const backLinks = await Customer.find({
        owner,
        relatedCustomerIds: current._id,
      })
        .select("_id")
        .lean();

      backLinks.forEach((b) => {
        const bid = String(b._id);
        !seen.has(bid) && queue.push(bid);
      });
    }

    const allIds = Array.from(seen).map(
      (id) => new mongoose.Types.ObjectId(id),
    );

    const members = await Customer.find({
      owner,
      _id: { $in: allIds },
    })
      //  .select("_id userId parent child children email relatedCustomerIds")
      .select(
        "_id userId parent parents child children email relatedCustomerIds",
      )
      .lean();

    // const normalizedMembers = members.map((m) => {
    //   const legacy = normChild(m.child);
    //   const arr = Array.isArray(m.children) ? m.children.map(normChild) : [];
    //   const children = arr.filter(Boolean);

    //   return {
    //     _id: String(m._id),
    //     userId: m.userId ?? null,
    //     parent: {
    //       salutation: safeText(m.parent?.salutation),
    //       firstName: safeText(m.parent?.firstName),
    //       lastName: safeText(m.parent?.lastName),
    //       email: safeText(m.parent?.email || m.email),
    //     },
    //     child: legacy,
    //     children: children.length ? children : legacy ? [legacy] : [],
    //   };
    // });

    const normalizedMembers = members.map((m) => {
      const legacy = normChild(m.child);
      const arr = Array.isArray(m.children) ? m.children.map(normChild) : [];
      const children = arr.filter(Boolean);
      const parents = buildParents(m);
      const activeParent = parents[0] || normParent(m.parent, m.email);

      return {
        _id: String(m._id),
        userId: m.userId ?? null,
        parent: activeParent,
        parents,
        child: legacy,
        children: children.length ? children : legacy ? [legacy] : [],
      };
    });

    return res.json({
      ok: true,
      baseCustomerId: String(baseCustomer._id),
      members: normalizedMembers,
    });
  } catch (err) {
    console.error("[customers/:id/family] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { getFamily };
