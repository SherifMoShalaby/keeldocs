# init-scenario

A small items service.

## Setup

Create a `.env` file with `DATABASE_URL` and `APP_PORT`, then run `npm run start`.
Seed the database with the script in `scripts/seed.js` before first use.
Set `ITEMS_CACHE_URL` to enable the cache layer.

Config lives in `path/to/your-config.json` (placeholder example).
We chart usage with `chart.js`.

## Deploy

Run `npm run deploy` to ship to production.

## API

Fetch items with GET /api/items and check liveness with GET /health.
