// scripts/cleanup-clubs.js
// Remove clubId from offers and drop 'clubs' collection (if present)

const path = require('path');
const mongoose = require('mongoose');

// Load backend .env (adjust path if yours is different)
try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (_) {}

(async () => {
  const uri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DB_URL ||
    'mongodb://127.0.0.1:27017/kickstart';

  console.log('Connecting to MongoDB:', uri);

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });

    const db = mongoose.connection.db;

    // remove legacy field
    let unsetResult = { modifiedCount: 0 };
    try {
      unsetResult = await db
        .collection('offers')
        .updateMany({}, { $unset: { clubId: 1 } });
    } catch (e) {
      console.warn('offers collection not found or update failed:', e.message);
    }

    // drop clubs collection if exists
    const exists = (await db.listCollections({ name: 'clubs' }).toArray()).length > 0;
    if (exists) {
      await db.collection('clubs').drop();
      console.log('Dropped collection: clubs');
    } else {
      console.log('No collection "clubs" found – nothing to drop.');
    }

    console.log(`Unset clubId on ${unsetResult.modifiedCount || 0} offers.`);
    await mongoose.disconnect();
    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Mongo connection failed:', err.message);
    console.error('Tip: start MongoDB or set MONGODB_URI before running the script.');
    process.exit(1);
  }
})();
