// routes/upload.js
'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const router = express.Router();

// Upload-Verzeichnis sicherstellen
const UP = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UP, { recursive: true });

// Multer-Storage
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UP),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = path
      .basename(file.originalname || 'upload', ext)
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .toLowerCase();
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});

// Multer-Instance
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
  

    // Erlaubt: alle Bilder + NUR MP4/WebM (verhindert .mov)
    const isImage = /^image\//.test(file.mimetype || '');
    const isVideo = /^(video\/mp4|video\/webm)$/.test(file.mimetype || '');
    if (!(isImage || isVideo)) {
      return cb(new Error('Nur Bilder, MP4 oder WebM erlaubt'), false);
    }
    cb(null, true);
  },
});

// Hilfsfunktion: Basis-URL ermitteln (ohne trailing slash)
function getBaseUrl() {
  const envBase =
    process.env.PUBLIC_BASE_URL ||
    process.env.PUBLIC_API_BASE ||
    `http://localhost:${process.env.PORT || 5000}`;
  return String(envBase).replace(/\/+$/, '');
}

router.post('/', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Keine Datei übermittelt (field: "file")' });
    }
    const base = getBaseUrl();
    const url = `${base}/uploads/${encodeURIComponent(req.file.filename)}`;
    return res.json({
      ok: true,
      url,
      mimetype: req.file.mimetype,
      size: req.file.size,
      filename: req.file.filename,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'Upload fehlgeschlagen' });
  }
});

// Multer-/Route-Fehler sauber als JSON ausgeben
router.use((err, _req, res, _next) => {
  const msg = err?.message || 'Upload-Fehler';
  res.status(400).json({ ok: false, error: msg });
});

module.exports = router;









