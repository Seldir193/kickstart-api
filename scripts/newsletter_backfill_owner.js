// scripts/newsletter_backfill_owner.js
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";
const DEFAULT_OWNER_ID = process.env.DEFAULT_OWNER_ID || "";

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
  if (!DEFAULT_OWNER_ID) throw new Error("DEFAULT_OWNER_ID fehlt in .env");

  const DB_NAME = resolveDbName();
  const ownerId = new ObjectId(DEFAULT_OWNER_ID);

  const client = new MongoClient(MONGO_URI, {
    ignoreUndefined: true,
    serverSelectionTimeoutMS: 8000,
  });
  await client.connect();
  const db = client.db(DB_NAME);

  const q = {
    owner: { $exists: false },
    emailLower: { $type: "string", $ne: "" },
  };
  const r = await db
    .collection("customers")
    .updateMany(q, { $set: { owner: ownerId, updatedAt: new Date() } });

  console.log("✅ Backfill done:", {
    matched: r.matchedCount,
    modified: r.modifiedCount,
  });
  await client.close();
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
