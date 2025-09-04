// utils/mjmlRenderer.js
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

// ---- robuste Auflösung des mjml-Exports (ESM/CJS) ----
let mjml2html;
try {
  const mjmlLib = require('mjml'); // kann Funktion ODER Objekt sein
  mjml2html =
    (typeof mjmlLib === 'function') ? mjmlLib :
    (typeof mjmlLib?.default === 'function') ? mjmlLib.default :
    (typeof mjmlLib?.mjml2html === 'function') ? mjmlLib.mjml2html :
    null;

  if (!mjml2html) {
    throw new Error('Konnte mjml2html nicht im "mjml"-Modul finden');
  }
} catch (e) {
  // Fallback: sehr alte/ungewöhnliche Builds
  try {
    mjml2html = require('mjml/lib/mjml');
  } catch {
    console.error('[mjmlRenderer] mjml Import-Fehler:', e?.message || e);
    throw e;
  }
}

function renderMjmlFile(filePath, data = {}) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, 'utf8');

  // Struktur bleibt stabil – nur Inhalte/Attribute via Handlebars einsetzen
  const tpl = Handlebars.compile(raw, { noEscape: true });
  const filled = tpl(data);

  try {
    const { html, errors } = mjml2html(filled, {
      validationLevel: 'soft',
      keepComments: false,
      minify: false,
    });
    if (errors?.length) {
      console.warn('[mjmlRenderer] MJML warnings:', errors);
    }
    return html || '';
  } catch (err) {
    console.error('[mjmlRenderer] MJML failed:', err?.message || err);
    console.error('----- FILLED MJML START -----\n' + filled + '\n----- FILLED MJML END -----');
    throw err;
  }
}

module.exports = { renderMjmlFile };
