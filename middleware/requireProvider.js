// middleware/requireProvider.js
module.exports = function requireProvider(req, res, next) {
  // bevorzugt: von adminAuth gesetztes req.providerId
  const pid = (req.providerId || req.get('x-provider-id') || '').trim();
  if (!pid) return res.status(401).json({ ok: false, error: 'Unauthorized: missing provider' });
  req.providerId = pid; // normalisieren
  next();
};
