









// app.js
require('dotenv').config();
console.log('ADMIN_EMAIL loaded =', JSON.stringify(process.env.ADMIN_EMAIL));

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose  = require('mongoose');

const bookingsRouter   = require('./routes/bookings');
const offersRouter     = require('./routes/offers');
const adminUsersRouter = require('./routes/adminUsers'); // <-- ADD THIS

const app = express();

/** Security & Basics */
app.use(helmet());
app.use(express.json());

/** CORS */
const allowed = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true, // falls du mal Cookies/Authorization vom FE mitsendest
}));

/** Rate Limiting */
app.use('/api/', rateLimit({ windowMs: 60_000, max: 60 }));

/** Health */
app.get('/api/ping',   (_req, res) => res.json({ ok: true, msg: 'API up' }));
app.get('/api/health', (_req, res) => res.json({ ok: true })); // keep both

/** Routes */
app.use('/api/bookings',    bookingsRouter);
app.use('/api/offers',      offersRouter);
app.use('/api/admin/auth', adminUsersRouter); // <-- ADD THIS

/** DB + Server */
const PORT = process.env.PORT || 5000;

if (!process.env.MONGO_URI) {
  console.error('Missing MONGO_URI in .env');
  process.exit(1);
}

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Mongo connection error:', err.message);
    process.exit(1);
  });












