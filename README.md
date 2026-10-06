# Procurement Gatekeeper

An API that scores every procurement request against a demand baseline and approves it, tags it for review, or holds it for a senior manager.

It implements the scenario from the audit's Section 9A: a region that uses about 30 units over a weekend orders 90 units on Friday and another 90 on Saturday. The Friday order is tagged; the Saturday order is held and a Risk Level Report is queued.

Stack: Node.js 22, TypeScript, Express 5, PostgreSQL, Zod, Vitest.

## Reviewer's guide

| Audit requirement | Where to look |
| --- | --- |
| Environment variable hygiene | [src/config/env.ts](src/config/env.ts), [.env.example](.env.example), [.gitignore](.gitignore) |
| Input validation and authentication | [src/http/app.ts](src/http/app.ts) |
| Database query optimisation | [src/repositories/procurementRepository.ts](src/repositories/procurementRepository.ts), [migrations/001_init.sql](migrations/001_init.sql) |
| Algorithm efficiency | [src/domain/stats.ts](src/domain/stats.ts), [src/domain/riskEngine.ts](src/domain/riskEngine.ts) |
| Error handling | [src/db/transaction.ts](src/db/transaction.ts), [src/services/gatekeeperService.ts](src/services/gatekeeperService.ts), error handler in [src/http/app.ts](src/http/app.ts) |
| Unit tests | [tests/](tests/) |

## 1. Secure API endpoints

- **Configuration is validated at start-up.** `loadEnv` parses every variable with a schema and stops the process if one is missing or malformed. `JWT_SECRET` has no default and must be at least 32 characters. The error names the variable but never prints its value.
- **No secrets in the repository.** `.env` and every `.env.*` file are git-ignored; only `.env.example` with empty secrets is committed.
- **Allow-list input validation.** Request bodies are strict Zod objects: unknown fields are rejected, quantities must be integers from 1 to 100,000, and region and SKU must match fixed patterns.
- **Parameterised SQL only.** No user input is ever concatenated into a statement.
- **JWT authentication with a pinned algorithm.** Only HS256 is accepted, so an unsigned (`alg: none`) token is rejected. Claims are validated before use.
- **Authorisation and separation of duties.** Only a senior manager can review a held order, and nobody can review their own.
- **Hardened defaults.** Helmet security headers, a 10 kB body limit, and no `X-Powered-By` header.

## 2. Query and algorithm efficiency

**One indexed query per request.** Scoring needs three figures: units on open order, whether a duplicate exists, and the requester's recent request count. They come from a single statement using conditional aggregates, served by the composite index `(region_id, sku, created_at)`.

| Approach | Cost |
| --- | --- |
| Three queries, no index | 3 round trips, each a full scan: O(n) |
| One query with the composite index | 1 round trip, one index range scan: O(log n + k) |

Here n is the total number of requests and k is the number inside the 7-day window for one region and SKU.

**O(1) scoring.** `assessRisk` works only on pre-aggregated numbers, so its cost does not grow with order history.

**O(n) median.** Baselines use the median and the median absolute deviation, computed with quickselect in average O(n) time instead of a full O(n log n) sort. A random pivot prevents sorted input from triggering the O(n²) worst case.

**Serialised scoring per region and SKU.** The baseline row is locked with `SELECT ... FOR UPDATE` for the duration of the transaction, so two simultaneous orders cannot both see "nothing on order".

## 3. Error handling and tests

- **All or nothing.** The request, its audit entry and any risk report are written in one transaction. `withTransaction` rolls back on any error and always releases the connection.
- **Safe retries.** Each request carries an `Idempotency-Key`. A retry with the same key and body returns the stored result; the same key with a different body returns `409`. A race between two copies is resolved by a unique constraint.
- **Fail closed.** A request with no demand baseline cannot be scored, so it is held, not approved.
- **No internal details leak.** Expected errors return their own status and code. Anything unexpected is logged server-side and returned as a generic `500`.

The tests cover the audit scenario end to end, validation and authentication failures, idempotent replay, review rules, and a failure injected part-way through a transaction. That last test asserts that nothing is left behind, that the response hides the cause, and that a retry with the same key succeeds.

```
Test Files  4 passed (4)
     Tests  48 passed (48)
Statements 97.3%   Branches 92.2%   Functions 95.7%   Lines 98.5%
```

Integration tests run against PGlite, which is PostgreSQL compiled to WebAssembly, so they exercise real transactions, row locks and constraints without a database server.

## Running it

```bash
npm install
npm test                 # run the suite
npm run test:coverage    # with coverage thresholds
npm run typecheck
```

To run the server, copy `.env.example` to `.env`, set `DATABASE_URL` and `JWT_SECRET`, apply `migrations/001_init.sql` to the database, then:

```bash
npm run build && npm start
```

## API

All routes under `/api/v1` require `Authorization: Bearer <JWT>` with `sub` and `role` (`regional_manager` or `senior_manager`) claims.

| Method and path | Purpose |
| --- | --- |
| `POST /api/v1/procurement-requests` | Submit a request. Requires an `Idempotency-Key` header. Body: `regionId`, `sku`, `quantity`. |
| `GET /api/v1/procurement-requests/:id` | Fetch a request and its risk decision. |
| `POST /api/v1/procurement-requests/:id/review` | Senior manager releases or rejects a held order. Body: `outcome`. |
| `GET /health` | Liveness check, no authentication. |

## Risk policy

| Signal | Effect on score |
| --- | --- |
| Coverage ratio (open orders plus this one, divided by baseline demand) | 10 points per multiple beyond the first, up to 40 |
| Quantity is an outlier (robust z-score above 3.5) | +25 |
| Same requester, SKU and quantity within 48 hours | +30 |
| Three or more recent requests by the requester for the SKU | +10 |

A score below 40 is approved, 40 to 69 is approved and tagged, and 70 or above is held. A duplicate that also takes coverage above 3 is held whatever its score. The thresholds are configuration, not constants.

## Scope

This repository covers the rules and statistical layers and the hold-and-report path. The streaming feature pipeline, the Isolation Forest model, and the relay that publishes outbox rows to email and the CRM are described in the architectural brief and are not implemented here.
