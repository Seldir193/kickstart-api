// scripts/repair_booking_indexes.js
'use strict';

require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ Bitte MONGO_URI in deiner .env setzen');
    process.exit(1);
  }

  const client = new MongoClient(uri, { ignoreUndefined: true });
  await client.connect();
  const db = client.db('test'); // <-- anpassen, falls deine DB anders heißt
  const col = db.collection('bookings');

  console.log('🔍 Repair booking indexes in DB:', db.databaseName);

  // Liste aktueller Indizes
  const indexes = await col.indexes();
  console.log('Vorherige Indizes:', indexes.map(i => i.name));

  // Alle problematischen Index-Namen
  const dropNames = [
    'invoiceNumber_1',
    'owner_invoice_unique_when_set',
    'cancellationNumber_1',
    'owner_cancellation_unique_when_set',
    'stornoNumber_1',
    'owner_storno_unique_when_set'
  ];

  for (const name of dropNames) {
    try {
      await col.dropIndex(name);
      console.log('✅ Entfernt:', name);
    } catch (err) {
      if (err.codeName === 'IndexNotFound') {
        console.log('ℹ️ Schon entfernt:', name);
      } else {
        console.error('⚠️ Fehler beim Entfernen', name, err.message);
      }
    }
  }

  // Sicherstellen, dass nur der richtige Index existiert
  await col.createIndex(
    { owner: 1, invoiceNumber: 1 },
    { unique: true, sparse: true, name: 'owner_1_invoiceNumber_1' }
  );
  console.log('✅ Index owner_1_invoiceNumber_1 sichergestellt');

  const after = await col.indexes();
  console.log('Aktuelle Indizes:', after.map(i => i.name));

  await client.close();
})();
