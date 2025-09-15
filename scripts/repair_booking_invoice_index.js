// scripts/repair_booking_invoice_index.js
'use strict';
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI fehlt');

  const client = new MongoClient(uri, { ignoreUndefined: true });
  await client.connect();
  const db  = client.db();
  const col = db.collection('bookings');

  console.log('DB:', db.databaseName);

  // 1) alle null/"" Werte entfernen -> Feld fehlt (wichtig für Partial-Index)
  const u1 = await col.updateMany({ invoiceNumber: null }, { $unset: { invoiceNumber: "" } });
  const u2 = await col.updateMany({ invoiceNumber: "" },   { $unset: { invoiceNumber: "" } });
  console.log('Unset invoiceNumber null/"" ->', { nulls: u1.modifiedCount, empties: u2.modifiedCount });

  // 2) alte owner+invoiceNumber-Indizes droppen (Name kann variieren)
  const idxs = await col.indexes();
  const toDrop = idxs
    .filter(i => i.unique && i.key && i.key.owner === 1 && i.key.invoiceNumber === 1)
    .map(i => i.name);
  if (toDrop.length) {
    for (const name of toDrop) {
      try { await col.dropIndex(name); console.log('Dropped index:', name); }
      catch (e) { console.warn('Drop warn:', e.message); }
    }
  } else {
    console.log('Kein alter owner+invoiceNumber Unique-Index gefunden (ok).');
  }

  // 3) Partial-Unique-Index neu anlegen (greift NUR wenn invoiceNumber gesetzt & nicht leer)
 await col.createIndex(
  { owner: 1, invoiceNumber: 1 },
  {
    unique: true,
    // wichtig: KEIN $ne, nur $exists
    partialFilterExpression: { invoiceNumber: { $exists: true } },
    name: 'owner_invoice_unique_when_set',
    background: true,
  }
);

  console.log('Created index: owner_invoice_unique_when_set');

  await client.close();
  console.log('✅ Reparatur fertig.');
})().catch(e => { console.error('❌ Fehler:', e); process.exit(1); });
