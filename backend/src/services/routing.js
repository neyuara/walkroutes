const ROUTING_URL =
  process.env.ROUTING_URL || 'https://routing.openstreetmap.de/routed-foot';

function haversine(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Жадный алгоритм (ближайший сосед), первая точка фиксирована.
function optimizeOrder(points) {
  const rest = points.slice(1);
  const result = [points[0]];
  while (rest.length) {
    const last = result[result.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    rest.forEach((p, i) => {
      const d = haversine(last, p);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    });
    result.push(rest.splice(bestIdx, 1)[0]);
  }
  return result;
}

async function buildRoute(points) {
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `${ROUTING_URL}/route/v1/foot/${coords}?overview=full&geometries=geojson&steps=false`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing service responded ${res.status}`);

  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(`Routing failed: ${data.code || 'no route'}`);
  }

  const r = data.routes[0];
  return {
    distance_m: Math.round(r.distance),
    duration_s: Math.round(r.duration),
    geometry: r.geometry, // GeoJSON LineString
  };
}

module.exports = { optimizeOrder, buildRoute };
