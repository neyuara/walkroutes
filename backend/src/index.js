const express = require('express');
const crypto = require('crypto');
const path = require('path');
const pool = require('./db');
const placesRouter = require('./routes/places');
const routesRouter = require('./routes/routes');

const app = express();
app.use(express.json({ limit: '100kb' }));

// ====================== Админ-панель: настройки ======================
// Логин и пароль по умолчанию: admin / admin.
// Для реального сервера обязательно задай ADMIN_USER, ADMIN_PASSWORD и ADMIN_SECRET.
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_S = 8 * 3600;
const COOKIE_NAME = 'walkroutes_admin';

if (ADMIN_USER === 'admin' && ADMIN_PASSWORD === 'admin') {
  console.warn('ВНИМАНИЕ: используется логин и пароль админки по умолчанию (admin / admin)');
}

// ---------- Сессия: подписанный токен в httpOnly-cookie ----------
function sign(data) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
}

function makeToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ u: user, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S })
  ).toString('base64url');
  return payload + '.' + sign(payload);
}

function readToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() / 1000 ? data : null;
  } catch (e) {
    return null;
  }
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, token, maxAge) {
  res.setHeader(
    'Set-Cookie',
    COOKIE_NAME + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + maxAge +
      (isHttps(req) ? '; Secure' : '')
  );
}

function requireAdmin(req, res, next) {
  const data = readToken(getCookie(req, COOKIE_NAME));
  if (!data) return res.status(401).json({ error: 'Требуется вход' });
  req.admin = data.u;
  next();
}

// ---------- Ограничение попыток входа (5 неудачных за 15 минут с одного адреса) ----------
const failedLogins = new Map();
const WINDOW_MS = 15 * 60 * 1000;

function loginBlocked(ip) {
  const r = failedLogins.get(ip);
  if (!r) return false;
  if (Date.now() - r.first > WINDOW_MS) {
    failedLogins.delete(ip);
    return false;
  }
  return r.count >= 5;
}

function registerFail(ip) {
  const r = failedLogins.get(ip);
  if (!r || Date.now() - r.first > WINDOW_MS) failedLogins.set(ip, { count: 1, first: Date.now() });
  else r.count++;
}

app.post('/api/v1/auth/login', (req, res) => {
  const ip = req.ip;
  if (loginBlocked(ip)) {
    return res.status(429).json({ error: 'Слишком много попыток входа. Попробуй через 15 минут' });
  }
  const { username, password } = req.body || {};
  const okUser = safeEqual(username ?? '', ADMIN_USER);
  const okPass = safeEqual(password ?? '', ADMIN_PASSWORD);
  if (!(okUser && okPass)) {
    registerFail(ip);
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  failedLogins.delete(ip);
  setSessionCookie(req, res, makeToken(ADMIN_USER), SESSION_TTL_S);
  res.json({ ok: true });
});

app.post('/api/v1/auth/logout', (req, res) => {
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.get('/api/v1/auth/me', requireAdmin, (req, res) => res.json({ user: req.admin }));

// ====================== Админ-панель: API ======================
const admin = express.Router();
admin.use(requireAdmin);

// Колонки, которые нужны админке (если их ещё нет в таблице places)
let adminSchema = null;
function ensureAdminSchema() {
  if (!adminSchema) {
    adminSchema = pool
      .query(
        `ALTER TABLE places
           ADD COLUMN IF NOT EXISTS name_be TEXT,
           ADD COLUMN IF NOT EXISTS website TEXT,
           ADD COLUMN IF NOT EXISTS image TEXT,
           ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'`
      )
      .catch((e) => {
        adminSchema = null;
        throw e;
      });
  }
  return adminSchema;
}

admin.use(async (req, res, next) => {
  try {
    await ensureAdminSchema();
    next();
  } catch (e) {
    next(e);
  }
});

const toInt = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

const PLACE_SELECT = `
  SELECT p.id, p.name, p.name_be, p.description, p.category_id,
         c.slug AS category, c.name AS category_name,
         p.website, p.image, p.source,
         ST_Y(p.geom) AS lat, ST_X(p.geom) AS lng
  FROM places p
  LEFT JOIN categories c ON c.id = p.category_id`;

// Разбор и проверка данных места. partial = true для PATCH.
function parsePlace(body, partial) {
  const b = body || {};
  const d = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

  if (!partial || has('name')) {
    const v = str(b.name);
    if (v.length < 2 || v.length > 200) return { error: 'Название: от 2 до 200 символов' };
    d.name = v;
  }
  for (const [key, max] of [['name_be', 200], ['website', 500], ['image', 500], ['description', 2000]]) {
    if (has(key)) {
      const v = str(b[key]);
      if (v.length > max) return { error: 'Поле «' + key + '» слишком длинное (максимум ' + max + ')' };
      d[key] = v || null;
    }
  }
  if (!partial || has('category_id')) {
    const v = toInt(b.category_id);
    if (v === null) return { error: 'Выбери категорию' };
    d.category_id = v;
  }
  if (!partial || has('lat') || has('lng')) {
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    if (b.lat === '' || b.lng === '' || b.lat == null || b.lng == null ||
        Number.isNaN(lat) || Number.isNaN(lng)) {
      return { error: 'Укажи широту и долготу числами' };
    }
    if (lat < 51 || lat > 57 || lng < 23 || lng > 33) {
      return { error: 'Координаты вне территории Беларуси (широта 51–57, долгота 23–33)' };
    }
    d.lat = lat;
    d.lng = lng;
  }
  return { data: d };
}

function dbError(e, res, next) {
  if (e.code === '23505') return res.status(409).json({ error: 'Такая запись уже существует' });
  if (e.code === '23503') {
    return res.status(409).json({ error: 'Запись используется в других данных, удалить нельзя' });
  }
  next(e);
}

// ---------- Места ----------
admin.get('/places', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const params = [];
    const where = [];

    const q = String(req.query.q || '').trim();
    if (q) {
      params.push('%' + escapeLike(q) + '%');
      where.push(`(p.name ILIKE $${params.length} OR p.name_be ILIKE $${params.length})`);
    }
    if (req.query.category) {
      params.push(String(req.query.category));
      where.push(`c.slug = $${params.length}`);
    }
    if (req.query.source) {
      params.push(String(req.query.source));
      where.push(`p.source = $${params.length}`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = await pool.query(
      `SELECT count(*)::int AS n FROM places p LEFT JOIN categories c ON c.id = p.category_id ${whereSql}`,
      params
    );
    const { rows } = await pool.query(
      `${PLACE_SELECT} ${whereSql} ORDER BY p.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    );
    res.json({ items: rows, total: total.rows[0].n, page, pageSize });
  } catch (e) {
    next(e);
  }
});

admin.post('/places', async (req, res, next) => {
  try {
    const { data, error } = parsePlace(req.body, false);
    if (error) return res.status(400).json({ error });

    const cat = await pool.query('SELECT 1 FROM categories WHERE id = $1', [data.category_id]);
    if (!cat.rowCount) return res.status(400).json({ error: 'Такой категории нет' });

    const dup = await pool.query(
      `SELECT 1 FROM places
       WHERE lower(name) = lower($1)
         AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 50)
       LIMIT 1`,
      [data.name, data.lng, data.lat]
    );
    if (dup.rowCount) {
      return res.status(409).json({ error: 'Место с таким названием уже есть рядом (в радиусе 50 м)' });
    }

    const ins = await pool.query(
      `INSERT INTO places (name, name_be, description, category_id, geom, website, image, source)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326), $7, $8, 'manual')
       RETURNING id`,
      [data.name, data.name_be ?? null, data.description ?? null, data.category_id,
       data.lng, data.lat, data.website ?? null, data.image ?? null]
    );
    const { rows } = await pool.query(`${PLACE_SELECT} WHERE p.id = $1`, [ins.rows[0].id]);
    res.status(201).json(rows[0]);
  } catch (e) {
    dbError(e, res, next);
  }
});

admin.patch('/places/:id', async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Некорректный id' });

    const { data, error } = parsePlace(req.body, true);
    if (error) return res.status(400).json({ error });

    if ('category_id' in data) {
      const cat = await pool.query('SELECT 1 FROM categories WHERE id = $1', [data.category_id]);
      if (!cat.rowCount) return res.status(400).json({ error: 'Такой категории нет' });
    }

    const sets = [];
    const vals = [];
    const add = (v) => {
      vals.push(v);
      return '$' + vals.length;
    };
    for (const key of ['name', 'name_be', 'description', 'category_id', 'website', 'image']) {
      if (key in data) sets.push(`${key} = ${add(data[key])}`);
    }
    if ('lat' in data) {
      sets.push(`geom = ST_SetSRID(ST_MakePoint(${add(data.lng)}, ${add(data.lat)}), 4326)`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Нет данных для обновления' });

    const upd = await pool.query(
      `UPDATE places SET ${sets.join(', ')} WHERE id = ${add(id)} RETURNING id`,
      vals
    );
    if (!upd.rowCount) return res.status(404).json({ error: 'Место не найдено' });

    const { rows } = await pool.query(`${PLACE_SELECT} WHERE p.id = $1`, [id]);
    res.json(rows[0]);
  } catch (e) {
    dbError(e, res, next);
  }
});

admin.delete('/places/:id', async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Некорректный id' });
    const del = await pool.query('DELETE FROM places WHERE id = $1 RETURNING id', [id]);
    if (!del.rowCount) return res.status(404).json({ error: 'Место не найдено' });
    res.json({ ok: true });
  } catch (e) {
    dbError(e, res, next);
  }
});

// ---------- Категории ----------
admin.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.slug, c.name, count(p.id)::int AS places
       FROM categories c LEFT JOIN places p ON p.category_id = c.id
       GROUP BY c.id ORDER BY c.id`
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

admin.post('/categories', async (req, res, next) => {
  try {
    const slug = String((req.body || {}).slug || '').trim().toLowerCase();
    const name = String((req.body || {}).name || '').trim();
    if (!/^[a-z0-9_-]{2,30}$/.test(slug)) {
      return res.status(400).json({ error: 'Код: 2–30 символов, латиница, цифры, - и _' });
    }
    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ error: 'Название: от 2 до 100 символов' });
    }
    const { rows } = await pool.query(
      'INSERT INTO categories (slug, name) VALUES ($1, $2) RETURNING id, slug, name',
      [slug, name]
    );
    res.status(201).json({ ...rows[0], places: 0 });
  } catch (e) {
    dbError(e, res, next);
  }
});

// Код категории после создания не меняется, редактируется только название
admin.patch('/categories/:id', async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Некорректный id' });
    const name = String((req.body || {}).name || '').trim();
    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ error: 'Название: от 2 до 100 символов' });
    }
    const { rows } = await pool.query(
      'UPDATE categories SET name = $1 WHERE id = $2 RETURNING id, slug, name',
      [name, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Категория не найдена' });
    res.json(rows[0]);
  } catch (e) {
    dbError(e, res, next);
  }
});

admin.delete('/categories/:id', async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Некорректный id' });
    const used = await pool.query('SELECT count(*)::int AS n FROM places WHERE category_id = $1', [id]);
    if (used.rows[0].n > 0) {
      return res.status(409).json({ error: 'Нельзя удалить категорию, к которой привязаны места' });
    }
    const del = await pool.query('DELETE FROM categories WHERE id = $1 RETURNING id', [id]);
    if (!del.rowCount) return res.status(404).json({ error: 'Категория не найдена' });
    res.json({ ok: true });
  } catch (e) {
    dbError(e, res, next);
  }
});

// ====================== Основные маршруты ======================
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/v1/admin', admin);
app.use('/api/v1/places', placesRouter);
app.use('/api/v1/routes', routesRouter);

app.get(['/admin', '/admin/'], (req, res) => {
  res.set({
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
  });
  res.type('html').send(ADMIN_HTML);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ====================== Страница админ-панели ======================
const ADMIN_HTML = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WalkRoutes — админ-панель</title>
<link rel="icon" href="data:,">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #111827; background: #f3f4f6; }
  .muted { color: #6b7280; font-size: 13px; }
  .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .login { background: #fff; padding: 28px; border-radius: 14px; width: 320px; box-shadow: 0 8px 30px rgba(0,0,0,.1); display: flex; flex-direction: column; gap: 10px; }
  .login h1 { margin: 0; font-size: 22px; }
  .login p { margin: 0 0 6px; }
  input, select, textarea { padding: 9px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; font-family: inherit; background: #fff; width: 100%; }
  textarea { min-height: 80px; resize: vertical; }
  .btn { padding: 9px 14px; border: 0; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; background: #e5e7eb; color: #111827; }
  .btn:hover { background: #d1d5db; }
  .btn.primary { background: #2563eb; color: #fff; }
  .btn.primary:hover { background: #1d4ed8; }
  .btn.danger { background: #fee2e2; color: #b91c1c; }
  .btn.danger:hover { background: #fecaca; }
  .btn.small { padding: 5px 10px; font-size: 13px; }
  .err { color: #b91c1c; font-size: 13px; min-height: 16px; }
  header { background: #fff; border-bottom: 1px solid #e5e7eb; padding: 12px 20px; display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  header .brand { font-weight: 800; font-size: 18px; }
  .tabs { display: flex; gap: 6px; }
  .tab { padding: 7px 14px; border-radius: 8px; border: 0; background: none; cursor: pointer; font-size: 14px; font-weight: 600; color: #4b5563; }
  .tab.active { background: #eff6ff; color: #1d4ed8; }
  .spacer { flex: 1; }
  header a { color: #2563eb; font-size: 14px; text-decoration: none; }
  main { max-width: 1200px; margin: 0 auto; padding: 20px; }
  .toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; align-items: center; }
  .toolbar input[type=text] { width: 260px; }
  .toolbar select { width: 200px; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #f0f1f3; vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; background: #fafafa; }
  td.actions { white-space: nowrap; display: flex; gap: 6px; }
  .pager { display: flex; gap: 10px; align-items: center; padding: 12px; justify-content: flex-end; }
  .overlay { position: fixed; inset: 0; background: rgba(17,24,39,.5); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 50; }
  .modal { background: #fff; border-radius: 14px; width: 560px; max-width: 100%; max-height: 92vh; overflow-y: auto; padding: 22px; }
  .modal h2 { margin: 0 0 14px; font-size: 18px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  .modal .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 100; display: flex; flex-direction: column; gap: 8px; }
  .toast { background: #111827; color: #fff; padding: 10px 16px; border-radius: 10px; font-size: 14px; }
  .toast.error { background: #b91c1c; }
</style>
</head>
<body>
<div id="app"></div>
<div id="toast"></div>
<script>
var CATS = [];
var state = { tab: 'places', page: 1, pageSize: 20, q: '', category: '', source: '' };
var app = document.getElementById('app');

function el(tag, props) {
  var e = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
  }
  for (var i = 2; i < arguments.length; i++) {
    var c = arguments[i];
    if (c === null || c === undefined) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

function toast(msg, isError) {
  var t = el('div', { class: 'toast' + (isError ? ' error' : ''), text: msg });
  document.getElementById('toast').append(t);
  setTimeout(function () { t.remove(); }, 3500);
}

function api(method, url, body) {
  return fetch(url, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  }).then(function (r) {
    return r.json().catch(function () { return null; }).then(function (data) {
      if (r.status === 401 && url.indexOf('/auth/login') < 0) {
        showLogin();
        throw new Error('Сессия истекла, войдите снова');
      }
      if (!r.ok) throw new Error((data && data.error) || ('Ошибка ' + r.status));
      return data;
    });
  });
}

// ---------- Вход ----------
function showLogin() {
  app.innerHTML = '';
  var user = el('input', { type: 'text', placeholder: 'Логин', autocomplete: 'username' });
  var pass = el('input', { type: 'password', placeholder: 'Пароль', autocomplete: 'current-password' });
  var err = el('div', { class: 'err' });
  var form = el('form', {
    class: 'login',
    onsubmit: function (e) {
      e.preventDefault();
      err.textContent = '';
      api('POST', '/api/v1/auth/login', { username: user.value, password: pass.value })
        .then(init)
        .catch(function (x) { err.textContent = x.message; });
    }
  },
    el('h1', { text: 'WalkRoutes' }),
    el('p', { class: 'muted', text: 'Админ-панель' }),
    user, pass,
    el('button', { class: 'btn primary', type: 'submit', text: 'Войти' }),
    err);
  app.append(el('div', { class: 'login-wrap' }, form));
  user.focus();
}

function logout() {
  api('POST', '/api/v1/auth/logout').then(showLogin).catch(showLogin);
}

// ---------- Каркас ----------
function init() {
  api('GET', '/api/v1/admin/categories')
    .then(function (c) { CATS = c; renderShell(); })
    .catch(function (e) { toast(e.message, true); });
}

function renderShell() {
  app.innerHTML = '';
  var tabPlaces = el('button', { class: 'tab', text: 'Места', onclick: function () { switchTab('places'); } });
  var tabCats = el('button', { class: 'tab', text: 'Категории', onclick: function () { switchTab('categories'); } });
  var view = el('main', { id: 'view' });
  app.append(
    el('header', null,
      el('span', { class: 'brand', text: 'WalkRoutes · админ-панель' }),
      el('div', { class: 'tabs' }, tabPlaces, tabCats),
      el('span', { class: 'spacer' }),
      el('a', { href: '/', target: '_blank', text: 'Открыть сайт' }),
      el('button', { class: 'btn small', text: 'Выйти', onclick: logout })),
    view);
  app._tabs = { places: tabPlaces, categories: tabCats };
  switchTab(state.tab);
}

function switchTab(tab) {
  state.tab = tab;
  Object.keys(app._tabs).forEach(function (k) {
    app._tabs[k].classList.toggle('active', k === tab);
  });
  if (tab === 'places') renderPlaces(); else renderCategories();
}

// ---------- Модальное окно ----------
function openModal(title, body, onSave) {
  var err = el('div', { class: 'err' });
  var overlay = el('div', { class: 'overlay' });
  function close() { overlay.remove(); }
  var save = el('button', { class: 'btn primary', text: 'Сохранить' });
  save.addEventListener('click', function () {
    err.textContent = '';
    save.disabled = true;
    Promise.resolve().then(onSave).then(function () { close(); }).catch(function (e) {
      err.textContent = e.message;
      save.disabled = false;
    });
  });
  overlay.append(el('div', { class: 'modal' },
    el('h2', { text: title }), body, err,
    el('div', { class: 'buttons' }, el('button', { class: 'btn', text: 'Отмена', onclick: close }), save)));
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
  document.body.append(overlay);
}

function field(label, input) {
  return el('div', { class: 'field' }, el('label', { text: label }), input);
}

function catName(slug) {
  for (var i = 0; i < CATS.length; i++) if (CATS[i].slug === slug) return CATS[i].name;
  return slug || '—';
}

// ---------- Места ----------
var placesBox = null;

function renderPlaces() {
  var view = document.getElementById('view');
  view.innerHTML = '';

  var q = el('input', { type: 'text', placeholder: 'Поиск по названию', value: state.q });
  var timer = null;
  q.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { state.q = q.value.trim(); state.page = 1; loadPlaces(); }, 300);
  });

  var cat = el('select');
  cat.append(el('option', { value: '', text: 'Все категории' }));
  CATS.forEach(function (c) { cat.append(el('option', { value: c.slug, text: c.name })); });
  cat.value = state.category;
  cat.addEventListener('change', function () { state.category = cat.value; state.page = 1; loadPlaces(); });

  var src = el('select');
  [['', 'Любой источник'], ['manual', 'Вручную'], ['osm', 'OpenStreetMap']].forEach(function (o) {
    src.append(el('option', { value: o[0], text: o[1] }));
  });
  src.value = state.source;
  src.addEventListener('change', function () { state.source = src.value; state.page = 1; loadPlaces(); });

  view.append(el('div', { class: 'toolbar' }, q, cat, src,
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn primary', text: '+ Добавить место', onclick: function () { placeForm(null); } })));

  placesBox = el('div', { class: 'card' });
  view.append(placesBox);
  loadPlaces();
}

function loadPlaces() {
  var qs = new URLSearchParams({ page: state.page, pageSize: state.pageSize });
  if (state.q) qs.set('q', state.q);
  if (state.category) qs.set('category', state.category);
  if (state.source) qs.set('source', state.source);
  api('GET', '/api/v1/admin/places?' + qs.toString())
    .then(drawPlaces)
    .catch(function (e) { toast(e.message, true); });
}

function drawPlaces(d) {
  var pages = Math.max(Math.ceil(d.total / d.pageSize), 1);
  var tbody = el('tbody');
  if (!d.items.length) {
    tbody.append(el('tr', null, el('td', { colspan: 6, class: 'muted', text: 'Ничего не найдено' })));
  }
  d.items.forEach(function (p) {
    tbody.append(el('tr', null,
      el('td', { text: p.id }),
      el('td', null, el('div', { text: p.name }), p.name_be ? el('div', { class: 'muted', text: p.name_be }) : null),
      el('td', { text: p.category_name || '—' }),
      el('td', { text: p.source === 'osm' ? 'OpenStreetMap' : 'Вручную' }),
      el('td', { text: Number(p.lat).toFixed(5) + ', ' + Number(p.lng).toFixed(5) }),
      el('td', { class: 'actions' },
        el('button', { class: 'btn small', text: 'Изменить', onclick: function () { placeForm(p); } }),
        el('button', { class: 'btn small danger', text: 'Удалить', onclick: function () { deletePlace(p); } }))));
  });
  var table = el('table', null,
    el('thead', null, el('tr', null,
      el('th', { text: 'ID' }), el('th', { text: 'Название' }), el('th', { text: 'Категория' }),
      el('th', { text: 'Источник' }), el('th', { text: 'Координаты' }), el('th', { text: '' }))),
    tbody);
  var prev = el('button', { class: 'btn small', text: '← Назад', onclick: function () { state.page--; loadPlaces(); } });
  var next = el('button', { class: 'btn small', text: 'Вперёд →', onclick: function () { state.page++; loadPlaces(); } });
  prev.disabled = d.page <= 1;
  next.disabled = d.page >= pages;
  placesBox.innerHTML = '';
  placesBox.append(table, el('div', { class: 'pager' },
    el('span', { class: 'muted', text: 'Всего: ' + d.total + ' · страница ' + d.page + ' из ' + pages }), prev, next));
}

function deletePlace(p) {
  if (!confirm('Удалить место «' + p.name + '»?')) return;
  api('DELETE', '/api/v1/admin/places/' + p.id)
    .then(function () { toast('Место удалено'); loadPlaces(); })
    .catch(function (e) { toast(e.message, true); });
}

function placeForm(p) {
  var isNew = !p;
  p = p || { name: '', name_be: '', description: '', category_id: CATS.length ? CATS[0].id : '', lat: '', lng: '', website: '', image: '' };
  var f = {
    name: el('input', { type: 'text', value: p.name || '' }),
    name_be: el('input', { type: 'text', value: p.name_be || '' }),
    cat: el('select'),
    lat: el('input', { type: 'text', value: p.lat === '' ? '' : String(p.lat), placeholder: '53.9' }),
    lng: el('input', { type: 'text', value: p.lng === '' ? '' : String(p.lng), placeholder: '27.56' }),
    website: el('input', { type: 'text', value: p.website || '' }),
    image: el('input', { type: 'text', value: p.image || '' }),
    description: el('textarea', { text: p.description || '' })
  };
  CATS.forEach(function (c) { f.cat.append(el('option', { value: c.id, text: c.name })); });
  f.cat.value = p.category_id;

  var mapLink = el('a', { href: '#', target: '_blank', class: 'muted', text: 'Посмотреть точку на карте' });
  mapLink.addEventListener('click', function (e) {
    var lat = parseFloat(String(f.lat.value).replace(',', '.'));
    var lng = parseFloat(String(f.lng.value).replace(',', '.'));
    if (isNaN(lat) || isNaN(lng)) { e.preventDefault(); toast('Сначала укажи координаты', true); return; }
    mapLink.href = 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lng + '#map=17/' + lat + '/' + lng;
  });

  var body = el('div', null,
    field('Название *', f.name),
    field('Название на белорусском', f.name_be),
    field('Категория *', f.cat),
    el('div', { class: 'row' }, field('Широта *', f.lat), field('Долгота *', f.lng)),
    mapLink,
    el('div', { style: 'height:10px' }),
    field('Сайт', f.website),
    field('Ссылка на изображение', f.image),
    field('Описание', f.description));

  openModal(isNew ? 'Новое место' : 'Изменить место', body, function () {
    var payload = {
      name: f.name.value.trim(),
      name_be: f.name_be.value.trim(),
      category_id: Number(f.cat.value),
      lat: String(f.lat.value).replace(',', '.').trim(),
      lng: String(f.lng.value).replace(',', '.').trim(),
      website: f.website.value.trim(),
      image: f.image.value.trim(),
      description: f.description.value.trim()
    };
    var req = isNew
      ? api('POST', '/api/v1/admin/places', payload)
      : api('PATCH', '/api/v1/admin/places/' + p.id, payload);
    return req.then(function () {
      toast(isNew ? 'Место добавлено' : 'Изменения сохранены');
      loadPlaces();
    });
  });
}

// ---------- Категории ----------
function renderCategories() {
  var view = document.getElementById('view');
  view.innerHTML = '';
  view.append(el('div', { class: 'toolbar' },
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn primary', text: '+ Добавить категорию', onclick: function () { categoryForm(null); } })));
  var box = el('div', { class: 'card' });
  view.append(box);
  api('GET', '/api/v1/admin/categories').then(function (c) {
    CATS = c;
    var tbody = el('tbody');
    c.forEach(function (x) {
      tbody.append(el('tr', null,
        el('td', { text: x.id }), el('td', { text: x.slug }), el('td', { text: x.name }), el('td', { text: x.places }),
        el('td', { class: 'actions' },
          el('button', { class: 'btn small', text: 'Изменить', onclick: function () { categoryForm(x); } }),
          el('button', { class: 'btn small danger', text: 'Удалить', onclick: function () { deleteCategory(x); } }))));
    });
    box.append(el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'ID' }), el('th', { text: 'Код' }),
        el('th', { text: 'Название' }), el('th', { text: 'Мест' }), el('th', { text: '' }))),
      tbody));
  }).catch(function (e) { toast(e.message, true); });
}

function categoryForm(c) {
  var isNew = !c;
  var slug = el('input', { type: 'text', value: c ? c.slug : '', placeholder: 'например, fountain' });
  if (!isNew) slug.disabled = true;
  var name = el('input', { type: 'text', value: c ? c.name : '' });
  var body = el('div', null,
    field('Код (латиницей, после создания не меняется)', slug),
    field('Название *', name));
  openModal(isNew ? 'Новая категория' : 'Изменить категорию', body, function () {
    var req = isNew
      ? api('POST', '/api/v1/admin/categories', { slug: slug.value.trim(), name: name.value.trim() })
      : api('PATCH', '/api/v1/admin/categories/' + c.id, { name: name.value.trim() });
    return req.then(function () { toast('Сохранено'); renderCategories(); });
  });
}

function deleteCategory(c) {
  if (!confirm('Удалить категорию «' + c.name + '»?')) return;
  api('DELETE', '/api/v1/admin/categories/' + c.id)
    .then(function () { toast('Категория удалена'); renderCategories(); })
    .catch(function (e) { toast(e.message, true); });
}

// ---------- Старт ----------
fetch('/api/v1/auth/me', { credentials: 'same-origin' })
  .then(function (r) { if (r.ok) init(); else showLogin(); })
  .catch(showLogin);
</script>
</body>
</html>`;

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server: http://localhost:${port}`));
