// "use strict";

// const path = require("path");
// require("dotenv").config();

// const express = require("express");
// const helmet = require("helmet");
// const cors = require("cors");
// const rateLimit = require("express-rate-limit");
// const mongoose = require("mongoose");
// const dns = require("dns");

// dns.setDefaultResultOrder("ipv4first");

// const franchiseLocationsRouter = require("./routes/franchiseLocations");
// const adminFranchiseLocationsRouter = require("./routes/adminFranchiseLocations");
// const publicNewsletter = require("./routes/publicNewsletter");
// const bookingsRouter = require("./routes/bookings");
// const offersRouter = require("./routes/offers");
// const adminUsersRouter = require("./routes/adminUsers");
// const customersRouter = require("./routes/customers");
// const bookingActions = require("./routes/bookingActions");
// const adminInvoices = require("./routes/adminInvoices");
// const placesRouter = require("./routes/places");
// const stripePaymentsRouter = require("./routes/payments/stripe/router");
// const coachesRouter = require("./routes/coaches");
// const { verifySmtp } = require("./utils/mailer");

// const app = express();
// app.set("trust proxy", 1);

// app.use(
//   helmet({
//     crossOriginResourcePolicy: { policy: "cross-origin" },
//   }),
// );

// const allowedOrigins = (
//   process.env.CORS_ORIGIN ||
//   "http://localhost:3000,http://127.0.0.1:3000,http://localhost"
// )
//   .split(",")
//   .map((s) => s.trim())
//   .filter(Boolean);

// app.use(
//   cors({
//     origin: (origin, cb) => {
//       if (!origin) return cb(null, true);
//       if (allowedOrigins.includes(origin)) return cb(null, true);
//       return cb(new Error("Not allowed by CORS: " + origin));
//     },
//     credentials: true,
//   }),
// );

// app.use(express.json({ limit: "20mb" }));
// app.use(express.urlencoded({ limit: "20mb", extended: true }));

// app.use("/api/payments/stripe", stripePaymentsRouter);
// app.use("/api/public", require("./routes/publicWeeklyContract"));

// app.use("/api/", rateLimit({ windowMs: 60_000, max: 60 }));

// app.use(
//   "/uploads",
//   express.static(path.join(__dirname, "uploads"), {
//     maxAge: "7d",
//     setHeaders: (res) => {
//       res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
//     },
//   }),
// );

// app.get("/api/ping", (_req, res) => res.json({ ok: true, msg: "API up" }));
// app.get("/api/health", (_req, res) => res.json({ ok: true }));

// app.use("/api/admin/coaches", require("./routes/adminCoaches"));
// app.use("/api/franchise-locations", franchiseLocationsRouter);
// app.use("/api/admin/franchise-locations", adminFranchiseLocationsRouter);
// app.use("/api/coaches", coachesRouter);

// const PORT = Number(process.env.PORT || 5000);
// const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

// if (!MONGO_URI) {
//   console.error("❌ Missing MONGO_URI/MONGODB_URI in .env");
//   process.exit(1);
// }

// mongoose.set("strictQuery", true);

// (async () => {
//   try {
//     await mongoose.connect(MONGO_URI, {
//       serverSelectionTimeoutMS: 10_000,
//       dbName: "test",
//     });

//     console.log("✅ MongoDB connected");

//     const Customer = require("./models/Customer");
//     const Booking = require("./models/Booking");
//     app.locals.models = { Customer, Booking };

//     try {
//       await verifySmtp();
//       console.log("[mailer] SMTP ready");
//     } catch (e) {
//       console.error("[mailer] SMTP verify failed:", e?.message || e);
//     }

//     app.use("/api/upload", require("./routes/upload"));
//     app.use("/api/news", require("./routes/news"));
//     app.use("/api/admin/news", require("./routes/adminNews"));

//     app.use("/api/admin/bookings", require("./routes/adminBookings"));

//     app.use("/api/public", require("./routes/publicBookingEligibility"));

//     app.use("/api/public", publicNewsletter);
//     app.use("/api/bookings", bookingsRouter);
//     app.use("/api/offers", offersRouter);
//     app.use("/api/admin/auth", adminUsersRouter);

//     app.use("/api/customers", customersRouter);
//     app.use("/api/places", placesRouter);
//     app.use("/api/admin/datev", require("./routes/datev"));
//     app.use("/api/admin/revenue", require("./routes/adminRevenue"));
//     app.use(
//       "/api/admin/revenue-derived",
//       require("./routes/adminRevenueDerived"),
//     );

//     app.use("/api/admin/customers", bookingActions);
//     app.use("/api/admin/invoices", adminInvoices);
//     app.use(
//       "/api/admin/invoices",
//       require("./routes/adminInvoices/dunning-search"),
//     );

//     app.use("/api", (_req, res) =>
//       res.status(404).json({ error: "Not Found" }),
//     );

//     app.use((err, _req, res, _next) => {
//       const status = err.status || 500;
//       const payload = {
//         ok: false,
//         error: err.message || "Internal Server Error",
//       };
//       if (process.env.NODE_ENV !== "production") payload.stack = err.stack;
//       if (!res.headersSent) res.status(status).json(payload);
//     });

//     app.listen(PORT, () => {
//       console.log(`🚀 API listening on http://localhost:${PORT}`);
//     });
//   } catch (err) {
//     console.error("❌ Mongo connection error:", err?.message);
//     if (err?.reason) console.error("reason:", err.reason);
//     process.exit(1);
//   }
// })();

// mongoose.connection.on("error", (err) => {
//   console.error("Mongo runtime error:", err?.message);
// });

"use strict";

const path = require("path");
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

const franchiseLocationsRouter = require("./routes/franchiseLocations");
const adminFranchiseLocationsRouter = require("./routes/adminFranchiseLocations");
const publicNewsletter = require("./routes/publicNewsletter");
const bookingsRouter = require("./routes/bookings");
const offersRouter = require("./routes/offers");
const adminUsersRouter = require("./routes/adminUsers");
const customersRouter = require("./routes/customers");
const bookingActions = require("./routes/bookingActions");
const adminInvoices = require("./routes/adminInvoices");
const placesRouter = require("./routes/places");
const stripePaymentsRouter = require("./routes/payments/stripe/router");
const coachesRouter = require("./routes/coaches");
const { verifySmtp } = require("./utils/mailer");

const app = express();
app.set("trust proxy", 1);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

const allowedOrigins = (
  process.env.CORS_ORIGIN ||
  "http://localhost:3000,http://127.0.0.1:3000,http://localhost"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
  }),
);

app.post(
  "/api/payments/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripePaymentsRouter,
);

const vouchersRouter = require("./routes/vouchers");

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

app.use("/api/vouchers", vouchersRouter);

app.use("/api/payments/stripe", stripePaymentsRouter);
app.use("/api/public", require("./routes/publicWeeklyContract"));

app.use("/api/", rateLimit({ windowMs: 60_000, max: 60 }));

app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    maxAge: "7d",
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  }),
);

app.get("/api/ping", (_req, res) => res.json({ ok: true, msg: "API up" }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/admin/coaches", require("./routes/adminCoaches"));
app.use("/api/franchise-locations", franchiseLocationsRouter);
app.use("/api/admin/franchise-locations", adminFranchiseLocationsRouter);
app.use("/api/coaches", coachesRouter);

const PORT = Number(process.env.PORT || 5000);
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error("❌ Missing MONGO_URI/MONGODB_URI in .env");
  process.exit(1);
}

mongoose.set("strictQuery", true);

(async () => {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10_000,
      dbName: "test",
    });

    console.log("✅ MongoDB connected");

    const Customer = require("./models/Customer");
    const Booking = require("./models/Booking");
    app.locals.models = { Customer, Booking };

    try {
      await verifySmtp();
      console.log("[mailer] SMTP ready");
    } catch (e) {
      console.error("[mailer] SMTP verify failed:", e?.message || e);
    }

    app.use("/api/upload", require("./routes/upload"));
    app.use("/api/news", require("./routes/news"));
    app.use("/api/admin/news", require("./routes/adminNews"));

    app.use("/api/feedbacks", require("./routes/feedbacks"));
    app.use("/api/admin/feedbacks", require("./routes/adminFeedbacks"));

    app.use("/api/admin/bookings", require("./routes/adminBookings"));

    app.use("/api/public", require("./routes/publicBookingEligibility"));

    app.use("/api/public", publicNewsletter);
    app.use("/api/bookings", bookingsRouter);
    app.use("/api/offers", offersRouter);
    app.use("/api/admin/auth", adminUsersRouter);

    app.use("/api/customers", customersRouter);
    app.use("/api/places", placesRouter);
    app.use("/api/admin/datev", require("./routes/datev"));
    app.use("/api/admin/revenue", require("./routes/adminRevenue"));
    app.use(
      "/api/admin/revenue-derived",
      require("./routes/adminRevenueDerived"),
    );

    app.use("/api/admin/customers", bookingActions);
    app.use("/api/admin/invoices", adminInvoices);
    app.use(
      "/api/admin/invoices",
      require("./routes/adminInvoices/dunning-search"),
    );

    app.use("/api", (_req, res) =>
      res.status(404).json({ error: "Not Found" }),
    );

    app.use((err, _req, res, _next) => {
      const status = err.status || 500;
      const payload = {
        ok: false,
        error: err.message || "Internal Server Error",
      };
      if (process.env.NODE_ENV !== "production") payload.stack = err.stack;
      if (!res.headersSent) res.status(status).json(payload);
    });

    app.listen(PORT, () => {
      console.log(`🚀 API listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Mongo connection error:", err?.message);
    if (err?.reason) console.error("reason:", err.reason);
    process.exit(1);
  }
})();

mongoose.connection.on("error", (err) => {
  console.error("Mongo runtime error:", err?.message);
});

// // // app.js
// "use strict";

// const path = require("path");
// require("dotenv").config();

// const express = require("express");
// const helmet = require("helmet");
// const cors = require("cors");
// const rateLimit = require("express-rate-limit");
// const mongoose = require("mongoose");
// const dns = require("dns");

// dns.setDefaultResultOrder("ipv4first");

// const franchiseLocationsRouter = require("./routes/franchiseLocations");
// const adminFranchiseLocationsRouter = require("./routes/adminFranchiseLocations");
// const publicNewsletter = require("./routes/publicNewsletter");
// const bookingsRouter = require("./routes/bookings");
// const offersRouter = require("./routes/offers");
// const adminUsersRouter = require("./routes/adminUsers");
// const customersRouter = require("./routes/customers");
// const bookingActions = require("./routes/bookingActions");
// const adminInvoices = require("./routes/adminInvoices");
// const placesRouter = require("./routes/places");
// const stripePaymentsRouter = require("./routes/payments/stripe");
// const coachesRouter = require("./routes/coaches");
// const { verifySmtp } = require("./utils/mailer");

// const app = express();
// app.set("trust proxy", 1);

// app.use(
//   helmet({
//     crossOriginResourcePolicy: { policy: "cross-origin" },
//   }),
// );

// const allowedOrigins = (
//   process.env.CORS_ORIGIN ||
//   "http://localhost:3000,http://127.0.0.1:3000,http://localhost"
// )
//   .split(",")
//   .map((s) => s.trim())
//   .filter(Boolean);

// app.use(
//   cors({
//     origin: (origin, cb) => {
//       if (!origin) return cb(null, true);
//       if (allowedOrigins.includes(origin)) return cb(null, true);
//       return cb(new Error("Not allowed by CORS: " + origin));
//     },
//     credentials: true,
//   }),
// );

// app.post(
//   "/api/payments/stripe/webhook",
//   express.raw({ type: "application/json" }),
//   stripePaymentsRouter,
// );
// app.use(express.json({ limit: "20mb" }));
// app.use(express.urlencoded({ limit: "20mb", extended: true }));

// app.use("/api/payments/stripe", stripePaymentsRouter);
// app.use("/api/public", require("./routes/publicWeeklyContract"));

// app.use("/api/", rateLimit({ windowMs: 60_000, max: 60 }));

// app.use(
//   "/uploads",
//   express.static(path.join(__dirname, "uploads"), {
//     maxAge: "7d",
//     setHeaders: (res) => {
//       res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
//     },
//   }),
// );

// app.get("/api/ping", (_req, res) => res.json({ ok: true, msg: "API up" }));
// app.get("/api/health", (_req, res) => res.json({ ok: true }));

// app.use("/api/admin/coaches", require("./routes/adminCoaches"));
// app.use("/api/franchise-locations", franchiseLocationsRouter);
// app.use("/api/admin/franchise-locations", adminFranchiseLocationsRouter);
// app.use("/api/coaches", coachesRouter);

// const PORT = Number(process.env.PORT || 5000);
// const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

// if (!MONGO_URI) {
//   console.error("❌ Missing MONGO_URI/MONGODB_URI in .env");
//   process.exit(1);
// }

// mongoose.set("strictQuery", true);

// (async () => {
//   try {
//     await mongoose.connect(MONGO_URI, {
//       serverSelectionTimeoutMS: 10_000,
//       dbName: "test",
//     });

//     console.log("✅ MongoDB connected");

//     const Customer = require("./models/Customer");
//     const Booking = require("./models/Booking");
//     app.locals.models = { Customer, Booking };

//     try {
//       await verifySmtp();
//       console.log("[mailer] SMTP ready");
//     } catch (e) {
//       console.error("[mailer] SMTP verify failed:", e?.message || e);
//     }

//     app.use("/api/upload", require("./routes/upload"));
//     app.use("/api/news", require("./routes/news"));
//     app.use("/api/admin/news", require("./routes/adminNews"));

//     app.use("/api/admin/bookings", require("./routes/adminBookings"));

//     app.use("/api/public", require("./routes/publicBookingEligibility"));

//     app.use("/api/public", publicNewsletter);
//     app.use("/api/bookings", bookingsRouter);
//     app.use("/api/offers", offersRouter);
//     app.use("/api/admin/auth", adminUsersRouter);

//     app.use("/api/customers", customersRouter);
//     app.use("/api/places", placesRouter);
//     app.use("/api/admin/datev", require("./routes/datev"));
//     app.use("/api/admin/revenue", require("./routes/adminRevenue"));
//     app.use(
//       "/api/admin/revenue-derived",
//       require("./routes/adminRevenueDerived"),
//     );

//     app.use("/api/admin/customers", bookingActions);
//     app.use("/api/admin/invoices", adminInvoices);
//     app.use(
//       "/api/admin/invoices",
//       require("./routes/adminInvoices/dunning-search"),
//     );

//     app.use("/api", (_req, res) =>
//       res.status(404).json({ error: "Not Found" }),
//     );

//     app.use((err, _req, res, _next) => {
//       const status = err.status || 500;
//       const payload = {
//         ok: false,
//         error: err.message || "Internal Server Error",
//       };
//       if (process.env.NODE_ENV !== "production") payload.stack = err.stack;
//       if (!res.headersSent) res.status(status).json(payload);
//     });

//     app.listen(PORT, () => {
//       console.log(`🚀 API listening on http://localhost:${PORT}`);
//     });
//   } catch (err) {
//     console.error("❌ Mongo connection error:", err?.message);
//     if (err?.reason) console.error("reason:", err.reason);
//     process.exit(1);
//   }
// })();

// mongoose.connection.on("error", (err) => {
//   console.error("Mongo runtime error:", err?.message);
// });
