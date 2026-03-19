// scripts/newsletter_cleanup_confirmToken.js
const { MongoClient } = require("mongodb");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

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
  const DB_NAME = resolveDbName();
  const now = new Date();

  const client = new MongoClient(MONGO_URI, { ignoreUndefined: true });
  await client.connect();
  const db = client.db(DB_NAME);

  const r = await db.collection("customers").updateMany(
    {
      marketingStatus: "subscribed",
      confirmToken: { $exists: true },
    },
    {
      $unset: { confirmToken: "" },
      $set: { updatedAt: now },
    }
  );

  console.log("✅ confirmToken entfernt bei:", r.modifiedCount, "Docs");
  await client.close();
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
