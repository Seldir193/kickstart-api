// scripts/migrate_counters_to_id.js
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI fehlt');

  const client = new MongoClient(uri);
  await client.connect();

  const db = client.db();                // wenn im URI kein DB-Name, dann z.B. "test"
  const col = db.collection('counters');
  console.log('DB:', db.databaseName);

  // 1) alten Unique-Index auf "key" entfernen (falls vorhanden)
  const idxs = await col.indexes();
  const keyIdx = idxs.find(i => i.name === 'key_1' || (i.key && i.key.key === 1));
  if (keyIdx) {
    await col.dropIndex(keyIdx.name);
    console.log('Dropped index:', keyIdx.name);
  } else {
    console.log('No key_1 index present.');
  }

  // 2) Legacy-Dokumente mit "key" auf neues Format migrieren
  const legacy = await col.find({ key: { $exists: true } }).toArray();
  console.log('Legacy docs with "key":', legacy.length);

  for (const d of legacy) {
    const targetId = String(d.key);
    const seq = Number(d.seq) || 0;

    // upsert auf neues Schema { _id: <key>, seq: <max> }
    await col.updateOne(
      { _id: targetId },
      { $max: { seq } },
      { upsert: true }
    );

    // altes Dokument löschen
    await col.deleteOne({ _id: d._id });
    console.log(`Migrated ${d._id} -> ${targetId} (seq ${seq})`);
  }

  await client.close();
  console.log('Migration done.');
})().catch(e => { console.error(e); process.exit(1); });
