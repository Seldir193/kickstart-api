// app.js
'use strict';
const path = require('path');

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

// Router, die du bereits nutzt
const publicNewsletter = require('./routes/publicNewsletter');
const bookingsRouter    = require('./routes/bookings');
const offersRouter      = require('./routes/offers');
const adminUsersRouter  = require('./routes/adminUsers');   // /api/admin/auth
const customersRouter   = require('./routes/customers');
const bookingActions    = require('./routes/bookingActions'); // /api/admin/customers/* (cancel/storno/invoices)
const adminInvoices     = require('./routes/adminInvoices');  // /api/admin/invoices
const placesRouter      = require('./routes/places');

/* ========== App ========== */
const app = express();
app.set('trust proxy', 1); // falls später Proxy/Ingress davor sitzt

/* ========== Security & Parsers ========== */
// Wichtig: CORP cross-origin, sonst blockt der Browser Bilder/Videos von :5000 auf :80
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // falls du jemals COEP/COOP brauchst, hier anpassen; default reicht i.d.R.
}));


app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

/* ========== CORS (einmal, dynamisch aus ENV) ========== */
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

/* ========== Static Uploads (mit CORP Header) ========== */
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

/* ========== Health Routes ========== */
app.get('/api/ping',   (_req, res) => res.json({ ok: true, msg: 'API up' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// app.js / index.js
const coachesRouter = require('./routes/coaches');
app.use('/api/coaches', coachesRouter);



/* ========== SMTP Health (optional) ========== */
const { verifySmtp } = require('./utils/mailer');

/* ========== DB Connect ========== */
const PORT      = Number(process.env.PORT || 5000);
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('❌ Missing MONGO_URI/MONGODB_URI in .env');
  process.exit(1);
}

// Mongoose Settings
mongoose.set('strictQuery', true);
// mongoose.set('debug', true); // optional im Dev

(async () => {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10_000,
      // dbName nur setzen, wenn NICHT in der URI enthalten:
      dbName: 'test',
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

    /* ========== API Routes (NACH Middleware & DB-Connect) ========== */

    // Upload & News (wichtig für WP/React)
    app.use('/api/upload', require('./routes/upload'));
    app.use('/api/news',   require('./routes/news'));

    // Deine bestehenden Routen
    app.use('/api/public',           publicNewsletter);
    app.use('/api/bookings',         bookingsRouter);
    app.use('/api/offers',           offersRouter);
    app.use('/api/admin/auth',       adminUsersRouter);
    app.use('/api/customers',        customersRouter);
    app.use('/api/places',           placesRouter);
    app.use('/api/admin/datev',      require('./routes/datev'));
    app.use('/api/admin/revenue',    require('./routes/adminRevenue'));
    app.use('/api/admin/revenue-derived', require('./routes/adminRevenueDerived'));



    // Admin Actions (cancel/storno/invoices auf Customer/Booking-Ebene)
    app.use('/api/admin/customers',  bookingActions);

    // Admin Invoices (listen/generate at provider level)
    app.use('/api/admin/invoices',   adminInvoices);

    /* ========== 404-Fallback nur für /api (nach allen Routen) ========== */
    app.use('/api', (_req, res) => res.status(404).json({ error: 'Not Found' }));

    /* ========== Zentrale Error-Handler (saubere JSON-Fehler) ========== */
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

    /* ========== Start Server (einmal!) ========== */
    app.listen(PORT, () => {
      console.log(`🚀 API listening on http://localhost:${PORT}`);
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
