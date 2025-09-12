// app.js
require('dotenv').config();
console.log('ADMIN_EMAIL loaded =', JSON.stringify(process.env.ADMIN_EMAIL));

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose  = require('mongoose');

const bookingsRouter    = require('./routes/bookings');    // you will provide
const offersRouter      = require('./routes/offers');      // you will provide
const adminUsersRouter  = require('./routes/adminUsers');  // you will provide
const customersRouter   = require('./routes/customers');   // you will provide

// NEW: actions router for cancel/storno/invoices
const bookingActions    = require('./routes/bookingActions'); // create from our earlier message





const adminInvoices = require('./routes/adminInvoices');




// SMTP health check
const { verifySmtp }    = require('./utils/mailer');

const app = express();

/** Security & Basics */
app.use(helmet());
app.use(express.json({ limit: '5mb' }));

/** CORS (allow multiple origins, comma-separated in .env CORS_ORIGIN) */
const allowed = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
}));

/** Rate Limiting for /api/ */
app.use('/api/', rateLimit({ windowMs: 60_000, max: 60 }));

/** Health */
app.get('/api/ping',   (_req, res) => res.json({ ok: true, msg: 'API up' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/** DB + Server */
const PORT = process.env.PORT || 5000;

if (!process.env.MONGO_URI) {
  console.error('Missing MONGO_URI in .env');
  process.exit(1);
}

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected');

    // Attach models to app.locals for cross-router access
    const Customer = require('./models/Customer');
    const Booking  = require('./models/Booking');
    app.locals.models = { Customer, Booking };

    // Verify SMTP on boot (visible in logs)
    try {
      await verifySmtp();
      console.log('[mailer] SMTP ready');
    } catch (e) {
      console.error('[mailer] SMTP verify failed:', e?.message || e);
    }

    /** Routes */
    app.use('/api/bookings',     bookingsRouter);
    app.use('/api/offers',       offersRouter);
    app.use('/api/admin/auth',   adminUsersRouter);
    app.use('/api/customers',    customersRouter);

   



    // Important: admin actions expected by your React Admin
    // /api/admin/customers/:cid/bookings/:bid/cancel
    // /api/admin/customers/:cid/bookings/:bid/storno
    // /api/admin/customers/:cid/invoices
    app.use('/api/admin/customers', bookingActions);


    app.use('/api/admin/invoices', adminInvoices);

    // Basic 404 for /api
    app.use('/api', (_req, res) => res.status(404).json({ error: 'Not Found' }));

    app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Mongo connection error:', err.message);
    process.exit(1);
  });







