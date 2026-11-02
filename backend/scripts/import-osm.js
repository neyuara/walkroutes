// Импорт достопримечательностей и памятников Беларуси из OpenStreetMap (Overpass API) в PostGIS.
// Запуск (из папки backend, БД должна работать):
//   npm install
//   node scripts/import-osm.js              # добавить/обновить данные
//   node scripts/import-osm.js --clean-seed # дополнительно удалить тестовые места из init.sql
// Повторный запуск безопасен: записи обновляются по osm_id.

const pool = require('../src/db');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const QUERY = `
[out:json][timeout:240];
area["ISO3166-1"="BY"][admin_level=2]->.by;
(
  nwr["tourism"~"^(attraction|museum|viewpoint|gallery)$"]["name"](area.by);
  nwr["historic"~"^(castle|monument|memorial|ruins|archaeological_site|fort|manor|monastery|city_gate|church)$"]["name"]["memorial"!~"^(plaque|stolperstein|bench)$"](area.by);
  nwr["heritage"]["name"](area.by);
);
out center tags;
`;

const CATEGORIES = {
  sight: 'Достопримечательности',
  museum: 'Музеи',
  park: 'Парки',
  castle: 'Замки, крепости и усадьбы',
  monument: 'Памятники и мемориалы',
  church: 'Храмы и монастыри',
  viewpoint: 'Смотровые площадки',
};

function categoryOf(t) {
  if (t.tourism === 'museum') return 'museum';
  if (t.tourism === 'viewpoint') return 'viewpoint';
  if (['castle', 'fort', 'manor', 'ruins', 'city_gate'].includes(t.historic)) return 'castle';
  if (['monument', 'memorial', 'archaeological_site'].includes(t.historic)) return 'monument';
  if (['church', 'monastery'].includes(t.historic) || t.amenity === 'place_of_worship') return 'church';
  return 'sight';
}

async function fetchOverpass() {
  for (const url of ENDPOINTS) {
    try {
      console.log('Запрос к Overpass:', url);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'walkroutes-diploma/0.1',
        },
        body: 'data=' + encodeURIComponent(QUERY),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return data.elements || [];
    } catch (e) {
      console.warn('Не удалось:', e.message);
    }
  }
  throw new Error('Overpass недоступен, попробуй позже');
}

async function migrate(client) {
  await client.query(`
    ALTER TABLE places
      ADD COLUMN IF NOT EXISTS osm_id TEXT,
      ADD COLUMN IF NOT EXISTS name_be TEXT,
      ADD COLUMN IF NOT EXISTS wikidata TEXT,
      ADD COLUMN IF NOT EXISTS wikipedia TEXT,
      ADD COLUMN IF NOT EXISTS website TEXT,
      ADD COLUMN IF NOT EXISTS image TEXT,
      ADD COLUMN IF NOT EXISTS tags JSONB,
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
    CREATE UNIQUE INDEX IF NOT EXISTS places_osm_id_key ON places (osm_id);
  `);
  for (const [slug, name] of Object.entries(CATEGORIES)) {
    await client.query(
      'INSERT INTO categories (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING',
      [slug, name]
    );
  }
}

async function main() {
  const cleanSeed = process.argv.includes('--clean-seed');
  const elements = await fetchOverpass();
  console.log('Получено объектов:', elements.length);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await migrate(client);

    const { rows } = await client.query('SELECT slug, id FROM categories');
    const catId = Object.fromEntries(rows.map((r) => [r.slug, r.id]));

    if (cleanSeed) {
      const del = await client.query('DELETE FROM places WHERE osm_id IS NULL');
      console.log('Удалено тестовых мест:', del.rowCount);
    }

    const stats = {};
    let saved = 0;

    for (const el of elements) {
      const t = el.tags || {};
      const name = t['name:ru'] || t.name || t['name:be'];
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!name || lat == null || lon == null) continue;

      const cat = categoryOf(t);
      stats[cat] = (stats[cat] || 0) + 1;

      await client.query(
        `INSERT INTO places
           (osm_id, name, name_be, description, category_id, geom,
            wikidata, wikipedia, website, image, tags, source)
         VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint($6, $7), 4326),
                 $8, $9, $10, $11, $12, 'osm')
         ON CONFLICT (osm_id) DO UPDATE SET
           name = EXCLUDED.name, name_be = EXCLUDED.name_be,
           description = EXCLUDED.description, category_id = EXCLUDED.category_id,
           geom = EXCLUDED.geom, wikidata = EXCLUDED.wikidata,
           wikipedia = EXCLUDED.wikipedia, website = EXCLUDED.website,
           image = EXCLUDED.image, tags = EXCLUDED.tags`,
        [
          `${el.type}/${el.id}`,
          name,
          t['name:be'] || null,
          t['description:ru'] || t.description || null,
          catId[cat],
          lon,
          lat,
          t.wikidata || null,
          t.wikipedia || null,
          t.website || t['contact:website'] || null,
          t.image || t.wikimedia_commons || null,
          JSON.stringify(t),
        ]
      );
      saved++;
    }

    await client.query('COMMIT');
    console.log('Сохранено мест:', saved);
    console.log('По категориям:', stats);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Ошибка импорта:', e.message);
  process.exit(1);
});
