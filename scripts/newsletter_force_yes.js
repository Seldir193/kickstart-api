// scripts/newsletter_force_yes.js
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const DEFAULT_OWNER_ID = process.env.DEFAULT_OWNER_ID;

const EMAIL = (process.argv[2] || "").trim().toLowerCase();

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

(async () => {
  if (!MONGO_URI) throw new Error("MONGO_URI fehlt");
  if (!DEFAULT_OWNER_ID) throw new Error("DEFAULT_OWNER_ID fehlt");
  if (!EMAIL)
    throw new Error(
      'Nutze: node scripts/newsletter_force_yes.js "test@gmail.com"'
    );

  const DB_NAME = resolveDbName();
  const ownerId = new ObjectId(DEFAULT_OWNER_ID);
  const now = new Date();

  const client = new MongoClient(MONGO_URI, { ignoreUndefined: true });
  await client.connect();
  const db = client.db(DB_NAME);

  const q = { $or: [{ emailLower: EMAIL }, { email: EMAIL }] };

  const result = await db.collection("customers").findOneAndUpdate(
    q,
    {
      $set: {
        owner: ownerId,
        emailLower: EMAIL,
        email: EMAIL,
        newsletter: true,
        marketingStatus: "subscribed",
        marketingConsentAt: now,
        newsletterConfirmedAt: now,
        updatedAt: now,
      },
      $unset: { confirmToken: "" },
      $setOnInsert: { createdAt: now },
    },
    {
      upsert: true,
      returnDocument: "after",
      // für Driver, die sonst "doc direkt" zurückgeben:
      includeResultMetadata: true,
    }
  );

  const doc = result?.value || null;
  if (!doc)
    throw new Error(
      "findOneAndUpdate hat kein Dokument zurückgegeben (value ist null)."
    );

  console.log("✅ Updated:");
  console.log({
    _id: String(doc._id),
    owner: doc.owner ? String(doc.owner) : null,
    emailLower: doc.emailLower,
    newsletter: doc.newsletter,
    marketingStatus: doc.marketingStatus,
    marketingConsentAt: doc.marketingConsentAt,
    newsletterConfirmedAt: doc.newsletterConfirmedAt,
    confirmTokenExists: Object.prototype.hasOwnProperty.call(
      doc,
      "confirmToken"
    ),
    updatedAt: doc.updatedAt,
  });

  await client.close();
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
