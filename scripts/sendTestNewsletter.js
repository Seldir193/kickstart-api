#!/usr/bin/env node
/**
 * sendTestNewsletter.js
 *
 * Nutzung:
 *   node scripts/sendTestNewsletter.js EMPFAENGER@MAIL "Betreff optional" "Name optional"
 *
 * - Lädt HTML-Template (templates/newsletter-herbst.html) oder Fallback
 * - Ersetzt Platzhalter (Brand, Social, CTA, usw.)
 * - Baut Abmelde-Link im neuen Format: /unsubscribe?e=<email>&t=<hmac(email, SECRET)>
 * - Fügt List-Unsubscribe Header hinzu
 * - Fügt "Newsletter abmelden" Block ein, wenn {{unsubscribe.url}} im Template fehlt
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/* ---------- Helpers ---------- */
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const toBool = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const fileExists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/* ---------- CLI Args ---------- */
const TO = process.argv[2];
const SUBJECT = process.argv[3] || 'Newsletter: Herbstferien Powertraining';
const GREETING = process.argv[4] || 'Sportfreund/in';

if (!TO) {
  console.error('❌ Bitte Empfänger angeben:');
  console.error('   node scripts/sendTestNewsletter.js empfaenger@example.com "Betreff" "Name"');
  process.exit(2);
}

/* ---------- SMTP Transport ---------- */
const transporter = nodemailer.createTransport({
  host: env('SMTP_HOST'),
  port: Number(env('SMTP_PORT', '587')),
  secure: toBool(env('SMTP_SECURE', 'false')), // true = 465
  auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
});

/* ---------- HMAC (für e+t Links) ---------- */
const PUBLIC_API_BASE = env('PUBLIC_API_BASE', 'http://127.0.0.1:5000').replace(/\/+$/, '');
const SECRET = env('NEWSLETTER_SECRET');
if (!SECRET) {
  console.error('❌ NEWSLETTER_SECRET fehlt in .env');
  process.exit(2);
}
function hmacEmail(emailLower) {
  return crypto.createHmac('sha256', SECRET).update(emailLower).digest('hex');
}
function buildUnsubUrl(toEmail) {
  const e = String(toEmail || '').trim().toLowerCase();
  const t = hmacEmail(e);
  return `${PUBLIC_API_BASE}/api/public/newsletter/unsubscribe?e=${encodeURIComponent(e)}&t=${t}`;
}

/* ---------- Icons / Attachments ---------- */
const attachments = [];
function pushCidAttachment(cid, filePath, filename) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      attachments.push({ filename: filename || path.basename(filePath), path: filePath, cid });
    } else {
      console.warn('[newsletter] Icon fehlt:', filePath);
    }
  } catch (e) {
    console.warn('[newsletter] Icon check error:', filePath, e);
  }
}
const ICONS_DIR = path.resolve(__dirname, '..', 'assets', 'email-icons');
const firstExisting = (...names) => {
  for (const n of names) {
    const p = path.join(ICONS_DIR, n);
    if (fileExists(p)) return p;
  }
  return null;
};
pushCidAttachment('icon-facebook',  firstExisting('facebook.png', 'facebock.png'));
pushCidAttachment('icon-instagram', firstExisting('instagram.png'));
pushCidAttachment('icon-tiktok',    firstExisting('tiktok.png'));
pushCidAttachment('icon-youtube',   firstExisting('youtube.png'));

/* ---------- Template laden ---------- */
const templatePath = path.join(__dirname, '..', 'templates', 'newsletter-herbst.html');
let html;
const FALLBACK_HTML = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Herbstferien Powertraining</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin:0; padding:0; background:#f5f7fb; font-family: Arial, Helvetica, sans-serif; color:#111827; }
    .container { max-width:640px; margin:0 auto; background:#ffffff; }
    .header { background:#3e6294; color:#fff; padding:12px 24px; }
    .header td { vertical-align: middle; }
    .logo { max-width:120px; height:auto; display:block; }
    .brand { font-size:20px; font-weight:700; text-align:center; }
    .section { padding:16px 24px; }
    .h1 { font-size:22px; font-weight:700; margin:0 0 8px 0; }
    .h2 { font-size:18px; font-weight:700; margin:16px 0 6px 0; }
    .p  { font-size:14px; line-height:22px; margin:0 0 8px 0; }
    .li { font-size:14px; line-height:22px; }
    .btn-wrap { text-align:center; padding:16px 24px 24px; }
    .btn {
      display:inline-block; text-decoration:none;
      padding:12px 18px; border-radius:6px;
      background:#3e6294; color:#ffffff; font-weight:700;
    }
    .divider { border-top:1px solid #e5e7eb; margin:0; }
    .footer { background:#f1f5f9; text-align:center; color:#6b7280; padding:12px 24px 16px; font-size:13px; line-height:20px; }
    .social { text-align:center; font-size:14px; line-height:22px; padding:8px 24px 0; }
    .social a { color:#0f172a; text-decoration:none; margin:0 6px; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td>
        <div class="container">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="header">
            <tr>
              <td width="140">
                <img src="{{brand.logoUrl}}" alt="{{brand.company}}" class="logo">
              </td>
              <td>
                <div class="brand">{{brand.company}}</div>
              </td>
            </tr>
          </table>

          <hr class="divider">

          <div class="section">
            <p class="p">Hallo {{greetingName}},</p>
            <p class="p">gute Neuigkeiten! In den Herbstferien bieten wir ein kompaktes, intensives Powertraining an – perfekt, um Technik, Koordination und Spielfreude zu pushen.</p>
          </div>

          <div class="section">
            <h1 class="h1">Herbstferien Powertraining</h1>
            <p class="p"><strong>Termin:</strong> 13.10. – 17.10.2025</p>
            <p class="p"><strong>Uhrzeit:</strong> täglich 10:00 – 12:00 Uhr</p>
            <p class="p"><strong>Preis:</strong> 35 € pro Tag</p>
            <p class="p"><strong>Ort:</strong> {{event.location}}</p>

            <h2 class="h2">Was dich erwartet</h2>
            <ul style="padding-left:18px; margin:8px 0;">
              <li class="li">Technikschulung (Dribbling, Passspiel, Ballannahme)</li>
              <li class="li">Koordination &amp; Schnelligkeit</li>
              <li class="li">Kleine Spielformen &amp; Wettkämpfe</li>
              <li class="li">Motivierendes Feedback vom Trainer-Team</li>
            </ul>
          </div>

          <div class="btn-wrap">
            <a href="{{cta.url}}" class="btn" target="_blank" rel="noopener">Jetzt Platz sichern</a>
          </div>

          <hr class="divider">

          <div class="section">
            <p class="p"><strong>Fragen?</strong> Schreib uns jederzeit:</p>
            <p class="p">
              <a href="mailto:{{brand.email}}" style="color:#0f172a; text-decoration:none;">{{brand.email}}</a>
              &nbsp;•&nbsp;
              <a href="{{brand.website}}" style="color:#0f172a; text-decoration:none;">{{brand.website}}</a>
            </p>
          </div>

          <div class="section">
            <p class="p">{{signature.signoff}},<br>{{signature.name}}<br><strong>Dein Trainer-Team</strong></p>
          </div>

          <div class="section" style="padding-top:8px; text-align:center;">
            <a href="{{social.facebook}}" target="_blank" rel="noopener" style="display:inline-block; margin:0 6px;">
              <img src="cid:icon-facebook" width="22" height="22" alt="Facebook" style="display:inline-block; border:0; vertical-align:middle;">
            </a>
            <a href="{{social.instagram}}" target="_blank" rel="noopener" style="display:inline-block; margin:0 6px;">
              <img src="cid:icon-instagram" width="22" height="22" alt="Instagram" style="display:inline-block; border:0; vertical-align:middle;">
            </a>
            <a href="{{social.tiktok}}" target="_blank" rel="noopener" style="display:inline-block; margin:0 6px;">
              <img src="cid:icon-tiktok" width="22" height="22" alt="TikTok" style="display:inline-block; border:0; vertical-align:middle;">
            </a>
            <a href="{{social.youtube}}" target="_blank" rel="noopener" style="display:inline-block; margin:0 6px;">
              <img src="cid:icon-youtube" width="22" height="22" alt="YouTube" style="display:inline-block; border:0; vertical-align:middle;">
            </a>
          </div>

          <div class="footer">
            <div>© 2025, {{brand.company}} – alle Rechte vorbehalten.</div>
            <div>{{brand.addr1}}<br>{{brand.addr2}}</div>
            <div><a href="mailto:{{brand.email}}">{{brand.email}}</a></div>
            <div><a href="{{brand.website}}" target="_blank" rel="noopener">{{brand.website}}</a></div>
          </div>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;

if (fileExists(templatePath)) {
  html = fs.readFileSync(templatePath, 'utf8');
  console.log('ℹ️  Template geladen:', path.relative(process.cwd(), templatePath));
} else {
  html = FALLBACK_HTML;
  console.warn('⚠️  Template nicht gefunden, verwende Fallback-HTML:', path.relative(process.cwd(), templatePath));
}

/* ---------- Logo ggf. als CID ---------- */
const brandLogoUrlEnv  = env('BRAND_LOGO_URL');
const brandLogoPathEnv = env('BRAND_LOGO_PATH');
let useCidLogo = false;
if (!brandLogoUrlEnv && brandLogoPathEnv) {
  const absLogoPath = path.resolve(path.join(__dirname, '..', brandLogoPathEnv));
  if (fileExists(absLogoPath)) {
    useCidLogo = true;
    attachments.push({ filename: path.basename(absLogoPath), path: absLogoPath, cid: 'brandlogo@cid' });
  }
}

/* ---------- Main send ---------- */
(async () => {
  try {
    await transporter.verify();

    const unsubUrl = buildUnsubUrl(TO);

    // Platzhalter ersetzen
    const replacements = {
      '{{brand.logoUrl}}': useCidLogo ? 'cid:brandlogo@cid' : (brandLogoUrlEnv || ''),
      '{{brand.company}}': env('BRAND_COMPANY'),
      '{{brand.email}}':   env('BRAND_EMAIL'),
      '{{brand.addr1}}':   env('BRAND_ADDR_LINE1'),
      '{{brand.addr2}}':   env('BRAND_ADDR_LINE2'),
      '{{brand.website}}': env('BRAND_WEBSITE_URL'),
      '{{signature.signoff}}': env('MAIL_SIGNOFF', 'Mit sportlichen Grüßen'),
      '{{signature.name}}':   env('MAIL_SIGNER', 'Team'),
      '{{event.location}}':   env('NEWSLETTER_EVENT_LOCATION', 'Trainingszentrum'),
      '{{greetingName}}': GREETING,
      '{{cta.url}}': env('NEWSLETTER_CTA_URL', env('BRAND_WEBSITE_URL') || '#'),
      '{{social.facebook}}':  env('SOCIAL_FACEBOOK_URL', 'https://www.facebook.com/muenchner.fussball.schule.ruhr'),
      '{{social.instagram}}': env('SOCIAL_INSTAGRAM_URL', 'https://www.instagram.com/mfs_fussballtraining_nrw/?hl=de'),
      '{{social.tiktok}}':    env('SOCIAL_TIKTOK_URL', 'https://www.tiktok.com/@mfs_fussballtraining_nrw?'),
      '{{social.youtube}}':   env('SOCIAL_YOUTUBE_URL', 'https://www.youtube.com/channel/UCuc5Z8ExCPkXIgW_62WOCUA'),
      '{{unsubscribe.url}}':  unsubUrl,
    };
    for (const [needle, value] of Object.entries(replacements)) {
      html = html.split(needle).join(value || '');
    }

    // Wenn das Template KEINEN {{unsubscribe.url}} enthält, Block automatisch ergänzen:
    if (!/\{\{\s*unsubscribe\.url\s*\}\}/.test(html) && !html.includes(unsubUrl)) {
      const block = `\n<div style="text-align:center; font-size:12px; color:#6b7280; padding:12px 24px;">
  <a href="${unsubUrl}" target="_blank" rel="noopener" style="color:#0f172a; text-decoration:none;">Newsletter abmelden</a>
</div>\n`;
      html = html.replace(/<\/body>\s*<\/html>\s*$/i, `${block}</body></html>`);
    }

    const fromHeader = env('FROM_EMAIL') || `${env('BRAND_COMPANY') || 'KickStart Academy'} <${env('SMTP_USER')}>`;
    const bcc = env('MAIL_BCC');
    const mail = {
      from: fromHeader,
      to: TO,
      subject: SUBJECT,
      html,
      attachments,
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
    if (bcc) mail.bcc = bcc;

    const info = await transporter.sendMail(mail);
    console.log('✅ Newsletter versendet!');
    console.log('   An:', TO);
    console.log('   Betreff:', SUBJECT);
    if (info.messageId) console.log('   Message-ID:', info.messageId);
    process.exit(0);
  } catch (err) {
    console.error('❌ Versand fehlgeschlagen:', err);
    process.exit(1);
  }
})();









