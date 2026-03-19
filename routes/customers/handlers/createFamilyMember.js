//routes\customers\handlers\createFamilyMember.js
"use strict";

const Customer = require("../../../models/Customer");

async function createFamilyMember(req, res, requireOwner, requireId) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const baseCustomer = await Customer.findOne({ _id: id, owner });
    if (!baseCustomer) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    const body = req.body || {};
    const parent = body.parent || {};

    const sal = ["Frau", "Herr"].includes(parent.salutation)
      ? parent.salutation
      : "";

    const pFirst = String(parent.firstName || "").trim();
    const pLast = String(parent.lastName || "").trim();
    const pEmail = String(parent.email || "").trim();
    const pPhone = String(parent.phone || "").trim();
    const pPhone2 = String(parent.phone2 || "").trim();

    if (!pFirst && !pLast && !pEmail) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PARENT",
        message: "At least name or email must be provided for the new parent.",
      });
    }

    let childPayload = null;

    if (body.childOverride) {
      const co = body.childOverride;
      childPayload = {
        firstName: String(co.firstName || ""),
        lastName: String(co.lastName || ""),
        gender: "",
        birthDate: co.birthDate ? new Date(co.birthDate) : null,
        club: "",
      };
    } else if (body.copyChildFromBase) {
      const baseChild =
        baseCustomer.child ||
        (Array.isArray(baseCustomer.children) && baseCustomer.children[0]) ||
        null;

      if (baseChild) {
        childPayload = {
          firstName: baseChild.firstName || "",
          lastName: baseChild.lastName || "",
          gender: baseChild.gender || "",
          birthDate: baseChild.birthDate ? new Date(baseChild.birthDate) : null,
          club: baseChild.club || "",
        };
      }
    }

    const newDoc = await Customer.create({
      owner,
      userId: await Customer.nextUserIdForOwner(owner),
      newsletter: false,
      address: {
        street: "",
        houseNo: "",
        zip: "",
        city: "",
      },
      child: childPayload,
      parent: {
        salutation: sal,
        firstName: pFirst,
        lastName: pLast,
        email: pEmail,
        phone: pPhone,
        phone2: pPhone2,
      },
      notes: "",
      bookings: [],
      relatedCustomerIds: [baseCustomer._id],
    });

    const rels = new Set(
      (baseCustomer.relatedCustomerIds || []).map((x) => String(x)),
    );
    rels.add(String(newDoc._id));
    baseCustomer.relatedCustomerIds = Array.from(rels);
    await baseCustomer.save();

    return res.status(201).json({
      ok: true,
      baseCustomerId: String(baseCustomer._id),
      newMemberId: String(newDoc._id),
      member: {
        _id: String(newDoc._id),
        userId: newDoc.userId,
        parent: {
          salutation: newDoc.parent?.salutation || "",
          firstName: newDoc.parent?.firstName || "",
          lastName: newDoc.parent?.lastName || "",
          email: newDoc.parent?.email || "",
        },
        child: newDoc.child || null,
        children: Array.isArray(newDoc.children) ? newDoc.children : [],
      },
    });
  } catch (err) {
    console.error("[customers/:id/family-members] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { createFamilyMember };
