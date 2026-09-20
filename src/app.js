import { createReadStream } from "node:fs";
import { statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import {
  PRIORITIES,
  PROJECT_STATUSES,
  TASK_STATUSES,
  probeDb,
} from "./db.js";

const PUBLIC_ROOT = resolve(fileURLToPath(new URL("../public/", import.meta.url)));

// ---------------------------------------------------------------------------
// Domain errors mapped to HTTP responses by the error handler
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message, fields = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

class BadRequestError extends HttpError {
  constructor(message, fields = {}) {
    super(400, message, fields);
  }
}

class ServiceUnavailableError extends HttpError {
  constructor() {
    super(503, "Service Unavailable");
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendJsonError(res, err) {
  if (err instanceof ServiceUnavailableError) {
    return sendJson(res, 503, { error: "Service Unavailable", db: "unavailable" });
  }
  if (err instanceof HttpError) {
    const body = { error: err.message };
    if (Object.keys(err.fields).length > 0) body.fields = err.fields;
    return sendJson(res, err.status, body);
  }
  console.error("[taskboard] request failed:", err instanceof Error ? err.message : err);
  return sendJson(res, 500, { error: "Internal Server Error" });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const NAME_MAX = 120;
const MAX_BODY_BYTES = 1024 * 1024;

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadRequestError("Field must be a string");
  return value;
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new BadRequestError("Invalid identifier");
  return id;
}

function parseStatus(value) {
  if (value === undefined || value === null || value === "") return "todo";
  if (!TASK_STATUSES.includes(value)) {
    throw new BadRequestError(`Status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return value;
}

function parsePriority(value) {
  if (value === undefined || value === null || value === "") return "medium";
  if (!PRIORITIES.includes(value)) {
    throw new BadRequestError(`Priority must be one of: ${PRIORITIES.join(", ")}`);
  }
  return value;
}

function parseProjectStatus(value) {
  if (value === undefined || value === null || value === "") return "active";
  if (!PROJECT_STATUSES.includes(value)) {
    throw new BadRequestError(`Project status must be one of: ${PROJECT_STATUSES.join(", ")}`);
  }
  return value;
}

function validateTaskInput(body, requireProject) {
  const fields = {};

  const projectValue = body.project_id;
  let projectId = 0;
  if (projectValue === undefined || projectValue === null) {
    if (requireProject) fields.project_id = "project_id is required";
  } else if (typeof projectValue !== "number" || !Number.isInteger(projectValue) || projectValue < 1) {
    fields.project_id = "project_id must be a positive integer";
  } else {
    projectId = projectValue;
  }

  const titleValue = body.title;
  let title = "";
  if (typeof titleValue !== "string" || titleValue.trim() === "") {
    fields.title =
      typeof titleValue === "string"
        ? "title is required and must not be blank"
        : "title is required and must be a string";
  } else {
    title = titleValue.trim();
    if (title.length > TITLE_MAX) fields.title = `title must be ${TITLE_MAX} characters or fewer`;
  }

  let description = "";
  const descriptionValue = optionalString(body.description);
  if (descriptionValue !== undefined) {
    description = descriptionValue.trim();
    if (description.length > DESCRIPTION_MAX) {
      fields.description = `description must be ${DESCRIPTION_MAX} characters or fewer`;
    }
  }

  let status = "todo";
  let priority = "medium";
  try {
    status = parseStatus(body.status);
    priority = parsePriority(body.priority);
  } catch (err) {
    if (err instanceof BadRequestError) fields.status = err.message;
    else throw err;
  }

  if (Object.keys(fields).length > 0) throw new BadRequestError("Validation failed", fields);
  if (requireProject && !projectId) {
    throw new BadRequestError("Validation failed", { project_id: "project_id is required" });
  }

  return { project_id: projectId, title, description, status, priority };
}

function validateProjectInput(body) {
  const fields = {};

  const nameValue = body.name;
  let name = "";
  if (typeof nameValue !== "string" || nameValue.trim() === "") {
    fields.name =
      typeof nameValue === "string"
        ? "name is required and must not be blank"
        : "name is required and must be a string";
  } else {
    name = nameValue.trim();
    if (name.length > NAME_MAX) fields.name = `name must be ${NAME_MAX} characters or fewer`;
  }

  let description = "";
  const descriptionValue = optionalString(body.description);
  if (descriptionValue !== undefined) {
    description = descriptionValue.trim();
    if (description.length > DESCRIPTION_MAX) {
      fields.description = `description must be ${DESCRIPTION_MAX} characters or fewer`;
    }
  }

  let status = "active";
  try {
    status = parseProjectStatus(body.status);
  } catch (err) {
    if (err instanceof BadRequestError) fields.status = err.message;
    else throw err;
  }

  if (Object.keys(fields).length > 0) throw new BadRequestError("Validation failed", fields);
  return { name, description, status };
}

// ---------------------------------------------------------------------------
// DB row helpers
// ---------------------------------------------------------------------------

const PROJECT_SELECT = "SELECT id, name, description, status, created_at, updated_at FROM project";
const TASK_SELECT = `SELECT t.id, t.project_id, p.name AS project_name, t.title, t.description,
                            t.status, t.priority, t.created_at, t.updated_at
                       FROM task t JOIN project p ON p.id = t.project_id`;

function getProject(db, id) {
  return db.prepare(`${PROJECT_SELECT} WHERE id = ?`).get(id) || null;
}

function getTask(db, id) {
  return db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) || null;
}

function requireDb(db) {
  if (db === null) throw new ServiceUnavailableError();
  return db;
}

function escapeLike(value) {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ---------------------------------------------------------------------------
// Request body + router framework (native node:http, no framework)
// ---------------------------------------------------------------------------

function readJsonObject(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new HttpError(413, "Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        return reject(new BadRequestError("Request body is empty"));
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return reject(new BadRequestError("Request body is not valid JSON"));
      }
      if (!isRecord(body)) {
        return reject(new BadRequestError("Request body must be a JSON object"));
      }
      return resolvePromise(body);
    });
    req.on("error", (err) => reject(new HttpError(400, `Failed to read request body: ${err.message}`)));
  });
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";
  if (pathname.includes("\0")) return false;

  const segments = pathname.split("/").filter((s) => s !== "");
  if (segments.some((s) => s === ".." || s === ".")) return false;

  const candidate = resolve(join(PUBLIC_ROOT, ...segments));
  if (candidate !== PUBLIC_ROOT && !candidate.startsWith(PUBLIC_ROOT + sep)) return false;

  let info;
  try {
    info = statSync(candidate);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;

  const type = MIME_TYPES[extname(candidate).toLowerCase()] || "application/octet-stream";
  const isHead = req.method === "HEAD";
  res.writeHead(200, {
    "content-type": type,
    "content-length": info.size,
  });
  if (isHead) {
    res.end();
    return true;
  }
  createReadStream(candidate).pipe(res);
  return true;
}

function asyncHandler(handler) {
  return (req, res, params, query) => {
    Promise.resolve()
      .then(() => handler(req, res, params, query))
      .catch((err) => sendJsonError(res, err));
  };
}

function matchRoute(registry, method, segments) {
  let fallback = null;
  outer: for (const route of registry) {
    if (route.segments.length !== segments.length) continue;
    const params = {};
    for (let i = 0; i < segments.length; i++) {
      const pattern = route.segments[i];
      const value = segments[i];
      if (pattern === ":id") {
        if (value === "") continue outer;
        params.id = value;
      } else if (pattern !== value) {
        continue outer;
      }
    }
    if (route.methods.includes(method)) return { route, params };
    fallback = fallback || { route, params };
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// App factory: returns a native node:http request listener
// ---------------------------------------------------------------------------

export function createRequestListener({ config, db }) {
  const routes = [
    { method: "GET", path: "/api/health/live", methods: ["GET"] },
    { method: "GET", path: "/api/health/ready", methods: ["GET"] },
    { method: "GET", path: "/api/meta", methods: ["GET"] },
    { method: "GET", path: "/api/projects", methods: ["GET", "POST"] },
    { method: "GET", path: "/api/projects/:id", methods: ["GET", "PATCH", "DELETE"] },
    { method: "GET", path: "/api/tasks", methods: ["GET", "POST"] },
    { method: "GET", path: "/api/tasks/:id", methods: ["GET", "PATCH", "DELETE"] },
  ].map((r) => ({ ...r, segments: r.path.split("/").filter((s) => s !== "") }));

  const handlers = {
    "GET /api/health/live": (_req, res) =>
      sendJson(res, 200, { status: "alive", timestamp: new Date().toISOString() }),

    "GET /api/health/ready": (_req, res) => {
      const probe = probeDb(config.dbPath);
      if (probe.ok) return sendJson(res, 200, { status: "ready", db: "sqlite", checked_at: probe.detail || null });
      return sendJson(res, 503, { status: "unavailable", db: "sqlite", detail: probe.detail });
    },

    "GET /api/meta": (_req, res) =>
      sendJson(res, 200, {
        name: "deploy-test-nodejs",
        description: "Native Node.js taskboard: node:http + better-sqlite3, validated CRUD, search/filter.",
        release: config.buildMarker,
        runtime: { name: "node", version: process.version },
        database: { engine: "sqlite", path: config.dbPath },
      }),

    "GET /api/projects": (_req, res) => {
      const d = requireDb(db);
      const rows = d
        .prepare(
          `SELECT p.id, p.name, p.description, p.status, p.created_at, p.updated_at,
                  COUNT(t.id) AS task_total,
                  SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo,
                  SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
                  SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
             FROM project p LEFT JOIN task t ON t.project_id = p.id
            GROUP BY p.id ORDER BY p.id ASC`,
        )
        .all();
      return sendJson(res, 200, {
        projects: rows.map((r) => ({
          ...r,
          task_total: Number(r.task_total) || 0,
          todo: Number(r.todo) || 0,
          in_progress: Number(r.in_progress) || 0,
          done: Number(r.done) || 0,
        })),
      });
    },

    "POST /api/projects": async (req, res) => {
      const d = requireDb(db);
      const input = validateProjectInput(await readJsonObject(req));
      const result = d
        .prepare("INSERT INTO project (name, description, status) VALUES (?, ?, ?)")
        .run(input.name, input.description, input.status);
      return sendJson(res, 201, { project: getProject(d, Number(result.lastInsertRowid)) });
    },

    "GET /api/projects/:id": (_req, res, params) => {
      const d = requireDb(db);
      const id = parseId(params.id);
      const project = getProject(d, id);
      if (!project) return sendJson(res, 404, { error: "Project not found" });
      const tasks = d.prepare("SELECT * FROM task WHERE project_id = ? ORDER BY id DESC").all(id);
      return sendJson(res, 200, { project, tasks });
    },

    "PATCH /api/projects/:id": async (req, res, params) => {
      const d = requireDb(db);
      const id = parseId(params.id);
      const current = getProject(d, id);
      if (!current) return sendJson(res, 404, { error: "Project not found" });
      const body = await readJsonObject(req);
      if (body.name === undefined && body.description === undefined && body.status === undefined) {
        throw new BadRequestError("Nothing to update: provide at least one of name, description, status");
      }
      const merged = {
        name: body.name ?? current.name,
        description: body.description ?? current.description,
        status: body.status ?? current.status,
      };
      const input = validateProjectInput(merged);
      d.prepare(
        "UPDATE project SET name = ?, description = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(input.name, input.description, input.status, id);
      return sendJson(res, 200, { project: getProject(d, id) });
    },

    "DELETE /api/projects/:id": (_req, res, params) => {
      const d = requireDb(db);
      const id = parseId(params.id);
      const result = d.prepare("DELETE FROM project WHERE id = ?").run(id);
      if (Number(result.changes) === 0) return sendJson(res, 404, { error: "Project not found" });
      res.writeHead(204).end();
    },

    "GET /api/tasks": (_req, res, params, query) => {
      const d = requireDb(db);
      const q = (query.get("q") || "").trim();
      const statusParam = (query.get("status") || "").trim() || null;
      const priorityParam = (query.get("priority") || "").trim() || null;
      const projectRaw = (query.get("project_id") || "").trim() || null;
      const projectId = projectRaw === null ? null : parseId(projectRaw);

      if (statusParam !== null && !TASK_STATUSES.includes(statusParam)) {
        throw new BadRequestError(`status filter must be one of: ${TASK_STATUSES.join(", ")}`);
      }
      if (priorityParam !== null && !PRIORITIES.includes(priorityParam)) {
        throw new BadRequestError(`priority filter must be one of: ${PRIORITIES.join(", ")}`);
      }

      const like = q ? `%${escapeLike(q)}%` : null;

      const tasks = d
        .prepare(
          `SELECT t.id, t.project_id, p.name AS project_name, t.title, t.description,
                  t.status, t.priority, t.created_at, t.updated_at
             FROM task t JOIN project p ON p.id = t.project_id
            WHERE (($project IS NULL) OR t.project_id = $project)
              AND (($status IS NULL) OR t.status = $status)
              AND (($priority IS NULL) OR t.priority = $priority)
              AND (($q IS NULL) OR t.title LIKE $q ESCAPE '\\' OR t.description LIKE $q ESCAPE '\\')
            ORDER BY t.id DESC`,
        )
        .all({ project: projectId, status: statusParam, priority: priorityParam, q: like });

      return sendJson(res, 200, {
        tasks,
        count: tasks.length,
        query: { q, status: statusParam, priority: priorityParam, project_id: projectId },
      });
    },

    "POST /api/tasks": async (req, res) => {
      const d = requireDb(db);
      const body = await readJsonObject(req);
      const input = validateTaskInput(body, true);
      if (!getProject(d, input.project_id)) {
        throw new BadRequestError("project_id does not exist", { project_id: "no project with that id" });
      }
      const result = d
        .prepare(
          "INSERT INTO task (project_id, title, description, status, priority) VALUES (?, ?, ?, ?, ?)",
        )
        .run(input.project_id, input.title, input.description, input.status, input.priority);
      return sendJson(res, 201, { task: getTask(d, Number(result.lastInsertRowid)) });
    },

    "GET /api/tasks/:id": (_req, res, params) => {
      const d = requireDb(db);
      const id = parseId(params.id);
      const task = getTask(d, id);
      if (!task) return sendJson(res, 404, { error: "Task not found" });
      return sendJson(res, 200, { task });
    },

    "PATCH /api/tasks/:id": async (req, res, params) => {
      const d = requireDb(db);
      const id = parseId(params.id);
      const current = getTask(d, id);
      if (!current) return sendJson(res, 404, { error: "Task not found" });
      const body = await readJsonObject(req);
      const keys = ["title", "description", "status", "priority", "project_id"];
      if (!keys.some((k) => body[k] !== undefined)) {
        throw new BadRequestError("Nothing to update: provide at least one of title, description, status, priority");
      }
      const merged = {};
      for (const k of keys) if (body[k] !== undefined) merged[k] = body[k];
      const input = validateTaskInput(merged, false);
      if (input.project_id && !getProject(d, input.project_id)) {
        throw new BadRequestError("project_id does not exist", { project_id: "no project with that id" });
      }
      if (!input.project_id) input.project_id = current.project_id;
      d.prepare(
        `UPDATE task SET project_id = ?, title = ?, description = ?, status = ?, priority = ?,
                updated_at = datetime('now') WHERE id = ?`,
      ).run(input.project_id, input.title, input.description, input.status, input.priority, id);
      return sendJson(res, 200, { task: getTask(d, id) });
    },

    "DELETE /api/tasks/:id": (_req, res, params) => {
      const d = requireDb(db);
      const id = parseId(params.id);
      const result = d.prepare("DELETE FROM task WHERE id = ?").run(id);
      if (Number(result.changes) === 0) return sendJson(res, 404, { error: "Task not found" });
      res.writeHead(204).end();
    },
  };

  return (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const segments = url.pathname.split("/").filter((s) => s !== "");
    const method = req.method;

    if (segments.length === 0) {
      if (method === "GET" || method === "HEAD") {
        const served = serveStatic(req, res);
        if (served) return;
      }
      return sendJson(res, 404, { error: "Not found" });
    }

    const match = matchRoute(routes, method, segments);
    if (match) {
      const key = `${method} ${match.route.path}`;
      const handler = handlers[key];
      if (handler) {
        return asyncHandler(handler)(req, res, match.params, url.searchParams);
      }
    }

    const isApi = url.pathname.startsWith("/api/");
    if (!isApi && (method === "GET" || method === "HEAD")) {
      const served = serveStatic(req, res);
      if (served) return;
    }

    return sendJson(res, 404, { error: "Not found" });
  };
}