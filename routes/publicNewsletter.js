// routes/publicNewsletter.js
const express = require("express");
const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");
const nodemailer = require("nodemailer");

const router = express.Router();

/* ===== ENV ===== */
const SECRET = process.env.NEWSLETTER_SECRET || "";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";
const SITE_ORIGIN = (
  process.env.NEWSLETTER_SITE_ORIGIN || "http://localhost"
).replace(/\/$/, "");
const PUBLIC_API_BASE = (
  process.env.PUBLIC_API_BASE || "http://127.0.0.1:5000"
).replace(/\/$/, "");
const DEFAULT_OWNER_ID = process.env.DEFAULT_OWNER_ID || "";

// SMTP
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE =
  String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL =
  process.env.FROM_EMAIL || "KickStart Academy <no-reply@example.com>";
const MAIL_BCC = process.env.MAIL_BCC || "";

/* ===== DB-Name robust bestimmen ===== */
function resolveDbName() {
  if (process.env.MONGO_DB) return process.env.MONGO_DB;
  try {
    const u = new URL(MONGO_URI);
    const p = (u.pathname || "").replace(/^\//, "");
    return p.split("/")[0] || "test";
  } catch {
    return "test";
  }
}
const DB_NAME = resolveDbName();

/* ===== Owner ===== */
function getOwnerIdOrNull() {
  try {
    return DEFAULT_OWNER_ID ? new ObjectId(DEFAULT_OWNER_ID) : null;
  } catch {
    return null;
  }
}
const OWNER_ID = getOwnerIdOrNull();

/* ===== Helpers ===== */
function hmac(emailLower) {
  return crypto.createHmac("sha256", SECRET).update(emailLower).digest("hex");
}
function isValidToken(emailLower, token) {
  try {
    const expected = hmac(emailLower);
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(String(token))
    );
  } catch {
    return false;
  }
}
async function withDb(fn) {
  const client = await MongoClient.connect(MONGO_URI, {
    ignoreUndefined: true,
    serverSelectionTimeoutMS: 8000,
  });
  try {
    return await fn(client.db(DB_NAME));
  } finally {
    try {
      await client.close();
    } catch {}
  }
}
function redirect(res, key) {
  return res.redirect(
    302,
    `${SITE_ORIGIN}?newsletter=${encodeURIComponent(key)}`
  );
}
function confirmUrl(emailLower) {
  return `${PUBLIC_API_BASE}/api/public/newsletter/confirm?e=${encodeURIComponent(
    emailLower
  )}&t=${hmac(emailLower)}`;
}
function unsubscribeUrl(emailLower) {
  return `${PUBLIC_API_BASE}/api/public/newsletter/unsubscribe?e=${encodeURIComponent(
    emailLower
  )}&t=${hmac(emailLower)}`;
}

/* ===== Mailer ===== */
let _tx = null;
function mailer() {
  if (_tx) return _tx;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      "SMTP_* ENV unvollständig (SMTP_HOST, SMTP_USER, SMTP_PASS)."
    );
  }
  _tx = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return _tx;
}

function confirmEmailHtml(emailLower, urlConfirm, urlUnsub) {
  return `<!doctype html><html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bitte bestätige deine Anmeldung</title></head>
<body style="margin:0;padding:0;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#111827">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr><td align="center" style="padding:16px">
      <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
        <tr><td style="background:#111;color:#fff;padding:12px 20px;font-weight:700">KickStart Academy</td></tr>
        <tr><td style="padding:18px 20px">
          <h1 style="margin:0 0 8px;font-size:20px">Nur noch ein Klick …</h1>
          <p style="margin:0 0 12px;font-size:14px;line-height:22px">
            Bitte bestätige deine Newsletter-Anmeldung für <strong>${emailLower}</strong>.
          </p>
          <p style="margin:16px 0 20px;text-align:center">
            <a href="${urlConfirm}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:700">
              Anmeldung bestätigen
            </a>
          </p>
          <p style="margin:0;font-size:12px;line-height:18px;color:#6b7280;text-align:center">
            Abmelden: <a href="${urlUnsub}" style="color:#0f172a;text-decoration:none">hier klicken</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function customerEmailQuery(emailLower) {
  // Wichtig: KEIN ownerFilter in der Query erzwingen.
  // Stattdessen owner später setzen, damit Leads, die ohne owner entstanden sind, "gerettet" werden.
  return { $or: [{ emailLower }, { email: emailLower }] };
}

/* =========================================================
 * POST /api/public/newsletter  (Signup)
 * - setzt immer owner (wenn DEFAULT_OWNER_ID vorhanden)
 * - newsletter bleibt false bis confirm
 * =======================================================*/
router.post("/newsletter", express.json(), async (req, res) => {
  try {
    if (!SECRET || !MONGO_URI)
      return res.status(500).json({ ok: false, error: "Server misconfigured" });

    const { email = "", website = "" } = req.body || {};
    const emailLower = String(email).toLowerCase().trim();

    if (!emailLower || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
      return res.status(400).json({ ok: false, error: "Ungültige E-Mail" });
    }
    if (website) return res.status(200).json({ ok: true, message: "Danke!" }); // Honeypot

    const now = new Date();
    const token = hmac(emailLower); // legacy fallback

    await withDb(async (db) => {
      const $set = {
        emailLower,
        email: emailLower,
        marketingStatus: "pending",
        newsletter: false,
        confirmToken: token,
        updatedAt: now,
      };

      // owner IMMER setzen, wenn verfügbar
      if (OWNER_ID) $set.owner = OWNER_ID;

      await db.collection("customers").updateOne(
        customerEmailQuery(emailLower),
        {
          $set,
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true }
      );
    });

    const urlC = confirmUrl(emailLower);
    const urlU = unsubscribeUrl(emailLower);

    // Mail senden (wenn SMTP sauber konfiguriert ist)
    await mailer().sendMail({
      from: FROM_EMAIL,
      to: emailLower,
      bcc: MAIL_BCC || undefined,
      subject: "Bitte bestätige deine Newsletter-Anmeldung",
      html: confirmEmailHtml(emailLower, urlC, urlU),
      headers: {
        "List-Unsubscribe": `<${urlU}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    return res.status(200).json({
      ok: true,
      message: "Fast geschafft! Bitte bestätige deine E-Mail.",
      // für Postman/Debug:
      confirmUrl: urlC,
    });
  } catch (err) {
    console.error("[newsletter subscribe] error:", err);
    return res.status(500).json({ ok: false, error: "Serverfehler" });
  }
});

/* =========================================================
 * GET /api/public/newsletter/confirm?e=&t=
 * - setzt newsletter=true + subscribed + consent/confirmedAt
 * - setzt owner nachträglich, falls fehlte
 * =======================================================*/
router.get("/newsletter/confirm", async (req, res) => {
  try {
    if (!SECRET || !MONGO_URI) return redirect(res, "invalid");

    const emailLower = String(req.query.e || "")
      .toLowerCase()
      .trim();
    const tokenQ = String(req.query.t || req.query.token || "");

    const now = new Date();

    // Normalfall: e+t
    if (emailLower && tokenQ && isValidToken(emailLower, tokenQ)) {
      await withDb(async (db) => {
        const $set = {
          emailLower,
          email: emailLower,
          newsletter: true,
          marketingStatus: "subscribed",
          marketingConsentAt: now,
          newsletterConfirmedAt: now,
          updatedAt: now,
        };
        if (OWNER_ID) $set.owner = OWNER_ID;

        await db.collection("customers").updateOne(
          customerEmailQuery(emailLower),
          {
            $set,
            $unset: { confirmToken: "" },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true }
        );
      });

      return redirect(res, "confirmed");
    }

    // Legacy: nur token
    if (tokenQ) {
      const ok = await withDb(async (db) => {
        const $set = {
          newsletter: true,
          marketingStatus: "subscribed",
          marketingConsentAt: now,
          newsletterConfirmedAt: now,
          updatedAt: now,
        };
        if (OWNER_ID) $set.owner = OWNER_ID;

        const r = await db
          .collection("customers")
          .findOneAndUpdate(
            { confirmToken: tokenQ },
            { $set, $unset: { confirmToken: "" } },
            { returnDocument: "after" }
          );
        const doc = r?.value || null;
        return !!doc;
      });

      return ok ? redirect(res, "confirmed") : redirect(res, "invalid");
    }

    return redirect(res, "invalid");
  } catch (err) {
    console.error("[newsletter confirm] error:", err);
    return redirect(res, "invalid");
  }
});

/* =========================================================
 * GET /api/public/newsletter/unsubscribe?e=&t=
 * - setzt newsletter=false + unsubscribed
 * =======================================================*/
router.get("/newsletter/unsubscribe", async (req, res) => {
  try {
    if (!SECRET || !MONGO_URI) return redirect(res, "invalid");

    const emailLower = String(req.query.e || "")
      .toLowerCase()
      .trim();
    const token = String(req.query.t || "");
    if (!emailLower || !token || !isValidToken(emailLower, token)) {
      return redirect(res, "invalid");
    }

    const now = new Date();

    await withDb(async (db) => {
      const $set = {
        emailLower,
        newsletter: false,
        marketingStatus: "unsubscribed",
        newsletterUnsubscribedAt: now,
        updatedAt: now,
      };
      if (OWNER_ID) $set.owner = OWNER_ID;

      await db
        .collection("customers")
        .updateOne(customerEmailQuery(emailLower), {
          $set,
          $unset: { confirmToken: "" },
        });
    });

    return redirect(res, "unsubscribed");
  } catch (err) {
    console.error("[newsletter unsubscribe] error:", err);
    return redirect(res, "invalid");
  }
});

module.exports = router;
