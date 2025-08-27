// middleware/adminAuth.js
// Akzeptiert:
// 1) Basic (ENV-Admin)  -> req.isSuperAdmin = true
// 2) X-Provider-Id      -> req.providerId = <id>

module.exports = function adminAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';

    // --- 1) Basic (ENV Admin) wie bisher ---
    if (auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const email = decoded.slice(0, sep);
      const pass  = decoded.slice(sep + 1);

      // .env robust lesen (Trim + Anführungszeichen entfernen)
      const sanitize = (s) => (s || '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      const envEmail = sanitize(process.env.ADMIN_EMAIL);
      const envPass  = sanitize(process.env.ADMIN_PASSWORD);

      if (email === envEmail && pass === envPass && envEmail && envPass) {
        req.isSuperAdmin = true;
        return next();
      }
    }

    // --- 2) Provider-ID aus Header (von Next-Proxys gesetzt) ---
    const pid = (req.get('x-provider-id') || '').trim();
    if (pid) {
      req.providerId = pid;
      return next();
    }

    // nichts gepasst
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: 'Auth middleware crashed',
      detail: String(e?.message || e),
    });
  }
};
