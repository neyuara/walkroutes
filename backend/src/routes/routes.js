const express = require('express');
const { optimizeOrder, buildRoute } = require('../services/routing');

const router = express.Router();

function validPoint(p) {
  return (
    p &&
    typeof p.lat === 'number' &&
    typeof p.lng === 'number' &&
    p.lat >= -90 && p.lat <= 90 &&
    p.lng >= -180 && p.lng <= 180
  );
}

// POST /api/v1/routes/build
// body: { points: [{ id?, name?, lat, lng }], optimize?: boolean }
router.post('/build', async (req, res, next) => {
  try {
    const { points, optimize } = req.body || {};

    if (!Array.isArray(points) || points.length < 2 || points.length > 25) {
      return res.status(400).json({ error: 'Нужно от 2 до 25 точек' });
    }
    if (!points.every(validPoint)) {
      return res.status(400).json({ error: 'Некорректные координаты' });
    }

    const ordered = optimize ? optimizeOrder(points) : points;
    const route = await buildRoute(ordered);

    res.json({ points: ordered, ...route });
  } catch (e) {
    if (String(e.message).startsWith('Routing')) {
      return res.status(502).json({ error: e.message });
    }
    next(e);
  }
});

module.exports = router;
