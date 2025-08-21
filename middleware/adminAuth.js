// middleware/adminAuth.js
module.exports = function adminAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const email = decoded.slice(0, sep);
  const pass  = decoded.slice(sep + 1);

  // .env robust lesen (Trim + Anführungszeichen entfernen)
  const sanitize = (s) => (s || '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  const envEmail = sanitize(process.env.ADMIN_EMAIL);
  const envPass  = sanitize(process.env.ADMIN_PASSWORD);

  if (email === envEmail && pass === envPass) {
    return next();
  }

  console.warn('adminAuth denied:', { incomingEmail: email, expectedEmail: envEmail });
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
};

