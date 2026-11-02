CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE places (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category_id INT REFERENCES categories(id),
  geom geometry(Point, 4326) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX places_geom_idx ON places USING GIST (geom);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE routes (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  distance_m INT,
  duration_s INT,
  geometry geometry(LineString, 4326),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE route_points (
  route_id INT REFERENCES routes(id) ON DELETE CASCADE,
  position INT NOT NULL,
  place_id INT REFERENCES places(id),
  geom geometry(Point, 4326) NOT NULL,
  PRIMARY KEY (route_id, position)
);

INSERT INTO categories (slug, name) VALUES
  ('sight', 'Достопримечательности'),
  ('museum', 'Музеи'),
  ('park', 'Парки');

INSERT INTO places (name, description, category_id, geom) VALUES
  ('Троицкое предместье', 'Исторический район Минска', (SELECT id FROM categories WHERE slug='sight'), ST_SetSRID(ST_MakePoint(27.5555, 53.9086), 4326)),
  ('Остров Слёз', 'Мемориал воинам-афганцам', (SELECT id FROM categories WHERE slug='sight'), ST_SetSRID(ST_MakePoint(27.5568, 53.9084), 4326)),
  ('Ратуша', 'Минская ратуша', (SELECT id FROM categories WHERE slug='sight'), ST_SetSRID(ST_MakePoint(27.5560, 53.9040), 4326)),
  ('Красный костёл', 'Костёл Святых Симеона и Елены', (SELECT id FROM categories WHERE slug='sight'), ST_SetSRID(ST_MakePoint(27.5497, 53.8967), 4326)),
  ('Площадь Победы', 'Монумент Победы', (SELECT id FROM categories WHERE slug='sight'), ST_SetSRID(ST_MakePoint(27.5745, 53.9090), 4326)),
  ('Парк Горького', 'Центральный парк Минска', (SELECT id FROM categories WHERE slug='park'), ST_SetSRID(ST_MakePoint(27.5770, 53.9026), 4326)),
  ('Национальная библиотека', 'Смотровая площадка', (SELECT id FROM categories WHERE slug='sight'), ST_SetSRID(ST_MakePoint(27.6430, 53.9310), 4326)),
  ('Мирский замок', 'Объект ЮНЕСКО', (SELECT id FROM categories WHERE slug='sight'), ST_SetSRID(ST_MakePoint(26.4725, 53.4511), 4326)),
  ('Несвижский замок', 'Объект ЮНЕСКО', (SELECT id FROM categories WHERE slug='sight'), ST_SetSRID(ST_MakePoint(26.6916, 53.2227), 4326)),
  ('Брестская крепость', 'Мемориальный комплекс', (SELECT id FROM categories WHERE slug='museum'), ST_SetSRID(ST_MakePoint(23.6564, 52.0830), 4326)),
  ('Софийский собор', 'Полоцк', (SELECT id FROM categories WHERE slug='sight'), ST_SetSRID(ST_MakePoint(28.7681, 55.4856), 4326)),
  ('Старый замок', 'Гродно', (SELECT id FROM categories WHERE slug='sight'), ST_SetSRID(ST_MakePoint(23.8286, 53.6775), 4326));
