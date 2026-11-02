# WalkRoutes

Сервис построения пеших маршрутов по достопримечательностям Беларуси.

## Запуск
```bash
docker compose up --build
```
Открыть: http://localhost:3000

## API
- `GET  /api/v1/places?category=&bbox=minLng,minLat,maxLng,maxLat`
- `GET  /api/v1/places/categories`
- `POST /api/v1/routes/build` — `{ "points": [{"lat":..,"lng":..}], "optimize": true }`

## Структура
- `db/init.sql` — схема PostGIS и тестовые данные
- `backend/` — Node.js + Express API (отдаёт и фронтенд из `public/`)
- `ROUTING_URL` — движок маршрутизации (по умолчанию публичный OSRM foot; для продакшена поднять свой OSRM/GraphHopper)

## Карта
Векторные тайлы OpenFreeMap (на данных OpenStreetMap) через MapLibre GL JS, ключ не нужен. Стиль меняется в селекторе (liberty / bright / positron).

## Обновление фронтенда
Папка `backend/public` смонтирована в контейнер: после правки `index.html` достаточно обновить страницу (`Ctrl+F5`). Изменения в `backend/src` требуют `docker compose up --build`.
