# Verification record

Fixture: **deploy-test-nodejs** (native Node.js `node:http` server +
`better-sqlite3`).

## Command

```bash
bash scripts/verify.sh
```

## Environment

| Component | Version |
|-----------|---------|
| Node.js   | v22.23.2 |
| npm       | 10.9.8 |
| better-sqlite3 | 13.0.3 |
| SQLite    | via `better-sqlite3` |
| HTTP      | native `node:http` (no framework) |

## Steps and outcome (exit 0 = all passed)

1. `scripts/build.sh` — writes the `VERSION` release marker (git short SHA,
   `ef1e899`; `VERSION` is a gitignored build artifact): **passed**.
2. Clean install — `rm -rf node_modules && npm ci` (frozen lockfile):
   **passed**.
3. Syntax check — `npm run check` (`node --check` on `src/*.js` and
   `public/app.js`): **passed**.
4. Test suite — `node --test tests/*.test.js` against a real `node:http`
   server: **35 tests, 0 failed** (CRUD, search/filter, LIKE-wildcard
   escaping, validation negatives, static traversal protection, seed/schema
   idempotency, restart persistence, database-unavailable readiness).
5. Production smoke — `scripts/smoke.sh` against the real process
   `node src/index.js`: **56 checks, 0 failed**, including:
   - liveness/readiness, release marker, static UI + assets;
   - project/task CRUD over HTTP, read-back, delete;
   - search and status/priority filters;
   - negative/validation cases (400) and not-found (404), path traversal;
   - sqlite file written to disk;
   - persistence survivor survives graceful stop → restart on the **same**
     SQLite path with stable counts;
   - database-unavailable readiness: `503` with `status: "unavailable"`
     while liveness stays `200` and static UI keeps serving;
   - recovery: readiness returns to `200` once a healthy process is restored.

## Candidate commit

- Branch: `feat/compatibility-nodejs`
- Tested commit: `ef1e8990d794794cc8f7eb0d576d7dcb1a2c7da3`
- Release marker served by `/api/meta` at that commit: `ef1e899`

## Notes

- No live platform/deployment qualification was performed; this is local
  production verification only. `deployment-verified` is intentionally not
  claimed.
- No credentials or secrets are committed; `.env.example` contains safe
  placeholder values only.