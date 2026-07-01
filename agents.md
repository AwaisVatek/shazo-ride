# Backend (shazo-ride-git) — Local Law
If what you need is not covered here, return to the root router:
`../router.md`.

## Mission
This folder contains the Node.js/Express backend API and database migrations for the Shazo Ride ecosystem.

## Map (this floor only)
- `src/` — Source code for the backend.
- `src/modules/` — Feature modules containing routes and controllers.
- `src/migrations/` — Database migration scripts.

## Rules specific to this folder
- Ensure any database schema changes are added as new migration files rather than modifying old ones.
- When working on APIs, maintain alignment with both Customer and Rider mobile apps.

## Support
- For pickup/handoff, follow root AGENTS.md §50.
