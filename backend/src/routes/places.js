const express = require('express');
const pool = require('../db');

const router = express.Router();

// Нормализованные выражения для поиска (в них же построены индексы):
// нижний регистр, «ё» -> «е», дефис -> пробел
const NAME_EXPR = `replace(replace(lower(p.name), 'ё', 'е'), '-', ' ')`;
const BE_EXPR = `replace(replace(lower(coalesce(p.name_be, '')), 'ё', 'е'), '-', ' ')`;

// Подготовка схемы поиска: расширение pg_trgm, колонка name_be и индексы.
// Выполняется один раз при первом обращении, ручных миграций не требуется.
let schemaReady = null;

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      let trgm = true;
      try {
        await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      } catch (e) {
        console.warn('pg_trgm недоступен, поиск без учёта опечаток:', e.message);
        trgm = false;
        schemaReady = null; // повторим попытку при следующем запросе
      }
      try {
        await pool.query('ALTER TABLE places ADD COLUMN IF NOT EXISTS name_be TEXT');
        if (trgm) {
          await pool.query(
            `CREATE INDEX IF NOT EXISTS places_name_trgm_idx ON places USING GIN
             ((${NAME_EXPR.replace(/p\./g, '')}) gin_trgm_ops)`
          );
          await pool.query(
            `CREATE INDEX IF NOT EXISTS places_name_be_trgm_idx ON places USING GIN
             ((${BE_EXPR.replace(/p\./g, '')}) gin_trgm_ops)`
          );
        }
      } catch (e) {
        console.warn('Подготовка схемы поиска:', e.message);
        schemaReady = null;
      }
      return { trgm };
    })();
  }
  return schemaReady;
}

ensureSchema().catch(() => {});

function normalizeQuery(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/-/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

// GET /api/v1/places?category=sight&bbox=minLng,minLat,maxLng,maxLat
router.get('/', async (req, res, next) => {
  try {
    const { category, bbox } = req.query;
    const params = [];
    const where = [];

    if (category) {
      params.push(category);
      where.push(`c.slug = $${params.length}`);
    }

    if (bbox) {
      const b = String(bbox).split(',').map(Number);
      if (b.length !== 4 || b.some(Number.isNaN)) {
        return res.status(400).json({ error: 'bbox: minLng,minLat,maxLng,maxLat' });
      }
      const s = params.length;
      params.push(...b);
      where.push(
        `p.geom && ST_MakeEnvelope($${s + 1}, $${s + 2}, $${s + 3}, $${s + 4}, 4326)`
      );
    }

    const sql = `
      SELECT p.id, p.name, p.description, c.slug AS category,
             ST_Y(p.geom) AS lat, ST_X(p.geom) AS lng
      FROM places p
      LEFT JOIN categories c ON c.id = p.category_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.id
      LIMIT 1000`;

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT slug, name FROM categories ORDER BY id');
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/places/search?q=дом музей&category=&bbox=&lat=&lng=&limit=10
// Все слова запроса должны встретиться в русском или белорусском названии
// (в любом порядке, часть слова допустима, мелкие опечатки прощаются).
router.get('/search', async (req, res, next) => {
  try {
    const nq = normalizeQuery(req.query.q);
    if (nq.length < 2) return res.json([]);

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 20);
    const { trgm } = await ensureSchema();

    const params = [];
    const add = (v) => {
      params.push(v);
      return '$' + params.length;
    };

    const tokens = nq.split(' ').slice(0, 6);
    const refs = tokens.map((t) => ({
      like: add('%' + escapeLike(t) + '%'),
      raw: trgm && t.length >= 4 ? add(t) : null,
    }));

    const cond = (expr) =>
      '(' +
      refs
        .map((t) => {
          const parts = [`${expr} LIKE ${t.like}`];
          if (t.raw) parts.push(`${t.raw}::text <% ${expr}`);
          return '(' + parts.join(' OR ') + ')';
        })
        .join(' AND ') +
      ')';

    const qExact = add(nq);
    const qPrefix = add(escapeLike(nq) + '%');
    const qContains = add('%' + escapeLike(nq) + '%');

    const where = [`(${cond(NAME_EXPR)} OR ${cond(BE_EXPR)})`];

    if (req.query.category) {
      where.push(`c.slug = ${add(String(req.query.category))}`);
    }

    if (req.query.bbox) {
      const b = String(req.query.bbox).split(',').map(Number);
      if (b.length !== 4 || b.some(Number.isNaN)) {
        return res.status(400).json({ error: 'bbox: minLng,minLat,maxLng,maxLat' });
      }
      const refsB = b.map((v) => add(v));
      where.push(`p.geom && ST_MakeEnvelope(${refsB.join(', ')}, 4326)`);
    }

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    let distOrder = '';
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      distOrder = `p.geom <-> ST_SetSRID(ST_MakePoint(${add(lng)}, ${add(lat)}), 4326),`;
    }

    const sql = `
      SELECT p.id, p.name, p.name_be, p.description, c.slug AS category,
             ST_Y(p.geom) AS lat, ST_X(p.geom) AS lng,
             CASE WHEN ${NAME_EXPR} = ${qExact} THEN 0
                  WHEN ${NAME_EXPR} LIKE ${qPrefix} THEN 1
                  WHEN ${NAME_EXPR} LIKE ${qContains} THEN 2
                  ELSE 3 END AS match_rank,
             ${trgm ? `similarity(${NAME_EXPR}, ${qExact})` : '0'} AS match_sim
      FROM places p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY match_rank, match_sim DESC, ${distOrder} length(p.name), p.id
      LIMIT ${limit}`;

    const { rows } = await pool.query(sql, params);
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        name_be: r.name_be,
        description: r.description,
        category: r.category,
        lat: r.lat,
        lng: r.lng,
      }))
    );
  } catch (e) {
    next(e);
  }
});

module.exports = router;
