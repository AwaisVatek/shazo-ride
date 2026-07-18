# Manual test scripts

Disposable, non-automated E2E smoke scripts. Not wired into `npm test` (there is
no automated test suite in this repo yet) — run manually against a live server:

```
node node_modules/tsx/dist/cli.mjs src/scripts/manual-tests/test_booking_flow.ts
node node_modules/tsx/dist/cli.mjs src/scripts/manual-tests/test_rider_auth_flow.ts
node node_modules/tsx/dist/cli.mjs src/scripts/manual-tests/test_socket_auth.ts
```

Each creates disposable, obviously-tagged test data and is expected to clean up
after itself. Point `DATABASE_URL`/`API_BASE_URL` at the target environment
before running. Never run against a database confirmed to be serving real
production traffic without read-only verification first.

- `test_booking_flow.ts` — signup → estimate → request → offer-fare → accept-offer,
  asserting on the real `ride_bookings` columns (`service_type`, `vehicle_category`,
  `negotiation_status`, `accepted_fare`).
- `test_rider_auth_flow.ts` — `GET /api/rider/me` / `/status`, admin rejection-reason
  update, and the wallet-eligibility gate with a real negative-balance wallet.
- `test_socket_auth.ts` — Socket.IO auth: rejects unauthenticated connections,
  accepts authenticated ones, verifies ghost-rider cleanup on disconnect, and
  cross-ride chat isolation. Hardcodes a path to a sibling repo's
  `socket.io-client` — only runs on a machine with `shazo-rider-app` checked out
  alongside this repo.
