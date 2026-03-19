// routes/adminCoaches.js
"use strict";

const express = require("express");
const router = express.Router();
const Coach = require("../models/Coach");
const AdminUser = require("../models/AdminUser");
const adminAuth = require("../middleware/adminAuth");

function isSuper(req) {
  return req.isSuperAdmin === true || String(req.role || "") === "super";
}

function providerId(req) {
  return String(req.providerId || "").trim();
}

function clean(v) {
  return String(v ?? "").trim();
}

function normSlug(body) {
  const raw = String(
    body.slug ||
      `${String(body.firstName || "").trim()} ${String(body.lastName || "")
        .trim()
        .trim()}`.trim() ||
      body.name ||
      "",
  )
    .toLowerCase()
    .trim();

  return raw.replace(/\s+/g, "-");
}

function normalizeStatus(v) {
  const s = clean(v).toLowerCase();
  if (s === "pending" || s === "approved" || s === "rejected") return s;
  return "";
}

function buildSort(sortKey) {
  const key = String(sortKey || "").trim();
  if (key === "oldest") return { createdAt: 1, _id: 1 };
  if (key === "name_asc") return { lastName: 1, firstName: 1, name: 1, _id: 1 };
  if (key === "name_desc")
    return { lastName: -1, firstName: -1, name: -1, _id: -1 };
  return { createdAt: -1, _id: -1 };
}

function baseFilters(req) {
  const query = String(req.query.search || req.query.q || "").trim();
  if (query.length < 2) return {};

  return {
    $or: [
      { name: { $regex: query, $options: "i" } },
      { firstName: { $regex: query, $options: "i" } },
      { lastName: { $regex: query, $options: "i" } },
      { position: { $regex: query, $options: "i" } },
    ],
  };
}

function viewQuery(view, pid, common, superUser) {
  const v = String(view || "").trim();

  if (!superUser) {
    if (v === "mine_pending")
      return { ...common, providerId: pid, status: "pending" };
    if (v === "mine_approved")
      return { ...common, providerId: pid, status: "approved" };
    if (v === "mine_rejected")
      return { ...common, providerId: pid, status: "rejected" };
    return { ...common, providerId: pid };
  }

  const base = pid
    ? { providerId: { $nin: ["", pid, null], $exists: true } }
    : { providerId: { $nin: ["", null], $exists: true } };

  if (v === "provider_pending")
    return { ...common, ...base, status: "pending" };
  if (v === "provider_approved")
    return { ...common, ...base, status: "approved" };
  if (v === "provider_rejected")
    return { ...common, ...base, status: "rejected" };

  return null;
}

async function enrichProviders(items) {
  const ids = Array.from(
    new Set(items.map((it) => String(it.providerId || "")).filter(Boolean)),
  );

  if (!ids.length) return items;

  const users = await AdminUser.find({ _id: { $in: ids } })
    .select("_id fullName email")
    .lean();

  const map = new Map(users.map((u) => [String(u._id), u]));

  return items.map((it) => {
    const pid = String(it.providerId || "");
    const u = pid ? map.get(pid) : null;

    return {
      ...it,
      provider: u
        ? {
            id: String(u._id),
            fullName: u.fullName || "",
            email: u.email || "",
          }
        : null,
      providerId: pid || null,
    };
  });
}

function ms(d) {
  const t = d ? new Date(d).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function pickEditableDraftKeys() {
  return [
    "firstName",
    "lastName",
    "name",
    "position",
    "degree",
    "since",
    "dfbLicense",
    "mfsLicense",
    "favClub",
    "favCoach",
    "favTrick",
    "photoUrl",
  ];
}

function pickDraftUpdates(raw) {
  const keys = pickEditableDraftKeys();
  const out = {};
  keys.forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = raw[k];
  });
  return out;
}

function effectiveCoach(doc) {
  const base = { ...(doc || {}) };
  const d =
    base && typeof base.draft === "object" && base.draft ? base.draft : {};
  return { ...base, ...d };
}

function applyEffectiveDraftForProvider(items, superUser) {
  if (superUser) return items;
  return items.map((it) => effectiveCoach(it));
}

function buildChangeSummary(prevDoc, rawUpdates) {
  const prev = effectiveCoach(prevDoc);
  const updates = pickDraftUpdates(rawUpdates);
  const s = (v) => String(v ?? "").trim();

  const nextFull =
    s(updates.name) ||
    [s(updates.firstName), s(updates.lastName)].filter(Boolean).join(" ");
  const prevFull =
    s(prev.name) ||
    [s(prev.firstName), s(prev.lastName)].filter(Boolean).join(" ");

  if ("name" in updates || "firstName" in updates || "lastName" in updates) {
    const nf = s(nextFull);
    if (nf && nf !== prevFull) return `Änderung Name: ${nf}`;
  }

  if ("position" in updates) {
    const p = s(updates.position);
    if (p && p !== s(prev.position)) return `Änderung Position: ${p}`;
  }

  if ("since" in updates) {
    const v = s(updates.since);
    if (v !== s(prev.since)) return `Änderung Seit: ${v || "—"}`;
  }

  if ("degree" in updates) {
    const v = s(updates.degree);
    if (v !== s(prev.degree)) return `Änderung Abschluss: ${v || "—"}`;
  }

  if ("photoUrl" in updates) {
    const v = s(updates.photoUrl);
    if (v !== s(prev.photoUrl)) return `Änderung Foto`;
  }

  return "";
}

function promoteDraftToLivePatch(current, patch, now) {
  const d =
    current && current.draft && typeof current.draft === "object"
      ? current.draft
      : {};
  const hasDraft =
    current && current.hasDraft === true && Object.keys(d).length > 0;

  if (!hasDraft) return patch;

  const live = { ...patch, ...d };
  live.hasDraft = false;
  live.draft = {};
  live.draftUpdatedAt = null;
  live.lastChangeSummary = "";
  live.lastChangeAt = now;

  return live;
}

function isProviderPublishedToggleOnly(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (typeof raw.published !== "boolean") return false;

  const keys = Object.keys(raw).filter((k) => k !== "submitForReview");
  return keys.length === 1 && keys[0] === "published";
}

router.get("/", adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      200,
      Math.max(1, parseInt(req.query.limit, 10) || 20),
    );

    const pid = providerId(req);
    const superUser = isSuper(req);

    if (!superUser && !pid) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const view = clean(req.query.view);
    const sort = buildSort(req.query.sort);
    const common = baseFilters(req);

    const q = viewQuery(view, pid, common, superUser);
    if (q) {
      const [items, total] = await Promise.all([
        Coach.find(q)
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Coach.countDocuments(q),
      ]);

      const out = items.length ? await enrichProviders(items) : items;
      const finalItems = applyEffectiveDraftForProvider(out, superUser);

      return res.json({
        ok: true,
        items: finalItems,
        total,
        page,
        pages: Math.max(1, Math.ceil(total / limit)),
        limit,
      });
    }

    const qMine = pid ? { ...common, providerId: pid } : { ...common };
    const qProv = pid
      ? { ...common, providerId: { $nin: ["", pid, null], $exists: true } }
      : { ...common, providerId: { $nin: ["", null], $exists: true } };

    const [mine, pending, rejected, approved] = await Promise.all([
      Promise.all([
        Coach.find(qMine)
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Coach.countDocuments(qMine),
      ]),
      Promise.all([
        Coach.find({ ...qProv, status: "pending" })
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Coach.countDocuments({ ...qProv, status: "pending" }),
      ]),
      Promise.all([
        Coach.find({ ...qProv, status: "rejected" })
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Coach.countDocuments({ ...qProv, status: "rejected" }),
      ]),
      Promise.all([
        Coach.find({ ...qProv, status: "approved" })
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Coach.countDocuments({ ...qProv, status: "approved" }),
      ]),
    ]);

    const mineDocs = Array.isArray(mine[0]) ? mine[0] : [];
    const pendingDocs = Array.isArray(pending[0]) ? pending[0] : [];
    const rejectedDocs = Array.isArray(rejected[0]) ? rejected[0] : [];
    const approvedDocs = Array.isArray(approved[0]) ? approved[0] : [];

    const all = [...mineDocs, ...pendingDocs, ...rejectedDocs, ...approvedDocs];
    const enrichedAll = all.length ? await enrichProviders(all) : all;

    let i = 0;
    const mineItems = enrichedAll.slice(i, i + mineDocs.length);
    i += mineDocs.length;

    const pendingItems = enrichedAll.slice(i, i + pendingDocs.length);
    i += pendingDocs.length;

    const rejectedItems = enrichedAll.slice(i, i + rejectedDocs.length);
    i += rejectedDocs.length;

    const approvedItems = enrichedAll.slice(i, i + approvedDocs.length);

    const finalMine = applyEffectiveDraftForProvider(mineItems, superUser);

    return res.json({
      ok: true,
      combined: true,
      mine: {
        items: finalMine,
        total: mine[1],
        page,
        pages: Math.max(1, Math.ceil(mine[1] / limit)),
        limit,
      },
      providerPending: {
        items: pendingItems,
        total: pending[1],
        page,
        pages: Math.max(1, Math.ceil(pending[1] / limit)),
        limit,
      },
      providerRejected: {
        items: rejectedItems,
        total: rejected[1],
        page,
        pages: Math.max(1, Math.ceil(rejected[1] / limit)),
        limit,
      },
      providerApproved: {
        items: approvedItems,
        total: approved[1],
        page,
        pages: Math.max(1, Math.ceil(approved[1] / limit)),
        limit,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/", adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const slug = normSlug(body);
    if (!slug) {
      return res.status(400).json({ ok: false, error: "Missing slug/name" });
    }

    const pid = providerId(req);
    const now = new Date();
    const payload = { ...body, slug };

    if (isSuper(req)) {
      if (!payload.providerId && pid) payload.providerId = pid;

      const s = normalizeStatus(body.status);
      payload.status = s || "approved";

      if (payload.status === "rejected") {
        payload.rejectionReason = clean(body.rejectionReason);
        payload.rejectedAt = now;
      } else {
        payload.rejectionReason = "";
        payload.rejectedAt = null;
      }

      // payload.published =
      //   typeof body.published === "boolean" ? !!body.published : true;

      // if (payload.published === true) {
      //   if (!payload.approvedAt) payload.approvedAt = now;
      //   payload.liveUpdatedAt = now;
      // }

      const desiredPublished =
        typeof body.published === "boolean" ? !!body.published : true;

      payload.published =
        payload.status === "rejected" ? false : desiredPublished;

      if (payload.published === true) {
        if (!payload.approvedAt) payload.approvedAt = now;
        payload.liveUpdatedAt = now;
      }

      payload.lastSuperEditAt = now;
      payload.draftUpdatedAt = now;
      payload.lastChangeAt = now;
      payload.lastChangeSummary = "";
    } else {
      if (!pid)
        return res.status(401).json({ ok: false, error: "Unauthorized" });

      payload.providerId = pid;
      payload.status = "pending";
      payload.rejectionReason = "";
      payload.submittedAt = now;

      payload.published = true;

      payload.draftUpdatedAt = now;
      payload.lastProviderEditAt = now;
      payload.lastChangeAt = now;
      payload.lastChangeSummary = "";
    }

    const created = await Coach.create(payload);
    return res.status(201).json({ ok: true, item: created });
  } catch (e) {
    if (e?.code === 11000) {
      return res
        .status(409)
        .json({ ok: false, error: "Slug bereits vergeben" });
    }
    return res.status(400).json({ ok: false, error: e.message });
  }
});

router.patch("/:slug", adminAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "")
      .toLowerCase()
      .trim();
    const raw = req.body || {};
    const submitForReview = raw?.submitForReview === true;

    const updates = { ...raw };
    if ("slug" in updates) delete updates.slug;
    if ("submitForReview" in updates) delete updates.submitForReview;

    const now = new Date();

    if (!isSuper(req)) {
      const pid = providerId(req);
      if (!pid)
        return res.status(401).json({ ok: false, error: "Unauthorized" });

      const current = await Coach.findOne({ slug, providerId: pid }).lean();
      if (!current)
        return res.status(404).json({ ok: false, error: "Not found" });

      if (isProviderPublishedToggleOnly(raw)) {
        const isApproved = String(current.status || "") === "approved";
        if (!isApproved) {
          return res
            .status(403)
            .json({ ok: false, error: "Online/Offline nicht erlaubt." });
        }

        const next = await Coach.findOneAndUpdate(
          { slug, providerId: pid },
          {
            published: !!raw.published,
            lastProviderEditAt: now,
            lastChangeAt: now,
          },
          { new: true, runValidators: true },
        ).lean();

        const out = next ? (await enrichProviders([next]))[0] : next;
        const finalItem = out ? effectiveCoach(out) : out;
        return res.json({ ok: true, item: finalItem });
      }

      const wantsResubmitLegacy =
        Object.prototype.hasOwnProperty.call(updates, "rejectionReason") &&
        clean(updates.rejectionReason) === "";

      const wantsResubmit = submitForReview || wantsResubmitLegacy;

      if ("status" in updates) delete updates.status;
      if ("rejectionReason" in updates) delete updates.rejectionReason;
      if ("published" in updates) delete updates.published;

      if (wantsResubmit) {
        const wasRejected =
          String(current.status || "") === "rejected" &&
          clean(current.rejectionReason) !== "";

        const wasApproved =
          String(current.status || "") === "approved" ||
          current.published === true;

        const draftAt = ms(current.draftUpdatedAt) || ms(current.updatedAt);
        const liveAt = ms(current.liveUpdatedAt);
        const rejectedAt = ms(current.rejectedAt);

        const changedAfterLive = wasApproved && draftAt > liveAt;
        const changedAfterReject = wasRejected && draftAt > rejectedAt;

        if (!changedAfterLive && !changedAfterReject) {
          return res
            .status(403)
            .json({ ok: false, error: "Einreichen nicht erlaubt." });
        }

        const next = await Coach.findOneAndUpdate(
          { slug, providerId: pid },
          {
            status: "pending",
            rejectionReason: "",
            submittedAt: now,
            lastProviderEditAt: now,
          },
          { new: true, runValidators: true },
        ).lean();

        const out = next ? (await enrichProviders([next]))[0] : next;
        const finalItem = out ? effectiveCoach(out) : out;
        return res.json({ ok: true, item: finalItem });
      }

      const summary = buildChangeSummary(current, updates);
      const draftUpdates = pickDraftUpdates(updates);

      const patch = {};
      patch.draft = { ...(current.draft || {}), ...draftUpdates };
      patch.hasDraft = Object.keys(patch.draft).length > 0;
      patch.draftUpdatedAt = now;
      patch.lastProviderEditAt = now;
      patch.lastChangeAt = now;
      if (summary) patch.lastChangeSummary = summary;

      const updated = await Coach.findOneAndUpdate(
        { slug, providerId: pid },
        patch,
        {
          new: true,
          runValidators: true,
        },
      ).lean();

      if (!updated)
        return res.status(404).json({ ok: false, error: "Not found" });

      const out = (await enrichProviders([updated]))[0];
      const finalItem = out ? effectiveCoach(out) : out;
      return res.json({ ok: true, item: finalItem });
    }

    const current = await Coach.findOne({ slug }).lean();
    if (!current)
      return res.status(404).json({ ok: false, error: "Not found" });

    const next = { ...updates };

    if ("status" in next) {
      const s = normalizeStatus(next.status);
      if (s) {
        next.status = s;
        if (s !== "rejected") next.rejectionReason = "";
      } else {
        delete next.status;
      }
    }

    if ("rejectionReason" in next)
      next.rejectionReason = clean(next.rejectionReason);

    const willReject =
      ("rejectionReason" in next && clean(next.rejectionReason)) ||
      String(next.status || "") === "rejected";

    // if (willReject) {
    //   next.status = "rejected";
    //   next.rejectedAt = now;
    // }

    if (willReject) {
      next.status = "rejected";
      next.rejectedAt = now;
      next.published = false;
    }

    const willApprove =
      next.published === true ||
      String(next.status || "") === "approved" ||
      ("published" in next && next.published === true);

    let patch = { ...next };

    if (willApprove) {
      patch = promoteDraftToLivePatch(current, patch, now);
      patch.status = "approved";
      patch.rejectionReason = "";
      patch.rejectedAt = null;
      patch.submittedAt = null;
      if (!current.approvedAt) patch.approvedAt = now;
      patch.liveUpdatedAt = now;
      patch.published = true;
    }

    patch.lastSuperEditAt = now;

    const updated = await Coach.findOneAndUpdate({ slug }, patch, {
      new: true,
      runValidators: true,
    }).lean();

    if (!updated)
      return res.status(404).json({ ok: false, error: "Not found" });

    const out = (await enrichProviders([updated]))[0];
    return res.json({ ok: true, item: out });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

router.delete("/:slug", adminAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "")
      .toLowerCase()
      .trim();
    const filter = { slug };

    if (!isSuper(req)) {
      const pid = providerId(req);
      if (!pid)
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      filter.providerId = pid;
    }

    const del = await Coach.findOneAndDelete(filter).lean();
    if (!del) return res.status(404).json({ ok: false, error: "Not found" });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;

// // routes/adminCoaches.js
// "use strict";

// const express = require("express");
// const router = express.Router();
// const Coach = require("../models/Coach");
// const AdminUser = require("../models/AdminUser");
// const adminAuth = require("../middleware/adminAuth");

// function isSuper(req) {
//   return req.isSuperAdmin === true || String(req.role || "") === "super";
// }

// function providerId(req) {
//   return String(req.providerId || "").trim();
// }

// function clean(v) {
//   return String(v ?? "").trim();
// }

// function normSlug(body) {
//   const raw = String(
//     body.slug ||
//       `${String(body.firstName || "").trim()} ${String(body.lastName || "")
//         .trim()
//         .trim()}`.trim() ||
//       body.name ||
//       "",
//   )
//     .toLowerCase()
//     .trim();

//   return raw.replace(/\s+/g, "-");
// }

// function normalizeStatus(v) {
//   const s = clean(v).toLowerCase();
//   if (s === "pending" || s === "approved" || s === "rejected") return s;
//   return "";
// }

// function buildSort(sortKey) {
//   const key = String(sortKey || "").trim();
//   if (key === "oldest") return { createdAt: 1, _id: 1 };
//   if (key === "name_asc") return { lastName: 1, firstName: 1, name: 1, _id: 1 };
//   if (key === "name_desc")
//     return { lastName: -1, firstName: -1, name: -1, _id: -1 };
//   return { createdAt: -1, _id: -1 };
// }

// function baseFilters(req) {
//   const query = String(req.query.search || req.query.q || "").trim();
//   if (query.length < 2) return {};

//   return {
//     $or: [
//       { name: { $regex: query, $options: "i" } },
//       { firstName: { $regex: query, $options: "i" } },
//       { lastName: { $regex: query, $options: "i" } },
//       { position: { $regex: query, $options: "i" } },
//     ],
//   };
// }

// function viewQuery(view, pid, common, superUser) {
//   const v = String(view || "").trim();

//   if (!superUser) {
//     if (v === "mine_pending")
//       return { ...common, providerId: pid, status: "pending" };
//     if (v === "mine_approved")
//       return { ...common, providerId: pid, status: "approved" };
//     if (v === "mine_rejected")
//       return { ...common, providerId: pid, status: "rejected" };
//     return { ...common, providerId: pid };
//   }

//   const base = pid
//     ? { providerId: { $nin: ["", pid, null], $exists: true } }
//     : { providerId: { $nin: ["", null], $exists: true } };

//   if (v === "provider_pending")
//     return { ...common, ...base, status: "pending" };
//   if (v === "provider_approved")
//     return { ...common, ...base, status: "approved" };
//   if (v === "provider_rejected")
//     return { ...common, ...base, status: "rejected" };

//   return null;
// }

// async function enrichProviders(items) {
//   const ids = Array.from(
//     new Set(items.map((it) => String(it.providerId || "")).filter(Boolean)),
//   );

//   if (!ids.length) return items;

//   const users = await AdminUser.find({ _id: { $in: ids } })
//     .select("_id fullName email")
//     .lean();

//   const map = new Map(users.map((u) => [String(u._id), u]));

//   return items.map((it) => {
//     const pid = String(it.providerId || "");
//     const u = pid ? map.get(pid) : null;

//     return {
//       ...it,
//       provider: u
//         ? {
//             id: String(u._id),
//             fullName: u.fullName || "",
//             email: u.email || "",
//           }
//         : null,
//       providerId: pid || null,
//     };
//   });
// }

// function ms(d) {
//   const t = d ? new Date(d).getTime() : 0;
//   return Number.isFinite(t) ? t : 0;
// }

// function pickEditableDraftKeys() {
//   return [
//     "firstName",
//     "lastName",
//     "name",
//     "position",
//     "degree",
//     "since",
//     "dfbLicense",
//     "mfsLicense",
//     "favClub",
//     "favCoach",
//     "favTrick",
//     "photoUrl",
//   ];
// }

// function pickDraftUpdates(raw) {
//   const keys = pickEditableDraftKeys();
//   const out = {};
//   keys.forEach((k) => {
//     if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = raw[k];
//   });
//   return out;
// }

// function effectiveCoach(doc) {
//   const base = { ...(doc || {}) };
//   const d =
//     base && typeof base.draft === "object" && base.draft ? base.draft : {};
//   return { ...base, ...d };
// }

// function applyEffectiveDraftForProvider(items, superUser) {
//   if (superUser) return items;
//   return items.map((it) => effectiveCoach(it));
// }

// function buildChangeSummary(prevDoc, rawUpdates) {
//   const prev = effectiveCoach(prevDoc);
//   const updates = pickDraftUpdates(rawUpdates);
//   const s = (v) => String(v ?? "").trim();

//   const nextFull =
//     s(updates.name) ||
//     [s(updates.firstName), s(updates.lastName)].filter(Boolean).join(" ");
//   const prevFull =
//     s(prev.name) ||
//     [s(prev.firstName), s(prev.lastName)].filter(Boolean).join(" ");

//   if ("name" in updates || "firstName" in updates || "lastName" in updates) {
//     const nf = s(nextFull);
//     if (nf && nf !== prevFull) return `Änderung Name: ${nf}`;
//   }

//   if ("position" in updates) {
//     const p = s(updates.position);
//     if (p && p !== s(prev.position)) return `Änderung Position: ${p}`;
//   }

//   if ("since" in updates) {
//     const v = s(updates.since);
//     if (v !== s(prev.since)) return `Änderung Seit: ${v || "—"}`;
//   }

//   if ("degree" in updates) {
//     const v = s(updates.degree);
//     if (v !== s(prev.degree)) return `Änderung Abschluss: ${v || "—"}`;
//   }

//   if ("photoUrl" in updates) {
//     const v = s(updates.photoUrl);
//     if (v !== s(prev.photoUrl)) return `Änderung Foto`;
//   }

//   return "";
// }

// function promoteDraftToLivePatch(current, patch, now) {
//   const d =
//     current && current.draft && typeof current.draft === "object"
//       ? current.draft
//       : {};
//   const hasDraft =
//     current && current.hasDraft === true && Object.keys(d).length > 0;

//   if (!hasDraft) return patch;

//   const live = { ...patch, ...d };
//   live.hasDraft = false;
//   live.draft = {};
//   live.draftUpdatedAt = null;
//   live.lastChangeSummary = "";
//   live.lastChangeAt = now;

//   return live;
// }

// function isProviderPublishedToggleOnly(raw) {
//   if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
//   if (typeof raw.published !== "boolean") return false;

//   const keys = Object.keys(raw).filter((k) => k !== "submitForReview");
//   return keys.length === 1 && keys[0] === "published";
// }

// router.get("/", adminAuth, async (req, res) => {
//   try {
//     const page = Math.max(1, parseInt(req.query.page, 10) || 1);
//     const limit = Math.min(
//       200,
//       Math.max(1, parseInt(req.query.limit, 10) || 20),
//     );

//     const pid = providerId(req);
//     const superUser = isSuper(req);

//     if (!superUser && !pid) {
//       return res.status(401).json({ ok: false, error: "Unauthorized" });
//     }

//     const view = clean(req.query.view);
//     const sort = buildSort(req.query.sort);
//     const common = baseFilters(req);

//     const q = viewQuery(view, pid, common, superUser);
//     if (q) {
//       const [items, total] = await Promise.all([
//         Coach.find(q)
//           .sort(sort)
//           .skip((page - 1) * limit)
//           .limit(limit)
//           .lean(),
//         Coach.countDocuments(q),
//       ]);

//       const out = items.length ? await enrichProviders(items) : items;
//       const finalItems = applyEffectiveDraftForProvider(out, superUser);

//       return res.json({
//         ok: true,
//         items: finalItems,
//         total,
//         page,
//         pages: Math.max(1, Math.ceil(total / limit)),
//         limit,
//       });
//     }

//     const qMine = pid ? { ...common, providerId: pid } : { ...common };
//     const qProv = pid
//       ? { ...common, providerId: { $nin: ["", pid, null], $exists: true } }
//       : { ...common, providerId: { $nin: ["", null], $exists: true } };

//     const [mine, pending, rejected, approved] = await Promise.all([
//       Promise.all([
//         Coach.find(qMine)
//           .sort(sort)
//           .skip((page - 1) * limit)
//           .limit(limit)
//           .lean(),
//         Coach.countDocuments(qMine),
//       ]),
//       Promise.all([
//         Coach.find({ ...qProv, status: "pending" })
//           .sort(sort)
//           .skip((page - 1) * limit)
//           .limit(limit)
//           .lean(),
//         Coach.countDocuments({ ...qProv, status: "pending" }),
//       ]),
//       Promise.all([
//         Coach.find({ ...qProv, status: "rejected" })
//           .sort(sort)
//           .skip((page - 1) * limit)
//           .limit(limit)
//           .lean(),
//         Coach.countDocuments({ ...qProv, status: "rejected" }),
//       ]),
//       Promise.all([
//         Coach.find({ ...qProv, status: "approved" })
//           .sort(sort)
//           .skip((page - 1) * limit)
//           .limit(limit)
//           .lean(),
//         Coach.countDocuments({ ...qProv, status: "approved" }),
//       ]),
//     ]);

//     const mineItems = mine[0].length ? await enrichProviders(mine[0]) : mine[0];
//     const pendingItems = pending[0].length
//       ? await enrichProviders(pending[0])
//       : pending[0];
//     const rejectedItems = rejected[0].length
//       ? await enrichProviders(rejected[0])
//       : rejected[0];
//     const approvedItems = approved[0].length
//       ? await enrichProviders(approved[0])
//       : approved[0];

//     const finalMine = applyEffectiveDraftForProvider(mineItems, superUser);

//     return res.json({
//       ok: true,
//       combined: true,
//       mine: {
//         items: finalMine,
//         total: mine[1],
//         page,
//         pages: Math.max(1, Math.ceil(mine[1] / limit)),
//         limit,
//       },
//       providerPending: {
//         items: pendingItems,
//         total: pending[1],
//         page,
//         pages: Math.max(1, Math.ceil(pending[1] / limit)),
//         limit,
//       },
//       providerRejected: {
//         items: rejectedItems,
//         total: rejected[1],
//         page,
//         pages: Math.max(1, Math.ceil(rejected[1] / limit)),
//         limit,
//       },
//       providerApproved: {
//         items: approvedItems,
//         total: approved[1],
//         page,
//         pages: Math.max(1, Math.ceil(approved[1] / limit)),
//         limit,
//       },
//     });
//   } catch (e) {
//     return res.status(500).json({ ok: false, error: e.message });
//   }
// });

// router.post("/", adminAuth, async (req, res) => {
//   try {
//     const body = req.body || {};
//     const slug = normSlug(body);
//     if (!slug) {
//       return res.status(400).json({ ok: false, error: "Missing slug/name" });
//     }

//     const pid = providerId(req);
//     const now = new Date();
//     const payload = { ...body, slug };

//     if (isSuper(req)) {
//       if (!payload.providerId && pid) payload.providerId = pid;

//       const s = normalizeStatus(body.status);
//       payload.status = s || "approved";

//       if (payload.status === "rejected") {
//         payload.rejectionReason = clean(body.rejectionReason);
//         payload.rejectedAt = now;
//       } else {
//         payload.rejectionReason = "";
//         payload.rejectedAt = null;
//       }

//       payload.published =
//         typeof body.published === "boolean" ? !!body.published : true;

//       if (payload.published === true) {
//         if (!payload.approvedAt) payload.approvedAt = now;
//         payload.liveUpdatedAt = now;
//       }

//       payload.lastSuperEditAt = now;
//       payload.draftUpdatedAt = now;
//       payload.lastChangeAt = now;
//       payload.lastChangeSummary = "";
//     } else {
//       if (!pid)
//         return res.status(401).json({ ok: false, error: "Unauthorized" });

//       payload.providerId = pid;
//       payload.status = "pending";
//       payload.rejectionReason = "";
//       payload.submittedAt = now;

//       payload.published = true;

//       payload.draftUpdatedAt = now;
//       payload.lastProviderEditAt = now;
//       payload.lastChangeAt = now;
//       payload.lastChangeSummary = "";
//     }

//     const created = await Coach.create(payload);
//     return res.status(201).json({ ok: true, item: created });
//   } catch (e) {
//     if (e?.code === 11000) {
//       return res
//         .status(409)
//         .json({ ok: false, error: "Slug bereits vergeben" });
//     }
//     return res.status(400).json({ ok: false, error: e.message });
//   }
// });

// router.patch("/:slug", adminAuth, async (req, res) => {
//   try {
//     const slug = String(req.params.slug || "")
//       .toLowerCase()
//       .trim();
//     const raw = req.body || {};
//     const submitForReview = raw?.submitForReview === true;

//     const updates = { ...raw };
//     if ("slug" in updates) delete updates.slug;
//     if ("submitForReview" in updates) delete updates.submitForReview;

//     const now = new Date();

//     if (!isSuper(req)) {
//       const pid = providerId(req);
//       if (!pid)
//         return res.status(401).json({ ok: false, error: "Unauthorized" });

//       const current = await Coach.findOne({ slug, providerId: pid }).lean();
//       if (!current)
//         return res.status(404).json({ ok: false, error: "Not found" });

//       if (isProviderPublishedToggleOnly(raw)) {
//         const isApproved = String(current.status || "") === "approved";
//         if (!isApproved) {
//           return res
//             .status(403)
//             .json({ ok: false, error: "Online/Offline nicht erlaubt." });
//         }

//         const next = await Coach.findOneAndUpdate(
//           { slug, providerId: pid },
//           {
//             published: !!raw.published,
//             lastProviderEditAt: now,
//             lastChangeAt: now,
//           },
//           { new: true, runValidators: true },
//         ).lean();

//         const out = next ? (await enrichProviders([next]))[0] : next;
//         const finalItem = out ? effectiveCoach(out) : out;
//         return res.json({ ok: true, item: finalItem });
//       }

//       const wantsResubmitLegacy =
//         Object.prototype.hasOwnProperty.call(updates, "rejectionReason") &&
//         clean(updates.rejectionReason) === "";

//       const wantsResubmit = submitForReview || wantsResubmitLegacy;

//       if ("status" in updates) delete updates.status;
//       if ("rejectionReason" in updates) delete updates.rejectionReason;
//       if ("published" in updates) delete updates.published;

//       if (wantsResubmit) {
//         const wasRejected =
//           String(current.status || "") === "rejected" &&
//           clean(current.rejectionReason) !== "";

//         const wasApproved =
//           String(current.status || "") === "approved" ||
//           current.published === true;

//         const draftAt = ms(current.draftUpdatedAt) || ms(current.updatedAt);
//         const liveAt = ms(current.liveUpdatedAt);
//         const rejectedAt = ms(current.rejectedAt);

//         const changedAfterLive = wasApproved && draftAt > liveAt;
//         const changedAfterReject = wasRejected && draftAt > rejectedAt;

//         if (!changedAfterLive && !changedAfterReject) {
//           return res
//             .status(403)
//             .json({ ok: false, error: "Einreichen nicht erlaubt." });
//         }

//         const next = await Coach.findOneAndUpdate(
//           { slug, providerId: pid },
//           {
//             status: "pending",
//             rejectionReason: "",
//             submittedAt: now,
//             lastProviderEditAt: now,
//           },
//           { new: true, runValidators: true },
//         ).lean();

//         const out = next ? (await enrichProviders([next]))[0] : next;
//         const finalItem = out ? effectiveCoach(out) : out;
//         return res.json({ ok: true, item: finalItem });
//       }

//       const summary = buildChangeSummary(current, updates);
//       const draftUpdates = pickDraftUpdates(updates);

//       const patch = {};
//       patch.draft = { ...(current.draft || {}), ...draftUpdates };
//       patch.hasDraft = Object.keys(patch.draft).length > 0;
//       patch.draftUpdatedAt = now;
//       patch.lastProviderEditAt = now;
//       patch.lastChangeAt = now;
//       if (summary) patch.lastChangeSummary = summary;

//       const updated = await Coach.findOneAndUpdate(
//         { slug, providerId: pid },
//         patch,
//         {
//           new: true,
//           runValidators: true,
//         },
//       ).lean();

//       if (!updated)
//         return res.status(404).json({ ok: false, error: "Not found" });

//       const out = (await enrichProviders([updated]))[0];
//       const finalItem = out ? effectiveCoach(out) : out;
//       return res.json({ ok: true, item: finalItem });
//     }

//     const current = await Coach.findOne({ slug }).lean();
//     if (!current)
//       return res.status(404).json({ ok: false, error: "Not found" });

//     const next = { ...updates };

//     if ("status" in next) {
//       const s = normalizeStatus(next.status);
//       if (s) {
//         next.status = s;
//         if (s !== "rejected") next.rejectionReason = "";
//       } else {
//         delete next.status;
//       }
//     }

//     if ("rejectionReason" in next)
//       next.rejectionReason = clean(next.rejectionReason);

//     const willReject =
//       ("rejectionReason" in next && clean(next.rejectionReason)) ||
//       String(next.status || "") === "rejected";

//     if (willReject) {
//       next.status = "rejected";
//       next.rejectedAt = now;
//     }

//     const willApprove =
//       next.published === true ||
//       String(next.status || "") === "approved" ||
//       ("published" in next && next.published === true);

//     let patch = { ...next };

//     if (willApprove) {
//       patch = promoteDraftToLivePatch(current, patch, now);
//       patch.status = "approved";
//       patch.rejectionReason = "";
//       patch.rejectedAt = null;
//       patch.submittedAt = null;
//       if (!current.approvedAt) patch.approvedAt = now;
//       patch.liveUpdatedAt = now;
//       patch.published = true;
//     }

//     patch.lastSuperEditAt = now;

//     const updated = await Coach.findOneAndUpdate({ slug }, patch, {
//       new: true,
//       runValidators: true,
//     }).lean();

//     if (!updated)
//       return res.status(404).json({ ok: false, error: "Not found" });

//     const out = (await enrichProviders([updated]))[0];
//     return res.json({ ok: true, item: out });
//   } catch (e) {
//     return res.status(400).json({ ok: false, error: e.message });
//   }
// });

// router.delete("/:slug", adminAuth, async (req, res) => {
//   try {
//     const slug = String(req.params.slug || "")
//       .toLowerCase()
//       .trim();
//     const filter = { slug };

//     if (!isSuper(req)) {
//       const pid = providerId(req);
//       if (!pid)
//         return res.status(401).json({ ok: false, error: "Unauthorized" });
//       filter.providerId = pid;
//     }

//     const del = await Coach.findOneAndDelete(filter).lean();
//     if (!del) return res.status(404).json({ ok: false, error: "Not found" });

//     return res.json({ ok: true });
//   } catch (e) {
//     return res.status(400).json({ ok: false, error: e.message });
//   }
// });

// module.exports = router;
