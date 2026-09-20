# Node.js Taskboard

A meaningful **plain Node.js** application for the xCloud app-compatibility
suite: a project/task board served by the **native `node:http` server** (no
Express and no routing framework), with **SQLite** persistence via
`better-sqlite3`.

It is a production-process fixture, not a success-page shell: every workflow
reads and writes through parameterized SQLite queries, all input is validated
server-side with meaningful error payloads, and `scripts/verify.sh` exercises
the real production process end to end.

## Feature summary

- Native **`node:http`** server — no Express or any other routing framework.
  Routing, static serving and error handling are implemented directly on the
  `http` module (`src/app.js`).
- Projects and tasks with status/priority, search (`q`), and status/priority
  filters — all over a JSON API consumed by a small DOM-rendered client.
- Validated CRUD: blank/over-long/mistyped fields, invalid status/priority,
  malformed JSON, missing references and not-found resources all return
  meaningful JSON errors (400/404); output is escaped client-side by
  rendering via `textContent` only (no `innerHTML` with user data).
- Parameterized SQL everywhere (LIKE wildcards escaped) — no string-built
  queries from user input. Static files are served through a traversal-safe
  resolver restricted to the `public/` root.
- Idempotent schema setup (`CREATE TABLE IF NOT EXISTS`) and repeatable seed
  data, guarded by a one-time seed flag so re-opens never duplicate rows.
- Persistence: explicit SQLite file (`DATA_DIR`/`DATABASE_PATH`); the app
  never stores permanent state in an ephemeral release directory.
- `/api/health/live` (process alive) and `/api/health/ready` (does a real
  database open + write; **503** while the database is unavailable).
- Non-sensitive release marker: `scripts/build.sh` writes a generated
  `VERSION` file (git SHA by default — `BUILD_MARKER` to override); the marker
  is served by `/api/meta` and shown in the UI. `VERSION` is a **build
  artifact** (gitignored) so the served marker always reflects the deployed
  revision rather than a frozen file.
- Graceful SIGTERM/SIGINT shutdown (server close + database close), logs to
  stdout/stderr.

## Runtime and dependencies

- Node.js **v22.23.2** validated (Node >= 20 supported).
- **better-sqlite3 13.0.3** for SQLite persistence. The HTTP layer uses only
  the built-in `node:http` module.
- Lockfile `package-lock.json` pins the toolchain; `npm ci` reproduces it.

Runtime versions (this verification):

| Component | Version |
|-----------|---------|
| Node.js   | 22.23.2 |
| better-sqlite3 | 13.0.3 |
| SQLite    | via `better-sqlite3` |

## Quick start (development)

```bash
npm install
cp .env.example .env       # review and adjust
npm run dev                # node --watch src/index.js
```

Open http://localhost:8080 — the seeder has already created two demo projects
and a few tasks on first boot.

## Production start

```bash
npm ci
scripts/build.sh           # writes VERSION release marker
npm start                  # node src/index.js
```

- Binds to `BIND_HOST:PORT` (defaults **0.0.0.0:8080**).
- Run from the repository root so `./public` (UI assets) and `VERSION`
  resolve correctly.
- Logs go to stdout/stderr; the process answers SIGTERM/SIGINT with a clean
  shutdown.

## Health and readiness

| Endpoint | Meaning |
|----------|---------|
| `GET /api/health/live`  | Process is alive (always 200 while serving). |
| `GET /api/health/ready` | Opens the SQLite file and performs a write + read; **503** when the database is unavailable, with a `status: "unavailable"` body and the underlying reason. |

`/api/health/ready` is a genuine dependency probe (fresh connection, real
write), not a static marker. `scripts/smoke.sh` proves it: it starts the
process against a database path that cannot be created (parent is a regular
file), observes readiness drop to 503 while liveness stays 200, then restores
a healthy process and proves readiness recovers.

## Environment variables

See `.env.example` for the full commented list.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `PORT` | no | `8080` | bind port |
| `BIND_HOST` | no | `0.0.0.0` | bind address |
| `DATA_DIR` | no | `<repo>/data` | base data directory |
| `DATABASE_PATH` | no | `<DATA_DIR>/taskboard.db` | **persistent SQLite path** |
| `BUILD_MARKER` | no | git SHA | release marker in `/api/meta` and the UI footer |

No credentials or secrets are committed or required.

## Persistence

Data lives in the SQLite file at `DATABASE_PATH`, which defaults under
`DATA_DIR` (gitignored). For redeploys that reuse or replace the release
directory, mount a persistent volume at `DATA_DIR`/`DATABASE_PATH` so the
file survives. `scripts/smoke.sh` proves persistence: it creates a
"PERSIST" survivor task over HTTP, gracefully stops the production process,
restarts it on the **same database path**, and verifies the record is still
served with stable counts.

## Schema

Created by `src/db.js` (`CREATE TABLE IF NOT EXISTS`, idempotent):

- `project` — id, name, description, status (`active|archived`), timestamps.
- `task` — id, `project_id` FK (`ON DELETE CASCADE`), title, description,
  status (`todo|in_progress|done`), priority (`low|medium|high`), timestamps.
- `seed_flag` — marks the one-time seed as applied.
- `heartbeat` — backing table for the readiness write probe.

Seeding is repeatable: the second and subsequent `openDb` calls never add
rows (`tests/app.test.js` asserts seed idempotency).

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health/live` | liveness |
| GET | `/api/health/ready` | readiness (DB probe) |
| GET | `/api/meta` | release marker + runtime versions |
| GET/POST | `/api/projects` | list / create projects |
| GET/PATCH/DELETE | `/api/projects/:id` | read / update / delete a project |
| GET/POST | `/api/tasks` | list (filters `q`, `status`, `priority`, `project_id`) / create tasks |
| GET/PATCH/DELETE | `/api/tasks/:id` | read / update / delete a task |

The UI at `/` consumes the same JSON API.

## Automated verification

```bash
scripts/verify.sh
```

Runs, in order:

1. `scripts/build.sh` — writes the `VERSION` release marker.
2. Clean install — `rm -rf node_modules && npm ci` (frozen lockfile).
3. Syntax check — `npm run check` (`node --check` on each `src/` file and the
   client `public/app.js`).
4. `node --test tests` — unit/integration suite against a real
   `node:http` server: CRUD, search/filter, validation negatives
   (blank/over-long/mistyped fields, invalid status/priority, malformed JSON,
   missing project, empty PATCH, 404s), LIKE-wildcard escaping,
   schema/seed idempotency, restart-style persistence, static-file traversal
   protection, and readiness that genuinely drops to 503 when the database is
   unavailable.
5. `scripts/smoke.sh` — real production process (`node src/index.js`):
   liveness/readiness, CRUD over HTTP, search/status filters, release marker,
   negative cases, graceful stop → restart persistence, database-unavailable
   readiness (503) and recovery.

Exit 0 only when every check passes.

## Repository layout

```
src/            config.js (env), db.js (schema/seed/probe), app.js
                (native node:http router + handlers), index.js (entrypoint)
tests/          node:test suite against a real http server
scripts/        build.sh (VERSION marker), smoke.sh (production check),
                verify.sh (full verification)
public/         DOM-rendered UI (index.html, app.js, style.css)
package.json    scripts + locked dependency (better-sqlite3)
package-lock.json
```

## License

MIT — see [LICENSE](LICENSE). This fixture is part of the MIT-licensed
[xCloud app-compatibility suite](https://github.com/xCloudNobin/app-compatibility).