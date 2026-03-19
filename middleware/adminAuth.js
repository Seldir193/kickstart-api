// // middleware/adminAuth.js
// // Akzeptiert:
// // 1) Basic (ENV-Admin)           -> req.isSuperAdmin = true
// // 2) X-Provider-Id              -> req.providerId = <id>
// //    optional: x-admin-role=super -> req.isSuperAdmin = true
// middleware/adminAuth.js
// middleware/adminAuth.js
"use strict";

const AdminUser = require("../models/AdminUser");

function clean(v) {
  return String(v || "").trim();
}

function sanitizeEnv(v) {
  return clean(v)
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1");
}

module.exports = async function adminAuth(req, res, next) {
  const debugAuth = process.env.DEBUG_AUTH === "1";

  try {
    const auth = clean(req.headers.authorization);

    if (auth.startsWith("Basic ")) {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      const email = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);

      const envEmail = sanitizeEnv(process.env.ADMIN_EMAIL);
      const envPass = sanitizeEnv(process.env.ADMIN_PASSWORD);

      if (email === envEmail && pass === envPass && envEmail && envPass) {
        req.isSuperAdmin = true;
        req.role = "super";
        req.isOwner = true;

        if (debugAuth) {
          console.log("[adminAuth] basic=ok role=super owner=true");
        }

        return next();
      }
    }

    const pid = clean(req.get("x-provider-id"));
    if (!pid) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    req.providerId = pid;

    const user = await AdminUser.findById(pid)
      // .select("_id role isOwner")
      .select("_id role isOwner isActive")

      .lean()
      .catch(() => null);

    if (!user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (user.isActive === false) {
      return res.status(403).json({ ok: false, error: "Account disabled" });
    }

    const role = clean(user.role) === "super" ? "super" : "provider";

    req.role = role;
    req.isSuperAdmin = role === "super";
    req.isOwner = Boolean(user.isOwner === true);

    if (debugAuth) {
      console.log("[adminAuth] x-provider-id =", pid);
      console.log("[adminAuth] db.role =", req.role);
      console.log("[adminAuth] db.isOwner =", req.isOwner);
    }

    return next();
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Auth middleware crashed",
      detail: String(e?.message || e),
    });
  }
};

// module.exports = function adminAuth(req, res, next) {
//   const debugAuth = process.env.DEBUG_AUTH === "1";
//   if (debugAuth) {
//     console.log(
//       "[adminAuth] x-provider-id =",
//       req.get("x-provider-id") || "(none)",
//     );
//     console.log(
//       "[adminAuth] x-admin-role =",
//       req.get("x-admin-role") || "(none)",
//     );
//   }

//   try {
//     const auth = String(req.headers.authorization || "");

//     // --- 1) Basic (ENV Admin) wie bisher ---
//     if (auth.startsWith("Basic ")) {
//       const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
//       const sep = decoded.indexOf(":");
//       const email = decoded.slice(0, sep);
//       const pass = decoded.slice(sep + 1);

//       const sanitize = (s) =>
//         (s || "")
//           .trim()
//           .replace(/^"(.*)"$/, "$1")
//           .replace(/^'(.*)'$/, "$1");

//       const envEmail = sanitize(process.env.ADMIN_EMAIL);
//       const envPass = sanitize(process.env.ADMIN_PASSWORD);

//       if (email === envEmail && pass === envPass && envEmail && envPass) {
//         req.isSuperAdmin = true;
//         req.role = "super";
//         return next();
//       }
//     }

//     // --- 2) Provider-ID aus Header (von Next-Proxys gesetzt) ---
//     const pid = String(req.get("x-provider-id") || "").trim();
//     if (pid) {
//       req.providerId = pid;

//       const roleHdr = String(req.get("x-admin-role") || "").trim();
//       if (roleHdr === "super") {
//         req.isSuperAdmin = true;
//         req.role = "super";
//       } else {
//         req.role = "provider";
//       }

//       return next();
//     }

//     return res.status(401).json({ ok: false, error: "Unauthorized" });
//   } catch (e) {
//     return res.status(500).json({
//       ok: false,
//       error: "Auth middleware crashed",
//       detail: String(e?.message || e),
//     });
//   }
// };
