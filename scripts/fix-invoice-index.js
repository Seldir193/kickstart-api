#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

// Usage:
//   MONGO_URI="mongodb+srv://..." DB_NAME="test" node scripts/fix-invoice-index.js

const { MongoClient } = require('mongodb');

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ Missing MONGO_URI / MONGODB_URI');
    process.exit(1);
  }

  const explicitDbName = process.env.DB_NAME || null;
  const client = new MongoClient(uri, { maxPoolSize: 3 });

  await client.connect();

  // DB bestimmen
  let dbName = explicitDbName;
  if (!dbName) {
    const parsed = new URL(uri);
    dbName = (parsed.pathname || '').replace(/^\//, '') || 'test';
  }

  const db = client.db(dbName);
  const coll = db.collection('bookings');

  console.log(`🔗 Connected. DB: ${db.databaseName}  Collection: bookings`);

  // 1) Null/Leer entfernen
  const resNull = await coll.updateMany(
    { invoiceNumber: null },
    { $unset: { invoiceNumber: 1 } }
  );
  const resEmpty = await coll.updateMany(
    { invoiceNumber: '' },
    { $unset: { invoiceNumber: 1 } }
  );
  console.log(`🧹 Unset invoiceNumber: null=${resNull.modifiedCount}, empty-string=${resEmpty.modifiedCount}`);

  // 2) Duplikate prüfen (owner + invoiceNumber), nur echte Strings
  console.log('🔎 Checking duplicates (owner + invoiceNumber)…');
  const dups = await coll.aggregate([
    { $match: { invoiceNumber: { $type: 'string', $gt: '' } } }, // > "" => nicht leer
    { $group: {
        _id: { owner: '$owner', invoiceNumber: '$invoiceNumber' },
        count: { $sum: 1 },
        ids: { $push: '$_id' },
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 50 },
  ]).toArray();

  if (dups.length) {
    console.error('❌ Found duplicates. Resolve before creating the unique index:');
    dups.forEach((g, i) => {
      console.error(
        `[${i + 1}] owner=${g._id.owner} invoiceNumber="${g._id.invoiceNumber}" count=${g.count} sampleIds=${g.ids.slice(0, 5).join(', ')}`
      );
    });
    await client.close();
    process.exit(2);
  }
  console.log('✅ No duplicates found.');

  // 3) Alten Index (owner, invoiceNumber) droppen, falls vorhanden
  const targetKey = { owner: 1, invoiceNumber: 1 };
  const indexes = await coll.indexes();
  const existing = indexes.find(ix => {
    const keys = ix.key || {};
    const sameKeys =
      Object.keys(targetKey).length === Object.keys(keys).length &&
      Object.entries(targetKey).every(([k, v]) => keys[k] === v);
    return sameKeys;
  });

  if (existing) {
    console.log(`🗑️  Dropping existing index "${existing.name}" on { owner:1, invoiceNumber:1 }…`);
    try { await coll.dropIndex(existing.name); }
    catch (e) { console.warn('  (dropIndex warning)', e.message); }
  } else {
    console.log('ℹ️  No existing {owner, invoiceNumber} index to drop.');
  }

  // 4) Partial-Unique-Index neu anlegen (ohne $ne; stattdessen $gt: "")
  console.log('🧱 Creating partial unique index on { owner:1, invoiceNumber:1 }…');
  await coll.createIndex(
    { owner: 1, invoiceNumber: 1 },
    {
      unique: true,
      // nimmt nur Dokumente auf, in denen invoiceNumber existiert und NICHT leer ist
      // ($gt: "" ist in Partial-Indexen erlaubt und filtert "" sicher heraus)
      partialFilterExpression: { invoiceNumber: { $exists: true, $gt: '' } },
      name: 'owner_1_invoiceNumber_1_partial_unique'
    }
  );

  console.log('🎉 Done. Partial unique index created successfully.');
  await client.close();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});







