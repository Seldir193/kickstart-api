// scripts/repair_customer_indexes.js
'use strict';

require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  try {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGO_URI / MONGODB_URI fehlt');

    const client = new MongoClient(uri, { ignoreUndefined: true });
    await client.connect();
    const db = client.db('test'); // 👉 ggf. "test" durch deine DB ersetzen
    const col = db.collection('customers');

    console.log('🔍 Repair customer indexes in DB:', db.databaseName);

    // Vorherige Indizes auflisten
    const prev = await col.indexes();
    console.log('Vorherige Indizes:', prev.map(i => i.name));

    // Problematische Indizes entfernen
    const dropIfExists = async (name) => {
      if (prev.some(i => i.name === name)) {
        await col.dropIndex(name);
        console.log('🗑️  Entfernt:', name);
      } else {
        console.log('ℹ️  Schon entfernt:', name);
      }
    };

    // Bekannte "Legacy"-Indizes
    await dropIfExists('invoiceNumber_1');
    await dropIfExists('owner_invoice_unique_when_set');
    await dropIfExists('cancellationNumber_1');
    await dropIfExists('owner_cancellation_unique_when_set');
    await dropIfExists('stornoNumber_1');
    await dropIfExists('owner_storno_unique_when_set');

    // Sinnvolle Indizes sicherstellen
    await col.createIndex({ owner: 1, createdAt: -1 }, { background: true });
    await col.createIndex({ userId: 1, owner: 1 }, { background: true });

    const now = await col.indexes();
    console.log('✅ Aktuelle Indizes:', now.map(i => i.name));

    await client.close();
  } catch (err) {
    console.error('❌ Fehler:', err);
    process.exit(1);
  }
})();
