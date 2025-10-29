// routes/news.js
'use strict';

const express = require('express');
const router = express.Router();
const News = require('../models/News');





/* ===== Helpers ===== */
const ALLOWED_CATEGORIES = ['Allgemein', 'News', 'Partnerverein', 'Projekte'];

const normCategory = (val) => {
  const v = String(val || '').trim();
  return ALLOWED_CATEGORIES.includes(v) ? v : 'News';
};

const normTags = (arr) =>
  Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean) : [];

// Video-Erkennung fallback (wenn type fehlt/falsch)
const isVideoUrl  = (u='') => /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i.test(String(u));
const isVideoMime = (m='') => /^video\//i.test(String(m));

const normMedia = (arr) =>
  Array.isArray(arr)
    ? arr
        .map((m) => {
          const url  = String(m?.url || '').trim();
          // bevorzugt gelieferten type, sonst per URL/MIME erraten
          const t =
            m?.type === 'video' || isVideoUrl(url) || isVideoMime(m?.mimetype)
              ? 'video'
              : 'image';
          return {
            type: t,
            url,
            alt:   String(m?.alt || ''),
            title: String(m?.title || ''),
          };
        })
        .filter((m) => !!m.url)
    : [];

// Optional: simple auth middleware – ersetze nach Bedarf
function requireProvider(_req, _res, next) {
  next();
}



/* ===== List: GET /api/news?limit=&page=&search=&published=&category=&tag= ===== */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const search = (req.query.search || '').trim();
    const published = req.query.published !== 'false';
    const category = (req.query.category || '').trim();
    const tag = (req.query.tag || '').trim();

    const q = {};
    if (published) q.published = true;
    if (search) {
      q.$or = [
        { title: { $regex: search, $options: 'i' } },
        { excerpt: { $regex: search, $options: 'i' } },
        { content: { $regex: search, $options: 'i' } },
      ];
    }
    if (category) q.category = category;
    if (tag) q.tags = tag;

    const [items, total] = await Promise.all([
      News.find(q)
        .sort({ date: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      News.countDocuments(q),
    ]);

    res.json({ ok: true, items, total, page, pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ===== Taxonomy (MUSS vor /:slug stehen): GET /api/news/taxonomy ===== */
router.get('/taxonomy', async (req, res) => {
  try {
    const published = req.query.published !== 'false';
    const match = {};
    if (published) match.published = true;

    const catsAgg = await News.aggregate([
      { $match: match },
      { $group: { _id: { $ifNull: ['$category', ''] }, count: { $sum: 1 } } },
    ]);

    const tagsAgg = await News.aggregate([
      { $match: match },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 200 },
    ]);

    const catsMap = new Map(catsAgg.map((c) => [String(c._id || ''), c.count]));
    const categories = [];
    for (const name of ALLOWED_CATEGORIES) {
      categories.push({ name, count: Number(catsMap.get(name) || 0) });
      catsMap.delete(name);
    }
    for (const [name, count] of [...catsMap.entries()].sort()) {
      if (name) categories.push({ name, count: Number(count) });
    }

    const tags = tagsAgg.map((t) => ({ name: String(t._id), count: Number(t.count) }));

    res.json({ ok: true, categories, tags });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ===== Detail: GET /api/news/:slug ===== */
router.get('/:slug', async (req, res) => {
  try {
    const item = await News.findOne({ slug: req.params.slug }).lean();
    if (!item) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ===== Create: POST /api/news ===== */
router.post('/', requireProvider, async (req, res) => {
  try {
    const {
      date,
      title,
      slug,
      excerpt,
      content,
      coverImage,
      media,
      published = true,
      category,
      tags,
    } = req.body;

    if (!title || !slug) {
      return res.status(400).json({ ok: false, error: 'title und slug sind erforderlich' });
    }

    const payload = {
      date,
      title: String(title).trim(),
      slug: String(slug).trim(),
      excerpt: String(excerpt || ''),
      content: String(content || ''),
      coverImage: String(coverImage || ''),
      media: normMedia(media),
      published: !!published,
      category: normCategory(category),
      tags: normTags(tags),
    };

    const created = await News.create(payload);
    res.status(201).json({ ok: true, item: created });
  } catch (e) {
    // Duplicate slug?
    if (e?.code === 11000) {
      return res.status(409).json({ ok: false, error: 'Slug bereits vergeben' });
    }
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ===== Update: PATCH /api/news/:id ===== */
router.patch('/:id', requireProvider, async (req, res) => {
  try {
    const body = { ...req.body };

    if ('title' in body) body.title = String(body.title || '').trim();
    if ('slug' in body) body.slug = String(body.slug || '').trim();
    if ('excerpt' in body) body.excerpt = String(body.excerpt || '');
    if ('content' in body) body.content = String(body.content || '');
    if ('coverImage' in body) body.coverImage = String(body.coverImage || '');
    if ('published' in body) body.published = !!body.published;
    if ('category' in body) body.category = normCategory(body.category);
    if ('tags' in body) body.tags = normTags(body.tags);
    if ('media' in body) body.media = normMedia(body.media);

    const updated = await News.findByIdAndUpdate(req.params.id, body, { new: true });
    if (!updated) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, item: updated });
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({ ok: false, error: 'Slug bereits vergeben' });
    }
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ===== Delete: DELETE /api/news/:id ===== */
router.delete('/:id', requireProvider, async (req, res) => {
  try {
    const del = await News.findByIdAndDelete(req.params.id);
    if (!del) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
