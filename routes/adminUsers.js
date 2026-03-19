// // routes/adminUsers.js
// // routes/adminUsers.js
// routes/adminUsers.js
"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Types } = require("mongoose");

const AdminUser = require("../models/AdminUser");
const adminAuth = require("../middleware/adminAuth");
const requireOwner = require("../middleware/requireOwner");
const { sendPasswordResetMail } = require("../utils/mailer");

const router = express.Router();

const isValidId = (s) => typeof s === "string" && Types.ObjectId.isValid(s);

function cleanStr(v) {
  return String(v ?? "").trim();
}

function normEmail(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase();
}

function normRole(v) {
  const r = cleanStr(v).toLowerCase();
  return r === "super" || r === "provider" ? r : "";
}

function toUserPayload(user) {
  return {
    id: String(user._id),
    fullName: user.fullName || "",
    email: user.email,
    role: user.role || "provider",
    isOwner: Boolean(user.isOwner === true),
    // isActive: user.isActive !== false,
    isActive: Boolean(user.isActive),

    avatarUrl: user.avatarUrl || null,

    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
    updatedAt: user.updatedAt ? new Date(user.updatedAt).toISOString() : null,
  };
}

function isSuper(req) {
  return req.isSuperAdmin === true || String(req.role || "") === "super";
}

/* =========================
   POST /signup
   ========================= */

router.post("/signup", async (req, res) => {
  try {
    const { fullName, email, password } = req.body || {};
    const errors = {};

    const computedFullName = cleanStr(fullName);
    const normalizedEmail = normEmail(email);

    if (!computedFullName) errors.fullName = "Required";
    if (!/.+@.+\..+/.test(normalizedEmail)) errors.email = "Invalid email";
    if (!password || password.length < 6) errors.password = "Min. 6 characters";
    if (Object.keys(errors).length) {
      return res.status(400).json({ ok: false, errors });
    }

    const reserved = normEmail(process.env.ADMIN_EMAIL || "");
    if (reserved && normalizedEmail === reserved) {
      return res.status(409).json({
        ok: false,
        errors: { email: "This email is reserved for system admin" },
      });
    }

    const existing = await AdminUser.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({
        ok: false,
        errors: { email: "Email already registered" },
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await AdminUser.create({
      fullName: computedFullName,
      email: normalizedEmail,
      passwordHash,
      role: "provider",
      isOwner: false,
    });

    return res.status(201).json({ ok: true, user: toUserPayload(user) });
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({
        ok: false,
        errors: { email: "Email already registered" },
      });
    }
    if (e?.name === "ValidationError") {
      return res.status(400).json({
        ok: false,
        error: "Validation failed",
        details: e.errors,
      });
    }
    console.error("signup error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* =========================
   POST /login
   ========================= */

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Missing credentials" });
    }

    const normalizedEmail = normEmail(email);
    const user = await AdminUser.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    if (user.isActive === false) {
      return res.status(403).json({ ok: false, error: "Account disabled" });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    return res.json({ ok: true, user: toUserPayload(user) });
  } catch (e) {
    console.error("login error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* =========================
   GET /users  (super+ only)
   ========================= */

function normActive(v) {
  const s = cleanStr(v).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return null;
}

function normStatus(v) {
  const s = cleanStr(v).toLowerCase();
  if (s === "active") return "active";
  if (s === "inactive" || s === "disabled") return "inactive";
  return "";
}

router.get("/users", adminAuth, async (req, res) => {
  if (!isSuper(req)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  const q = cleanStr(req.query?.search || "");
  const role = normRole(req.query?.role);

  const active = normActive(req.query?.active);

  const status = normStatus(req.query?.status);

  const find = {};
  if (role) find.role = role;
  if (active !== null) find.isActive = active;
  if (status) {
    find.isActive = status === "active";
  }
  if (q) {
    find.$or = [
      { fullName: { $regex: q, $options: "i" } },
      { email: { $regex: q, $options: "i" } },
    ];
  }

  // const find = {};
  // if (role) find.role = role;
  // if (q) {
  //   find.$or = [
  //     { fullName: { $regex: q, $options: "i" } },
  //     { email: { $regex: q, $options: "i" } },
  //   ];
  // }

  const items = await AdminUser.find(find)
    // .select("_id fullName email role isOwner avatarUrl createdAt updatedAt")
    .select(
      "_id fullName email role isOwner isActive avatarUrl createdAt updatedAt",
    )

    .sort({ createdAt: -1 })
    .lean()
    .catch(() => []);

  return res.json({ ok: true, items: items.map((u) => toUserPayload(u)) });
});

/* =========================
   PATCH /users/:id/role  (owner only)
   ========================= */

router.patch("/users/:id/role", adminAuth, requireOwner, async (req, res) => {
  const targetId = cleanStr(req.params.id);
  const nextRole = normRole(req.body?.role);

  if (!targetId || !nextRole) {
    return res.status(400).json({ ok: false, error: "Invalid role" });
  }
  if (!isValidId(targetId)) {
    return res.status(400).json({ ok: false, error: "Invalid id format" });
  }

  const selfId = String(req.providerId || "");
  if (selfId === targetId && nextRole !== "super") {
    return res
      .status(400)
      .json({ ok: false, error: "Owner cannot be demoted" });
  }

  const target = await AdminUser.findById(targetId).catch(() => null);
  if (!target) {
    return res.status(404).json({ ok: false, error: "Not found" });
  }

  if (target.isOwner === true && nextRole !== "super") {
    return res
      .status(400)
      .json({ ok: false, error: "Owner cannot be demoted" });
  }

  target.role = nextRole;
  await target.save();

  return res.json({ ok: true, user: toUserPayload(target) });
});

/* =========================
   PATCH /users/:id/active  (owner only)
   body: { active: boolean }
   ========================= */

router.patch("/users/:id/active", adminAuth, requireOwner, async (req, res) => {
  const targetId = cleanStr(req.params.id);
  //const active = Boolean(req.body?.active);

  const hasActive = typeof req.body?.active === "boolean";
  if (!hasActive) {
    return res.status(400).json({ ok: false, error: "Missing active boolean" });
  }
  const active = req.body.active;

  if (!targetId) {
    return res.status(400).json({ ok: false, error: "Missing id" });
  }
  if (!isValidId(targetId)) {
    return res.status(400).json({ ok: false, error: "Invalid id format" });
  }

  const selfId = String(req.providerId || "");
  if (selfId === targetId) {
    return res
      .status(400)
      .json({ ok: false, error: "Owner cannot disable self" });
  }

  const target = await AdminUser.findById(targetId).catch(() => null);
  if (!target) {
    return res.status(404).json({ ok: false, error: "Not found" });
  }

  if (target.isOwner === true && active === false) {
    return res
      .status(400)
      .json({ ok: false, error: "Owner cannot be disabled" });
  }

  target.isActive = active;
  await target.save();

  return res.json({ ok: true, user: toUserPayload(target) });
});

/* =========================
   PATCH /users/bulk-active  (owner only)
   body: { ids: string[], active: boolean }
   ========================= */

router.patch(
  "/users/bulk-active",
  adminAuth,
  requireOwner,
  async (req, res) => {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(cleanStr).filter(Boolean)
      : [];
    // const active = Boolean(req.body?.active);

    const hasActive = typeof req.body?.active === "boolean";
    if (!hasActive) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing active boolean" });
    }
    const active = req.body.active;

    if (!ids.length) {
      return res.status(400).json({ ok: false, error: "Missing ids" });
    }

    const validIds = ids.filter(isValidId);
    if (!validIds.length) {
      return res.status(400).json({ ok: false, error: "Invalid id format" });
    }

    const selfId = String(req.providerId || "");
    const safeIds = validIds.filter((id) => id !== selfId);

    const targets = await AdminUser.find({ _id: { $in: safeIds } })
      .select("_id isOwner")
      .lean()
      .catch(() => []);

    const protectedIds = new Set(
      targets.filter((t) => t.isOwner === true).map((t) => String(t._id)),
    );

    const finalIds = safeIds.filter((id) => !protectedIds.has(id));

    if (!finalIds.length) {
      return res.status(400).json({ ok: false, error: "Nothing to update" });
    }

    await AdminUser.updateMany(
      { _id: { $in: finalIds } },
      { $set: { isActive: active } },
    );

    const refreshed = await AdminUser.find({ _id: { $in: validIds } })
      .select(
        "_id fullName email role isOwner isActive avatarUrl createdAt updatedAt",
      )
      .sort({ createdAt: -1 })
      .lean()
      .catch(() => []);

    return res.json({
      ok: true,
      items: refreshed.map((u) => toUserPayload(u)),
    });
  },
);

/* =========================
   GET /profile
   ========================= */

router.get("/profile", adminAuth, async (req, res) => {
  try {
    const q = req.query || {};
    const effId = cleanStr(q.id || req.providerId || "");
    const email = normEmail(q.email || "");

    let user = null;
    if (effId) {
      if (!isValidId(effId)) {
        return res.status(400).json({ ok: false, error: "Invalid id format" });
      }
      user = await AdminUser.findById(effId).lean();
    } else if (email) {
      user = await AdminUser.findOne({ email }).lean();
    } else {
      return res.status(400).json({ ok: false, error: "id or email required" });
    }

    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    return res.json({ ok: true, user: toUserPayload(user) });
  } catch (e) {
    console.error("[GET /profile] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* =========================
   POST /profile
   ========================= */

router.post("/profile", adminAuth, async (req, res) => {
  try {
    const { id: bodyId, email, fullName, avatar } = req.body || {};
    const effId = cleanStr(bodyId || req.providerId || "");

    let user = null;
    if (effId) {
      if (!isValidId(effId)) {
        return res.status(400).json({ ok: false, error: "Invalid id format" });
      }
      user = await AdminUser.findById(effId);
    } else if (email) {
      user = await AdminUser.findOne({ email: normEmail(email) });
    } else {
      return res.status(400).json({ ok: false, error: "id or email required" });
    }

    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    if (typeof fullName === "string") {
      const next = fullName.trim();
      if (next) user.fullName = next;
    }

    if (typeof email === "string" && email.trim()) {
      const next = normEmail(email);
      if (next !== user.email) {
        const exists = await AdminUser.findOne({ email: next });
        if (exists) {
          return res
            .status(409)
            .json({ ok: false, error: "Email already in use" });
        }
        user.email = next;
      }
    }

    if (typeof avatar === "string" && avatar.startsWith("data:")) {
      user.avatarUrl = avatar;
    }

    await user.save();
    return res.json({ ok: true, user: toUserPayload(user) });
  } catch (e) {
    console.error("[POST /profile] error:", e);
    return res.status(500).json({ ok: false, error: "Update failed" });
  }
});

/* =========================
   POST /forgot
   ========================= */

router.post("/forgot", async (req, res, next) => {
  try {
    const email = normEmail(req.body?.email || "");
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ ok: false, error: "Invalid email" });
    }

    const user = await AdminUser.findOne({ email }).exec();

    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      user.resetToken = token;
      user.resetTokenExp = new Date(Date.now() + 60 * 60 * 1000);
      await user.save();

      const base = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
      const link = `${base}/admin/new-password?token=${encodeURIComponent(
        token,
      )}&email=${encodeURIComponent(email)}`;

      sendPasswordResetMail(email, link).catch((err) =>
        console.error("[mailer] reset mail failed:", err?.message || err),
      );
    }

    return res.json({
      ok: true,
      message: "If the email exists, a reset link has been sent.",
    });
  } catch (err) {
    next(err);
  }
});

/* =========================
   POST /reset
   ========================= */

router.post("/reset", async (req, res, next) => {
  try {
    const token = cleanStr(req.body?.token || "");
    const password = String(req.body?.password || "");
    if (!token) {
      return res.status(400).json({ ok: false, error: "Missing token" });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: "Password too short" });
    }

    const user = await AdminUser.findOne({
      resetToken: token,
      resetTokenExp: { $gt: new Date() },
    }).exec();

    if (!user) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid or expired token" });
    }

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(password, salt);

    user.resetToken = undefined;
    user.resetTokenExp = undefined;

    await user.save();
    return res.json({ ok: true, message: "Password updated" });
  } catch (err) {
    next(err);
  }
});

/* =========================
   GET /me
   ========================= */

router.get("/me", adminAuth, async (req, res) => {
  try {
    const id = cleanStr(req.providerId || "");
    if (!id || !isValidId(id)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const doc = await AdminUser.findById(id)
      .lean()
      .catch(() => null);
    if (!doc) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    return res.json({
      ok: true,
      user: {
        id: String(doc._id),
        email: doc.email || "",
        fullName: doc.fullName || "",
        displayName: doc.fullName || doc.email || "Admin",
        role: doc.role || "provider",
        isOwner: Boolean(doc.isOwner === true),
        isSuperAdmin: String(doc.role || "") === "super",
        avatarUrl: doc.avatarUrl || null,
        isActive: doc.isActive !== false,
      },
    });
  } catch (e) {
    console.error("[adminUsers/me] failed:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;

// // routes/adminUsers.js
// "use strict";

// const express = require("express");
// const crypto = require("crypto");
// const bcrypt = require("bcryptjs");
// const { Types } = require("mongoose");

// const AdminUser = require("../models/AdminUser");
// const adminAuth = require("../middleware/adminAuth");
// const requireOwner = require("../middleware/requireOwner");
// const { sendPasswordResetMail } = require("../utils/mailer");

// const router = express.Router();

// const isValidId = (s) => typeof s === "string" && Types.ObjectId.isValid(s);
// const cleanStr = (v) => String(v ?? "").trim();
// const normEmail = (v) =>
//   String(v ?? "")
//     .trim()
//     .toLowerCase();

// function toUserPayload(user) {
//   return {
//     id: String(user._id),
//     fullName: user.fullName || "",
//     email: user.email,
//     role: user.role || "provider",
//     isOwner: Boolean(user.isOwner === true),
//     avatarUrl: user.avatarUrl || null,
//     createdAt: user.createdAt || null,
//     updatedAt: user.updatedAt || null,
//   };
// }

// function isSuper(req) {
//   return req.isSuperAdmin === true || String(req.role || "") === "super";
// }

// function normRole(v) {
//   const r = cleanStr(v).toLowerCase();
//   if (r === "super") return "super";
//   if (r === "provider") return "provider";
//   return null;
// }

// /* =========================
//    POST /signup
//    ========================= */
// router.post("/signup", async (req, res) => {
//   try {
//     const { fullName, email, password } = req.body || {};
//     const errors = {};

//     const computedFullName = cleanStr(fullName);
//     const normalizedEmail = normEmail(email);

//     if (!computedFullName) errors.fullName = "Required";
//     if (!/.+@.+\..+/.test(normalizedEmail)) errors.email = "Invalid email";
//     if (!password || password.length < 6) errors.password = "Min. 6 characters";
//     if (Object.keys(errors).length)
//       return res.status(400).json({ ok: false, errors });

//     const reserved = normEmail(process.env.ADMIN_EMAIL || "");
//     if (reserved && normalizedEmail === reserved) {
//       return res.status(409).json({
//         ok: false,
//         errors: { email: "This email is reserved for system admin" },
//       });
//     }

//     const existing = await AdminUser.findOne({ email: normalizedEmail });
//     if (existing) {
//       return res.status(409).json({
//         ok: false,
//         errors: { email: "Email already registered" },
//       });
//     }

//     const passwordHash = await bcrypt.hash(password, 12);

//     const user = await AdminUser.create({
//       fullName: computedFullName,
//       email: normalizedEmail,
//       passwordHash,
//     });

//     return res.status(201).json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     if (e?.code === 11000) {
//       return res.status(409).json({
//         ok: false,
//         errors: { email: "Email already registered" },
//       });
//     }
//     if (e?.name === "ValidationError") {
//       return res.status(400).json({
//         ok: false,
//         error: "Validation failed",
//         details: e.errors,
//       });
//     }
//     console.error("signup error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// /* =========================
//    POST /login
//    ========================= */
// router.post("/login", async (req, res) => {
//   try {
//     const { email, password } = req.body || {};
//     if (!email || !password) {
//       return res.status(400).json({ ok: false, error: "Missing credentials" });
//     }

//     const normalizedEmail = normEmail(email);
//     const user = await AdminUser.findOne({ email: normalizedEmail });
//     if (!user)
//       return res.status(401).json({ ok: false, error: "Invalid credentials" });

//     const ok = await user.comparePassword(password);
//     if (!ok)
//       return res.status(401).json({ ok: false, error: "Invalid credentials" });

//     return res.json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     console.error("login error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// /* =========================
//    GET /users (list + filters)
//    ========================= */
// router.get("/users", adminAuth, async (req, res) => {
//   if (!isSuper(req))
//     return res.status(403).json({ ok: false, error: "Forbidden" });

//   const q = cleanStr(req.query?.search || "");
//   const role = normRole(req.query?.role);

//   const find = {};
//   if (role) find.role = role;
//   if (q) {
//     find.$or = [
//       { fullName: { $regex: q, $options: "i" } },
//       { email: { $regex: q, $options: "i" } },
//     ];
//   }

//   const items = await AdminUser.find(find)
//     .select("_id fullName email role isOwner avatarUrl createdAt updatedAt")
//     .sort({ createdAt: -1 })
//     .lean()
//     .catch(() => []);

//   return res.json({ ok: true, items: items.map((u) => toUserPayload(u)) });
// });

// /* =========================
//    PATCH /users/:id/role (owner-only)
//    ========================= */
// router.patch("/users/:id/role", adminAuth, requireOwner, async (req, res) => {
//   const targetId = cleanStr(req.params.id);
//   const nextRole = normRole(req.body?.role);

//   if (!targetId || !nextRole) {
//     return res.status(400).json({ ok: false, error: "Invalid role" });
//   }
//   if (!isValidId(targetId)) {
//     return res.status(400).json({ ok: false, error: "Invalid id format" });
//   }

//   const selfId = String(req.providerId || "");
//   if (selfId === targetId && nextRole !== "super") {
//     return res
//       .status(400)
//       .json({ ok: false, error: "Owner cannot be demoted" });
//   }

//   const target = await AdminUser.findById(targetId).catch(() => null);
//   if (!target) return res.status(404).json({ ok: false, error: "Not found" });

//   if (target.isOwner === true && nextRole !== "super") {
//     return res
//       .status(400)
//       .json({ ok: false, error: "Owner cannot be demoted" });
//   }

//   target.role = nextRole;
//   await target.save();

//   return res.json({ ok: true, user: toUserPayload(target) });
// });

// /* =========================
//    GET /profile
//    ========================= */
// router.get("/profile", adminAuth, async (req, res) => {
//   try {
//     const q = req.query || {};
//     const effId = cleanStr(q.id || req.providerId || "");
//     const email = normEmail(q.email || "");

//     let user = null;

//     if (effId) {
//       if (!isValidId(effId)) {
//         return res.status(400).json({ ok: false, error: "Invalid id format" });
//       }
//       user = await AdminUser.findById(effId).lean();
//     } else if (email) {
//       user = await AdminUser.findOne({ email }).lean();
//     } else {
//       return res.status(400).json({ ok: false, error: "id or email required" });
//     }

//     if (!user)
//       return res.status(404).json({ ok: false, error: "User not found" });

//     return res.json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     console.error("[GET /profile] error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// /* =========================
//    POST /profile
//    ========================= */
// router.post("/profile", adminAuth, async (req, res) => {
//   try {
//     const { id: bodyId, email, fullName, avatar } = req.body || {};
//     const effId = cleanStr(bodyId || req.providerId || "");

//     let user = null;

//     if (effId) {
//       if (!isValidId(effId)) {
//         return res.status(400).json({ ok: false, error: "Invalid id format" });
//       }
//       user = await AdminUser.findById(effId);
//     } else if (email) {
//       user = await AdminUser.findOne({ email: normEmail(email) });
//     } else {
//       return res.status(400).json({ ok: false, error: "id or email required" });
//     }

//     if (!user)
//       return res.status(404).json({ ok: false, error: "User not found" });

//     if (typeof fullName === "string") {
//       const next = fullName.trim();
//       if (next) user.fullName = next;
//     }

//     if (typeof email === "string" && email.trim()) {
//       const next = normEmail(email);
//       if (next !== user.email) {
//         const exists = await AdminUser.findOne({ email: next });
//         if (exists)
//           return res
//             .status(409)
//             .json({ ok: false, error: "Email already in use" });
//         user.email = next;
//       }
//     }

//     if (typeof avatar === "string" && avatar.startsWith("data:")) {
//       user.avatarUrl = avatar;
//     }

//     await user.save();
//     return res.json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     console.error("[POST /profile] error:", e);
//     return res.status(500).json({ ok: false, error: "Update failed" });
//   }
// });

// /* =========================
//    POST /forgot
//    ========================= */
// router.post("/forgot", async (req, res, next) => {
//   try {
//     const email = normEmail(req.body?.email || "");
//     if (!/^\S+@\S+\.\S+$/.test(email)) {
//       return res.status(400).json({ ok: false, error: "Invalid email" });
//     }

//     const user = await AdminUser.findOne({ email }).exec();

//     if (user) {
//       const token = crypto.randomBytes(32).toString("hex");
//       user.resetToken = token;
//       user.resetTokenExp = new Date(Date.now() + 60 * 60 * 1000);
//       await user.save();

//       const base = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
//       const link = `${base}/admin/new-password?token=${encodeURIComponent(
//         token,
//       )}&email=${encodeURIComponent(email)}`;

//       sendPasswordResetMail(email, link).catch((err) =>
//         console.error("[mailer] reset mail failed:", err?.message || err),
//       );
//     }

//     return res.json({
//       ok: true,
//       message: "If the email exists, a reset link has been sent.",
//     });
//   } catch (err) {
//     next(err);
//   }
// });

// /* =========================
//    POST /reset
//    ========================= */
// router.post("/reset", async (req, res, next) => {
//   try {
//     const token = cleanStr(req.body?.token || "");
//     const password = String(req.body?.password || "");

//     if (!token)
//       return res.status(400).json({ ok: false, error: "Missing token" });
//     if (password.length < 6)
//       return res.status(400).json({ ok: false, error: "Password too short" });

//     const user = await AdminUser.findOne({
//       resetToken: token,
//       resetTokenExp: { $gt: new Date() },
//     }).exec();

//     if (!user) {
//       return res
//         .status(400)
//         .json({ ok: false, error: "Invalid or expired token" });
//     }

//     const salt = await bcrypt.genSalt(10);
//     user.passwordHash = await bcrypt.hash(password, salt);

//     user.resetToken = undefined;
//     user.resetTokenExp = undefined;

//     await user.save();
//     return res.json({ ok: true, message: "Password updated" });
//   } catch (err) {
//     next(err);
//   }
// });

/* =========================
   GET /me
   ========================= */
router.get("/me", adminAuth, async (req, res) => {
  try {
    const id = cleanStr(req.providerId || "");
    if (!id || !isValidId(id)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const doc = await AdminUser.findById(id)
      .lean()
      .catch(() => null);
    if (!doc) return res.status(401).json({ ok: false, error: "Unauthorized" });

    return res.json({
      ok: true,
      user: {
        id: String(doc._id),
        email: doc.email || "",
        fullName: doc.fullName || "",
        displayName: doc.fullName || doc.email || "Admin",
        role: doc.role || "provider",
        isOwner: Boolean(doc.isOwner === true),
        isSuperAdmin: String(doc.role || "") === "super",
        avatarUrl: doc.avatarUrl || null,
      },
    });
  } catch (e) {
    console.error("[adminUsers/me] failed:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;

// "use strict";
// const express = require("express");
// const crypto = require("crypto");
// const bcrypt = require("bcryptjs");
// const { Types } = require("mongoose");

// const AdminUser = require("../models/AdminUser");
// const adminAuth = require("../middleware/adminAuth");
// const requireOwner = require("../middleware/requireOwner");
// const { sendPasswordResetMail } = require("../utils/mailer");

// const router = express.Router();

// const isValidId = (s) => typeof s === "string" && Types.ObjectId.isValid(s);
// const cleanStr = (v) => String(v ?? "").trim();
// const normEmail = (v) =>
//   String(v ?? "")
//     .trim()
//     .toLowerCase();

// function toUserPayload(user) {
//   return {
//     id: String(user._id),
//     fullName: user.fullName || "",
//     email: user.email,
//     role: user.role || "provider",
//     isOwner: Boolean(user.isOwner === true),
//     avatarUrl: user.avatarUrl || null,
//   };
// }

// function isSuper(req) {
//   return req.isSuperAdmin === true || String(req.role || "") === "super";
// }

// function normRole(v) {
//   const r = cleanStr(v).toLowerCase();
//   return r === "super" || r === "provider" ? r : "";
// }

// router.post("/signup", async (req, res) => {
//   try {
//     const { fullName, email, password } = req.body || {};
//     const errors = {};

//     const computedFullName = cleanStr(fullName);
//     const normalizedEmail = normEmail(email);

//     if (!computedFullName) errors.fullName = "Required";
//     if (!/.+@.+\..+/.test(normalizedEmail)) errors.email = "Invalid email";
//     if (!password || password.length < 6) errors.password = "Min. 6 characters";
//     if (Object.keys(errors).length)
//       return res.status(400).json({ ok: false, errors });

//     const reserved = normEmail(process.env.ADMIN_EMAIL || "");
//     if (reserved && normalizedEmail === reserved) {
//       return res.status(409).json({
//         ok: false,
//         errors: { email: "This email is reserved for system admin" },
//       });
//     }

//     const existing = await AdminUser.findOne({ email: normalizedEmail });
//     if (existing) {
//       return res.status(409).json({
//         ok: false,
//         errors: { email: "Email already registered" },
//       });
//     }

//     const passwordHash = await bcrypt.hash(password, 12);

//     const user = await AdminUser.create({
//       fullName: computedFullName,
//       email: normalizedEmail,
//       passwordHash,
//     });

//     return res.status(201).json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     if (e?.code === 11000) {
//       return res.status(409).json({
//         ok: false,
//         errors: { email: "Email already registered" },
//       });
//     }
//     if (e?.name === "ValidationError") {
//       return res.status(400).json({
//         ok: false,
//         error: "Validation failed",
//         details: e.errors,
//       });
//     }
//     console.error("signup error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// router.post("/login", async (req, res) => {
//   try {
//     const { email, password } = req.body || {};
//     if (!email || !password) {
//       return res.status(400).json({ ok: false, error: "Missing credentials" });
//     }

//     const normalizedEmail = normEmail(email);
//     const user = await AdminUser.findOne({ email: normalizedEmail });
//     if (!user)
//       return res.status(401).json({ ok: false, error: "Invalid credentials" });

//     const ok = await user.comparePassword(password);
//     if (!ok)
//       return res.status(401).json({ ok: false, error: "Invalid credentials" });

//     return res.json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     console.error("login error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// router.get("/", async (_req, res) => {
//   if (!req.isSuperAdmin) {
//     return res.status(403).json({ ok: false, error: "Forbidden" });
//   }
//   const users = await AdminUser.find()
//     .select("_id fullName email role isOwner avatarUrl createdAt")
//     .sort({ createdAt: -1 });

//   res.json({ ok: true, users: users.map((u) => toUserPayload(u)) });
// });

// router.get("/users", adminAuth, async (req, res) => {
//   if (!isSuper(req))
//     return res.status(403).json({ ok: false, error: "Forbidden" });

//   const q = cleanStr(req.query?.search || "");
//   const role = normRole(req.query?.role);

//   const find = {};
//   if (role) find.role = role;
//   if (q) {
//     find.$or = [
//       { fullName: { $regex: q, $options: "i" } },
//       { email: { $regex: q, $options: "i" } },
//     ];
//   }

//   const items = await AdminUser.find(find)
//     .select("_id fullName email role isOwner avatarUrl createdAt updatedAt")
//     .sort({ createdAt: -1 })
//     .lean()
//     .catch(() => []);

//   return res.json({ ok: true, items: items.map((u) => toUserPayload(u)) });
// });

// router.patch("/users/:id/role", adminAuth, requireOwner, async (req, res) => {
//   const targetId = cleanStr(req.params.id);
//   const nextRole = normRole(req.body?.role);

//   if (!targetId || !nextRole) {
//     return res.status(400).json({ ok: false, error: "Invalid role" });
//   }
//   if (!isValidId(targetId)) {
//     return res.status(400).json({ ok: false, error: "Invalid id format" });
//   }

//   const selfId = String(req.providerId || "");
//   if (selfId === targetId && nextRole !== "super") {
//     return res
//       .status(400)
//       .json({ ok: false, error: "Owner cannot be demoted" });
//   }

//   const target = await AdminUser.findById(targetId).catch(() => null);
//   if (!target) return res.status(404).json({ ok: false, error: "Not found" });

//   if (target.isOwner === true && nextRole !== "super") {
//     return res
//       .status(400)
//       .json({ ok: false, error: "Owner cannot be demoted" });
//   }

//   target.role = nextRole;
//   await target.save();

//   return res.json({ ok: true, user: toUserPayload(target) });
// });

// router.get("/profile", adminAuth, async (req, res) => {
//   try {
//     const q = req.query || {};
//     const effId = cleanStr(q.id || req.providerId || "");
//     const email = normEmail(q.email || "");

//     let user = null;
//     if (effId) {
//       if (!isValidId(effId)) {
//         return res.status(400).json({ ok: false, error: "Invalid id format" });
//       }
//       user = await AdminUser.findById(effId).lean();
//     } else if (email) {
//       user = await AdminUser.findOne({ email }).lean();
//     } else {
//       return res.status(400).json({ ok: false, error: "id or email required" });
//     }

//     if (!user)
//       return res.status(404).json({ ok: false, error: "User not found" });

//     return res.json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     console.error("[GET /profile] error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// router.post("/profile", adminAuth, async (req, res) => {
//   try {
//     const { id: bodyId, email, fullName, avatar } = req.body || {};
//     const effId = cleanStr(bodyId || req.providerId || "");

//     let user = null;
//     if (effId) {
//       if (!isValidId(effId)) {
//         return res.status(400).json({ ok: false, error: "Invalid id format" });
//       }
//       user = await AdminUser.findById(effId);
//     } else if (email) {
//       user = await AdminUser.findOne({ email: normEmail(email) });
//     } else {
//       return res.status(400).json({ ok: false, error: "id or email required" });
//     }

//     if (!user)
//       return res.status(404).json({ ok: false, error: "User not found" });

//     if (typeof fullName === "string") {
//       const next = fullName.trim();
//       if (next) user.fullName = next;
//     }

//     if (typeof email === "string" && email.trim()) {
//       const next = normEmail(email);
//       if (next !== user.email) {
//         const exists = await AdminUser.findOne({ email: next });
//         if (exists)
//           return res
//             .status(409)
//             .json({ ok: false, error: "Email already in use" });
//         user.email = next;
//       }
//     }

//     if (typeof avatar === "string" && avatar.startsWith("data:")) {
//       user.avatarUrl = avatar;
//     }

//     await user.save();
//     return res.json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     console.error("[POST /profile] error:", e);
//     return res.status(500).json({ ok: false, error: "Update failed" });
//   }
// });

// router.post("/forgot", async (req, res, next) => {
//   try {
//     const email = normEmail(req.body?.email || "");
//     if (!/^\S+@\S+\.\S+$/.test(email)) {
//       return res.status(400).json({ ok: false, error: "Invalid email" });
//     }

//     const user = await AdminUser.findOne({ email }).exec();

//     if (user) {
//       const token = crypto.randomBytes(32).toString("hex");
//       user.resetToken = token;
//       user.resetTokenExp = new Date(Date.now() + 60 * 60 * 1000);
//       await user.save();

//       const base = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
//       const link = `${base}/admin/new-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

//       sendPasswordResetMail(email, link).catch((err) =>
//         console.error("[mailer] reset mail failed:", err?.message || err),
//       );
//     }

//     return res.json({
//       ok: true,
//       message: "If the email exists, a reset link has been sent.",
//     });
//   } catch (err) {
//     next(err);
//   }
// });

// router.post("/reset", async (req, res, next) => {
//   try {
//     const token = cleanStr(req.body?.token || "");
//     const password = String(req.body?.password || "");
//     if (!token)
//       return res.status(400).json({ ok: false, error: "Missing token" });
//     if (password.length < 6)
//       return res.status(400).json({ ok: false, error: "Password too short" });

//     const user = await AdminUser.findOne({
//       resetToken: token,
//       resetTokenExp: { $gt: new Date() },
//     }).exec();

//     if (!user) {
//       return res
//         .status(400)
//         .json({ ok: false, error: "Invalid or expired token" });
//     }

//     const salt = await bcrypt.genSalt(10);
//     user.passwordHash = await bcrypt.hash(password, salt);

//     user.resetToken = undefined;
//     user.resetTokenExp = undefined;

//     await user.save();
//     return res.json({ ok: true, message: "Password updated" });
//   } catch (err) {
//     next(err);
//   }
// });

// router.get("/me", adminAuth, async (req, res) => {
//   try {
//     const id = cleanStr(req.providerId || "");
//     if (!id || !isValidId(id)) {
//       return res.status(401).json({ ok: false, error: "Unauthorized" });
//     }

//     const doc = await AdminUser.findById(id)
//       .lean()
//       .catch(() => null);
//     if (!doc) return res.status(401).json({ ok: false, error: "Unauthorized" });

//     return res.json({
//       ok: true,
//       user: {
//         id: String(doc._id),
//         email: doc.email || "",
//         fullName: doc.fullName || "",
//         displayName: doc.fullName || doc.email || "Admin",
//         role: doc.role || "provider",
//         isOwner: Boolean(doc.isOwner === true),
//         isSuperAdmin: String(doc.role || "") === "super",
//         avatarUrl: doc.avatarUrl || null,
//       },
//     });
//   } catch (e) {
//     console.error("[adminUsers/me] failed:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// module.exports = router;

// "use strict";
// const express = require("express");
// const crypto = require("crypto");
// const bcrypt = require("bcryptjs");
// const AdminUser = require("../models/AdminUser");

// const adminAuth = require("../middleware/adminAuth");
// const { sendPasswordResetMail } = require("../utils/mailer");

// const router = express.Router();

// const { Types } = require("mongoose");
// const isValidId = (s) => typeof s === "string" && Types.ObjectId.isValid(s);

// const cleanStr = (v) => String(v ?? "").trim();

// function toUserPayload(user) {
//   return {
//     id: String(user._id),
//     fullName: user.fullName || "",
//     email: user.email,
//     role: user.role || "provider",
//     avatarUrl: user.avatarUrl || null,
//   };
// }

// /* =========================
//    POST /signup
//    ========================= */

// router.post("/signup", async (req, res) => {
//   try {
//     const { fullName, email, password } = req.body || {};
//     const errors = {};

//     const computedFullName = cleanStr(fullName);
//     const normalizedEmail = String(email || "")
//       .trim()
//       .toLowerCase();

//     if (!computedFullName) errors.fullName = "Required";
//     if (!/.+@.+\..+/.test(normalizedEmail)) errors.email = "Invalid email";
//     if (!password || password.length < 6) errors.password = "Min. 6 characters";
//     if (Object.keys(errors).length)
//       return res.status(400).json({ ok: false, errors });

//     // Optional: ENV-Admin für Signup sperren
//     const reserved = String(process.env.ADMIN_EMAIL || "")
//       .trim()
//       .toLowerCase();
//     if (reserved && normalizedEmail === reserved) {
//       return res.status(409).json({
//         ok: false,
//         errors: { email: "This email is reserved for system admin" },
//       });
//     }

//     const existing = await AdminUser.findOne({ email: normalizedEmail });
//     if (existing)
//       return res
//         .status(409)
//         .json({ ok: false, errors: { email: "Email already registered" } });

//     const passwordHash = await bcrypt.hash(password, 12);

//     const user = await AdminUser.create({
//       fullName: computedFullName,
//       email: normalizedEmail,
//       passwordHash,
//     });

//     return res.status(201).json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     if (e?.code === 11000) {
//       return res
//         .status(409)
//         .json({ ok: false, errors: { email: "Email already registered" } });
//     }
//     if (e?.name === "ValidationError") {
//       return res
//         .status(400)
//         .json({ ok: false, error: "Validation failed", details: e.errors });
//     }
//     console.error("signup error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// /* =========================
//    POST /login
//    ========================= */

// router.post("/login", async (req, res) => {
//   try {
//     const { email, password } = req.body || {};
//     if (!email || !password)
//       return res.status(400).json({ ok: false, error: "Missing credentials" });

//     const normalizedEmail = String(email).trim().toLowerCase();
//     const user = await AdminUser.findOne({ email: normalizedEmail });
//     if (!user)
//       return res.status(401).json({ ok: false, error: "Invalid credentials" });

//     const ok = await user.comparePassword(password);
//     if (!ok)
//       return res.status(401).json({ ok: false, error: "Invalid credentials" });

//     return res.json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     console.error("login error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// /* =========================
//    GET /api/admin/auth  (simple list)
//    ========================= */

// router.get("/", async (_req, res) => {
//   const users = await AdminUser.find()
//     .select("_id fullName email role createdAt")
//     .sort({ createdAt: -1 });

//   res.json({ ok: true, users: users.map((u) => toUserPayload(u)) });
// });

// /* =========================
//    GET /profile
//    ========================= */

// router.get("/profile", adminAuth, async (req, res) => {
//   try {
//     const q = req.query || {};
//     const effId = (q.id || req.providerId || "").toString().trim();
//     const email = (q.email || "").toString().trim().toLowerCase();

//     let user = null;
//     if (effId) {
//       if (!isValidId(effId)) {
//         return res.status(400).json({ ok: false, error: "Invalid id format" });
//       }
//       user = await AdminUser.findById(effId).lean();
//     } else if (email) {
//       user = await AdminUser.findOne({ email }).lean();
//     } else {
//       return res.status(400).json({ ok: false, error: "id or email required" });
//     }

//     if (!user)
//       return res.status(404).json({ ok: false, error: "User not found" });

//     return res.json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     console.error("[GET /profile] error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// /* =========================
//    POST /profile
//    ========================= */

// router.post("/profile", adminAuth, async (req, res) => {
//   try {
//     const { id: bodyId, email, fullName, avatar } = req.body || {};
//     const effId = (bodyId || req.providerId || "").toString().trim();

//     let user = null;
//     if (effId) {
//       if (!isValidId(effId)) {
//         return res.status(400).json({ ok: false, error: "Invalid id format" });
//       }
//       user = await AdminUser.findById(effId);
//     } else if (email) {
//       user = await AdminUser.findOne({
//         email: String(email).trim().toLowerCase(),
//       });
//     } else {
//       return res.status(400).json({ ok: false, error: "id or email required" });
//     }

//     if (!user)
//       return res.status(404).json({ ok: false, error: "User not found" });

//     // fullName
//     if (typeof fullName === "string") {
//       const next = fullName.trim();
//       if (next) user.fullName = next;
//     }

//     // Email
//     if (typeof email === "string" && email.trim()) {
//       const next = String(email).trim().toLowerCase();
//       if (next !== user.email) {
//         const exists = await AdminUser.findOne({ email: next });
//         if (exists)
//           return res
//             .status(409)
//             .json({ ok: false, error: "Email already in use" });
//         user.email = next;
//       }
//     }

//     // Avatar
//     if (typeof avatar === "string" && avatar.startsWith("data:")) {
//       user.avatarUrl = avatar;
//     }

//     await user.save();
//     return res.json({ ok: true, user: toUserPayload(user) });
//   } catch (e) {
//     console.error("[POST /profile] error:", e);
//     return res.status(500).json({ ok: false, error: "Update failed" });
//   }
// });

// /* =========================
//    POST /forgot
//    ========================= */

// router.post("/forgot", async (req, res, next) => {
//   try {
//     const email = String(req.body?.email || "")
//       .trim()
//       .toLowerCase();
//     if (!/^\S+@\S+\.\S+$/.test(email)) {
//       return res.status(400).json({ ok: false, error: "Invalid email" });
//     }

//     const user = await AdminUser.findOne({ email }).exec();

//     if (user) {
//       const token = crypto.randomBytes(32).toString("hex");
//       user.resetToken = token;
//       user.resetTokenExp = new Date(Date.now() + 60 * 60 * 1000);
//       await user.save();

//       const base = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
//       const link = `${base}/admin/new-password?token=${encodeURIComponent(
//         token
//       )}&email=${encodeURIComponent(email)}`;

//       sendPasswordResetMail(email, link).catch((err) =>
//         console.error("[mailer] reset mail failed:", err?.message || err)
//       );
//     }

//     return res.json({
//       ok: true,
//       message: "If the email exists, a reset link has been sent.",
//     });
//   } catch (err) {
//     next(err);
//   }
// });

// /* =========================
//    POST /reset
//    ========================= */

// router.post("/reset", async (req, res, next) => {
//   try {
//     const token = String(req.body?.token || "").trim();
//     const password = String(req.body?.password || "");
//     if (!token)
//       return res.status(400).json({ ok: false, error: "Missing token" });
//     if (password.length < 6)
//       return res.status(400).json({ ok: false, error: "Password too short" });

//     const user = await AdminUser.findOne({
//       resetToken: token,
//       resetTokenExp: { $gt: new Date() },
//     }).exec();

//     if (!user) {
//       return res
//         .status(400)
//         .json({ ok: false, error: "Invalid or expired token" });
//     }

//     const salt = await bcrypt.genSalt(10);
//     user.passwordHash = await bcrypt.hash(password, salt);

//     user.resetToken = undefined;
//     user.resetTokenExp = undefined;

//     await user.save();
//     return res.json({ ok: true, message: "Password updated" });
//   } catch (err) {
//     next(err);
//   }
// });

// /* =========================
//    GET /me
//    ========================= */

// router.get("/me", adminAuth, async (req, res) => {
//   try {
//     const u = req.user || {};

//     let doc = null;
//     if (u._id || u.id) {
//       const id = String(u._id || u.id);
//       doc = await AdminUser.findById(id).lean();
//     }
//     if (!doc && u.email) {
//       doc = await AdminUser.findOne({
//         email: String(u.email).toLowerCase(),
//       }).lean();
//     }

//     const fullName = (doc && doc.fullName) || u.fullName || u.name || "";
//     const email = (doc && doc.email) || u.email || "";

//     return res.json({
//       ok: true,
//       user: {
//         id: String((doc && doc._id) || u._id || u.id || ""),
//         email,
//         fullName,
//         displayName: fullName || email || "Admin",
//         role: (doc && doc.role) || u.role || "provider",
//         avatarUrl: (doc && doc.avatarUrl) || null,
//       },
//     });
//   } catch (e) {
//     console.error("[adminUsers/me] failed:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// module.exports = router;
