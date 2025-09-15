// app.js
'use strict';

/* ========== Env & Basics ========== */
require('dotenv').config();
console.log('ADMIN_EMAIL loaded =', JSON.stringify(process.env.ADMIN_EMAIL));

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose  = require('mongoose');
const dns       = require('dns');

// Bevorzugt IPv4 (hilft bei Windows/DNS/SRV)
dns.setDefaultResultOrder('ipv4first');

/* ========== App ========== */
const app = express();
app.set('trust proxy', 1); // falls später Proxy/Ingress davor sitzt

/* ========== Security & Parsers ========== */
app.use(helmet());
app.use(express.json({ limit: '5mb' }));

/* ========== CORS ========== */
// Mehrere Origins kommasepariert in CORS_ORIGIN
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // z.B. curl/Postman
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
}));

/* ========== Rate Limiting ========== */
app.use('/api/', rateLimit({ windowMs: 60_000, max: 60 }));

/* ========== Health Routes ========== */
app.get('/api/ping',   (_req, res) => res.json({ ok: true, msg: 'API up' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* ========== SMTP Health (optional) ========== */
const { verifySmtp } = require('./utils/mailer');

/* ========== Routers ========== */
// Du hast diese Router genannt/angekündigt – sie müssen jeweils exportierende Express-Router sein.
const bookingsRouter    = require('./routes/bookings');
const offersRouter      = require('./routes/offers');
const adminUsersRouter  = require('./routes/adminUsers');   // /api/admin/auth
const customersRouter   = require('./routes/customers');
const bookingActions    = require('./routes/bookingActions'); // /api/admin/customers/* (cancel/storno/invoices)
const adminInvoices     = require('./routes/adminInvoices');  // /api/admin/invoices
const placesRouter      = require('./routes/places');

/* ========== DB Connect ========== */
const PORT      = Number(process.env.PORT || 5000);
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('❌ Missing MONGO_URI/MONGODB_URI in .env');
  process.exit(1);
}

// Mongoose Settings
mongoose.set('strictQuery', true);
// Optional im Dev:
// mongoose.set('debug', true);

(async () => {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10_000, // schnellere Rückmeldung
      // dbName nur setzen, wenn NICHT in der URI enthalten:
      // dbName: 'kickstart',
    });
    console.log('✅ MongoDB connected');

    // Models einmal laden und in app.locals bereitstellen (für Router, falls benötigt)
    const Customer = require('./models/Customer');
    const Booking  = require('./models/Booking');
    app.locals.models = { Customer, Booking };

    // SMTP prüfen (nicht fatal)
    try {
      await verifySmtp();
      console.log('[mailer] SMTP ready');
    } catch (e) {
      console.error('[mailer] SMTP verify failed:', e?.message || e);
    }

    /* ========== Mount Routes ========== */
    app.use('/api/bookings',           bookingsRouter);
    app.use('/api/offers',             offersRouter);
    app.use('/api/admin/auth',         adminUsersRouter);
    app.use('/api/customers',          customersRouter);
    app.use('/api/places',             placesRouter);

    // Admin Actions (cancel/storno/invoices auf Customer/Booking-Ebene)
    app.use('/api/admin/customers',    bookingActions);

    // Admin Invoices (listen/generate at provider level)
    app.use('/api/admin/invoices',     adminInvoices);

    // 404-Fallback nur für /api (nach allen Routen)
    app.use('/api', (_req, res) => res.status(404).json({ error: 'Not Found' }));

    // Zentrale Error-Handler (saubere JSON-Fehler)
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
      const status = err.status || 500;
      const payload = {
        ok: false,
        error: err.message || 'Internal Server Error',
      };
      if (process.env.NODE_ENV !== 'production') {
        payload.stack = err.stack;
      }
      if (!res.headersSent) res.status(status).json(payload);
    });

    // Start Server
    app.listen(PORT, () => {
      console.log(`🚀 Server listening on :${PORT}`);
    });

  } catch (err) {
    console.error('❌ Mongo connection error:', err?.message);
    if (err?.reason) console.error('reason:', err.reason);
    process.exit(1);
  }
})();

// Laufzeit-DB-Fehler loggen
mongoose.connection.on('error', (err) => {
  console.error('Mongo runtime error:', err?.message);
});


