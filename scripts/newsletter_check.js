// scripts/newsletter_check.js
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
      'Bitte Email: node scripts/newsletter_check.js "test@gmail.com"'
    );

  const DB_NAME = resolveDbName();
  const ownerId = new ObjectId(DEFAULT_OWNER_ID);

  const client = new MongoClient(MONGO_URI, { ignoreUndefined: true });
  await client.connect();
  const db = client.db(DB_NAME);
  const col = db.collection("customers");

  const docs = await col
    .find(
      { $or: [{ emailLower: EMAIL }, { email: EMAIL }] },
      {
        projection: {
          email: 1,
          emailLower: 1,
          owner: 1,
          newsletter: 1,
          marketingStatus: 1,
          confirmToken: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      }
    )
    .toArray();

  console.log("DB:", DB_NAME);
  console.log("DEFAULT_OWNER_ID:", String(ownerId));
  console.log("Docs für", EMAIL, "=>", docs.length);

  docs.forEach((d) => {
    console.log({
      _id: String(d._id),
      owner: d.owner ? String(d.owner) : null,
      newsletter: d.newsletter,
      marketingStatus: d.marketingStatus,
      confirmToken: !!d.confirmToken,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    });
  });

  const wrongOwner = docs.filter(
    (d) => !d.owner || String(d.owner) !== String(ownerId)
  );
  if (wrongOwner.length) {
    console.log(
      "\n⚠️ Problem: owner fehlt oder ist falsch bei:",
      wrongOwner.map((d) => String(d._id))
    );
  } else {
    console.log("\n✅ owner passt bei allen Docs.");
  }

  const inconsistent = docs.filter(
    (d) => d.marketingStatus === "subscribed" && d.newsletter !== true
  );
  if (inconsistent.length) {
    console.log(
      "\n⚠️ Problem: subscribed aber newsletter != true bei:",
      inconsistent.map((d) => String(d._id))
    );
  } else {
    console.log("\n✅ newsletter/status konsistent.");
  }

  await client.close();
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
