// test-mongo.js
const mongoose = require('mongoose');
require('dotenv').config();

(async () => {
  try {
    console.log('Connecting to', process.env.MONGO_URI);
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    console.log('✅ Mongo OK');
    process.exit(0);
  } catch (e) {
    console.error('❌ Mongo FAIL:', e.message);
    if (e.reason) console.error('reason:', e.reason);
    process.exit(1);
  }
})();
