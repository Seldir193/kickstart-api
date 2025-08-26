














require('dotenv').config();
console.log('ADMIN_EMAIL loaded =', JSON.stringify(process.env.ADMIN_EMAIL));

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

const bookingsRouter = require('./routes/bookings');
const offersRouter   = require('./routes/offers'); // <-- NEW

const app = express();

/** Security & Basics */
app.use(helmet());
app.use(express.json());

/** CORS */
const allowed = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  }
}));

/** Rate Limiting */
app.use('/api/', rateLimit({ windowMs: 60_000, max: 60 }));

/** Health */
app.get('/api/ping', (_req, res) => res.json({ ok: true, msg: 'API up' }));
app.get('/api/health', (_req, res) => res.json({ ok: true })); // keep both

/** Routes */
app.use('/api/bookings', bookingsRouter); // your existing path
app.use('/api/offers',   offersRouter);   // <-- NEW (replaces your quick hotfix)

/** DB + Server */
const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Mongo connection error:', err.message);
    process.exit(1);
  });
