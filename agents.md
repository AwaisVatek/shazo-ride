# Backend (shazo-ride-git) — Local Law
If what you need is not covered here, return to the root router: `../router.md`
(and read `../PRODUCT.md` for overall product direction, real-time event
contracts, wallet model, and the map provider decision).

## Mission
This folder contains the Node.js/Express backend API, Socket.IO real-time layer, and database migrations for the Shazo Ride ecosystem.

## Map (this floor only)
- `src/` — Source code for the backend.
- `src/modules/` — Feature modules containing routes and controllers.
- `src/modules/maps/maps.routes.ts` + `src/services/eta.service.ts` — Mapbox Geocoding/Directions integration. **Mapbox only — never Google Maps, Nominatim, or OSRM.**
- `src/migrations/` — Database migration scripts.
- `src/server.ts` — Express app + Socket.IO server; socket event contracts are documented in `../PRODUCT.md`.

## Rules specific to this folder
- Ensure any database schema changes are added as new migration files rather than modifying old ones, and make them idempotent (`CREATE TABLE IF NOT EXISTS`, etc.) — the migration runner (`db.migrate()`) has no tracking table and re-runs every file on every invocation.
- **Before writing SQL that touches a table, verify its real column names against the live database first** — this codebase's assumptions about its own schema have been wrong multiple times (see "Database reality" in `../PRODUCT.md`). Don't trust the migration files as ground truth for what's actually deployed.
- When working on APIs, maintain alignment with both Customer and Rider mobile apps — check both apps' actual usage (grep for the endpoint path) before assuming which client calls what; there have been duplicate/divergent route implementations for the same feature (e.g. a full `food.routes.ts`/`ambulance.routes.ts` module that no client actually calls, versus the real `customer.routes.ts` "MVP" routes that do get used).
- Wallet top-up approvals (rider and customer) must use an atomic `UPDATE ... WHERE status = 'pending' RETURNING *` guard, never a separate SELECT-then-UPDATE check — the latter is a real race condition that caused a double-credit bug twice in this codebase's history.
- Any endpoint that changes a ride/ambulance/order status should emit the matching Socket.IO event (`ride_update`/`ambulance_update`) — see `../PRODUCT.md` for the exact contract.

## Support
- For pickup/handoff, follow root AGENTS.md §50.
