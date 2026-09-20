import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createRequestListener } from "../src/app.js";
import { defaultConfig } from "../src/config.js";
import { openDb } from "../src/db.js";

let workDir;
let dbPath;
let db;
let base;
let degraded;
let degradedBase;
let servers = [];

function startServer(listener) {
  return new Promise((resolve, reject) => {
    const server = createServer(listener);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      servers.push(server);
      resolve({ server, port });
    });
  });
}

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  const body = await res.json();
  return { res, body };
}

async function sendJson(method, path, payload) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { res, body: await res.json().catch(() => null) };
}

async function createProject(name = "Test project") {
  const { res, body } = await sendJson("POST", "/api/projects", {
    name,
    description: "a",
    status: "active",
  });
  assert.equal(res.status, 201);
  return body.project;
}

async function createTask(overrides = {}) {
  const { res, body } = await sendJson("POST", "/api/tasks", {
    project_id: overrides.project_id ?? 1,
    title: "Task title",
    description: "desc",
    status: "todo",
    priority: "medium",
    ...overrides,
  });
  assert.equal(res.status, 201);
  return body.task;
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nodejs-taskboard-test-"));
  dbPath = join(workDir, "taskboard.db");
  db = openDb(dbPath);
  const config = { ...defaultConfig({}), dbPath, port: 0, dataDir: workDir, buildMarker: "test-marker" };
  const { server, port } = await startServer(createRequestListener({ config, db }));
  base = `http://127.0.0.1:${port}`;

  const blockedFile = join(workDir, "blocked");
  writeFileSync(blockedFile, "a regular file, not a directory");
  const blockedPath = join(blockedFile, "unreachable.db");
  const degradedConfig = { ...config, dbPath: blockedPath };
  const degradedServer = await startServer(createRequestListener({ config: degradedConfig, db: null }));
  degradedBase = `http://127.0.0.1:${degradedServer.port}`;
});

after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("health and readiness", () => {
  test("liveness is OK", async () => {
    const { res, body } = await getJson("/api/health/live");
    assert.equal(res.status, 200);
    assert.equal(body.status, "alive");
  });

  test("readiness is OK when database reachable", async () => {
    const { res, body } = await getJson("/api/health/ready");
    assert.equal(res.status, 200);
    assert.equal(body.status, "ready");
  });

  test("readiness fails when the database is unavailable while liveness stays up", async () => {
    const live = await fetch(`${degradedBase}/api/health/live`);
    assert.equal(live.status, 200);

    const ready = await fetch(`${degradedBase}/api/health/ready`);
    assert.equal(ready.status, 503);
    const readyBody = await ready.json();
    assert.equal(readyBody.status, "unavailable");

    const list = await fetch(`${degradedBase}/api/projects`);
    assert.equal(list.status, 503);
    const listBody = await list.json();
    assert.equal(listBody.error, "Service Unavailable");
  });

  test("meta exposes non-sensitive release marker", async () => {
    const { res, body } = await getJson("/api/meta");
    assert.equal(res.status, 200);
    assert.equal(body.release, "test-marker");
    assert.equal(body.runtime.name, "node");
    assert.equal(body.database.engine, "sqlite");
  });
});

describe("static UI", () => {
  test("serves index.html at /", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /Node\.js Taskboard/);
  });

  test("serves client assets", async () => {
    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const css = await fetch(`${base}/style.css`);
    assert.equal(css.status, 200);
  });

  test("rejects path traversal and unknown assets", async () => {
    assert.equal((await fetch(`${base}/nope.txt`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/etc/passwd`)).status, 404);
  });
});

describe("project CRUD with validation", () => {
  test("creates and lists projects", async () => {
    await createProject("CRUD alpha");
    const { res, body } = await getJson("/api/projects");
    assert.equal(res.status, 200);
    const projects = body.projects;
    assert.ok(projects.some((p) => p.name === "CRUD alpha"));
    assert.ok(projects.some((p) => p.name === "Launch checklist"));
  });

  test("reads a project with its tasks", async () => {
    const project = await createProject("reads-with-tasks");
    const task = await createTask({ project_id: project.id, title: "child" });
    const { res, body } = await getJson(`/api/projects/${project.id}`);
    assert.equal(res.status, 200);
    assert.equal(body.project.id, project.id);
    assert.ok(body.tasks.some((t) => t.id === task.id));
  });

  test("updates a project", async () => {
    const p = await createProject("rename-me");
    const { res, body } = await sendJson("PATCH", `/api/projects/${p.id}`, {
      name: "renamed",
      status: "archived",
    });
    assert.equal(res.status, 200);
    assert.equal(body.project.name, "renamed");
    assert.equal(body.project.status, "archived");
  });

  test("deletes a project and cascades its tasks", async () => {
    const p = await createProject("to-delete");
    const task = await createTask({ project_id: p.id, title: "cascade me" });
    const res = await fetch(`${base}/api/projects/${p.id}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal((await fetch(`${base}/api/projects/${p.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/tasks/${task.id}`)).status, 404);
  });

  test("rejects blank project name", async () => {
    const { res, body } = await sendJson("POST", "/api/projects", { name: "   ", status: "active" });
    assert.equal(res.status, 400);
    assert.ok(body.fields.name);
  });

  test("rejects over-long project name", async () => {
    const { res } = await sendJson("POST", "/api/projects", { name: "x".repeat(121) });
    assert.equal(res.status, 400);
  });

  test("rejects invalid project status", async () => {
    const { res } = await sendJson("POST", "/api/projects", { name: "ok", status: "warp" });
    assert.equal(res.status, 400);
  });

  test("rejects empty project patch", async () => {
    const p = await createProject("empty-patch");
    const { res } = await sendJson("PATCH", `/api/projects/${p.id}`, {});
    assert.equal(res.status, 400);
  });
});

describe("task CRUD with validation", () => {
  test("creates, reads, lists tasks", async () => {
    const task = await createTask({ title: "first task", status: "done", priority: "high" });
    assert.equal(task.title, "first task");
    const got = await fetch(`${base}/api/tasks/${task.id}`);
    assert.equal(got.status, 200);
    const body = await got.json();
    assert.equal(body.task.id, task.id);
    const list = await fetch(`${base}/api/tasks?project_id=1`);
    const listed = await list.json();
    assert.ok(listed.tasks.some((t) => t.id === task.id));
  });

  test("updates a task", async () => {
    const task = await createTask({ title: "before" });
    const { res, body } = await sendJson("PATCH", `/api/tasks/${task.id}`, {
      title: "after",
      status: "in_progress",
      priority: "high",
    });
    assert.equal(res.status, 200);
    const t = body.task;
    assert.equal(t.title, "after");
    assert.equal(t.status, "in_progress");
    assert.equal(t.priority, "high");
  });

  test("deletes a task", async () => {
    const task = await createTask({ title: "to-remove" });
    const res = await fetch(`${base}/api/tasks/${task.id}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal((await fetch(`${base}/api/tasks/${task.id}`)).status, 404);
  });

  test("rejects non-integer id with 400", async () => {
    assert.equal((await fetch(`${base}/api/tasks/abc`)).status, 400);
    assert.equal((await fetch(`${base}/api/tasks/0`)).status, 400);
  });

  test("rejects blank task title", async () => {
    const { res, body } = await sendJson("POST", "/api/tasks", {
      project_id: 1,
      title: " \t ",
      status: "todo",
    });
    assert.equal(res.status, 400);
    assert.ok(body.fields.title);
  });

  test("rejects non-string task title", async () => {
    const { res } = await sendJson("POST", "/api/tasks", { project_id: 1, title: 42 });
    assert.equal(res.status, 400);
  });

  test("rejects over-long task title", async () => {
    const { res, body } = await sendJson("POST", "/api/tasks", {
      project_id: 1,
      title: "x".repeat(201),
    });
    assert.equal(res.status, 400);
    assert.ok(body.fields.title);
  });

  test("rejects invalid status and priority", async () => {
    const badStatus = await sendJson("POST", "/api/tasks", { project_id: 1, title: "x", status: "warp" });
    assert.equal(badStatus.res.status, 400);
    const badPriority = await sendJson("POST", "/api/tasks", { project_id: 1, title: "x", priority: "urgent" });
    assert.equal(badPriority.res.status, 400);
  });

  test("rejects missing or nonexistent project_id", async () => {
    const missing = await sendJson("POST", "/api/tasks", { title: "x" });
    assert.equal(missing.res.status, 400);
    const none = await sendJson("POST", "/api/tasks", { project_id: 999999, title: "x" });
    assert.equal(none.res.status, 400);
    assert.ok(none.body.fields.project_id);
  });

  test("rejects malformed JSON and non-object bodies", async () => {
    const badJson = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);
    const arrayBody = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1,2,3]",
    });
    assert.equal(arrayBody.status, 400);
  });

  test("rejects empty PATCH body", async () => {
    const task = await createTask({ title: "stable" });
    const { res } = await sendJson("PATCH", `/api/tasks/${task.id}`, {});
    assert.equal(res.status, 400);
  });
});

describe("not found handling", () => {
  test("unknown project and task ids return 404", async () => {
    assert.equal((await fetch(`${base}/api/projects/999999`)).status, 404);
    assert.equal((await fetch(`${base}/api/tasks/999999`)).status, 404);
    assert.equal((await fetch(`${base}/api/projects/999999`, { method: "PATCH", body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/api/tasks/999999`, { method: "PATCH", body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/api/projects/999999`, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(`${base}/api/tasks/999999`, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  });

  test("invalid method returns 404 with a JSON body", async () => {
    const res = await fetch(`${base}/api/tasks`, { method: "PUT" });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "Not found");
  });
});

describe("search and filter", () => {
  test("searches titles and descriptions", async () => {
    await createTask({ title: "Hiring pipeline review", description: "schedule interviews" });
    await createTask({ title: "Fix checkout bug", description: "nothing here" });
    const { body } = await getJson("/api/tasks?q=Hiring");
    const titles = body.tasks.map((t) => t.title);
    assert.ok(titles.includes("Hiring pipeline review"));
    assert.ok(!titles.includes("Fix checkout bug"));
    const desc = await getJson("/api/tasks?q=interviews");
    assert.ok(desc.body.tasks.some((t) => t.title === "Hiring pipeline review"));
  });

  test("escapes LIKE wildcards in queries", async () => {
    await createTask({ title: "100% done milestone", description: "" });
    const { body } = await getJson(`/api/tasks?q=${encodeURIComponent("%")}`);
    const tasks = body.tasks;
    assert.ok(tasks.some((t) => t.title === "100% done milestone"));
    assert.ok(tasks.length > 0);
    assert.ok(tasks.every((t) => !t.title.includes("Hiring")));
  });

  test("filters by status and priority and combines them", async () => {
    await createTask({ title: "status done one", status: "done", priority: "high" });
    await createTask({ title: "status in_progress one", status: "in_progress", priority: "high" });
    const done = await getJson("/api/tasks?status=done");
    assert.ok(done.body.tasks.length > 0);
    assert.ok(done.body.tasks.every((t) => t.status === "done"));
    assert.ok(done.body.tasks.some((t) => t.title === "status done one"));
    const highDone = await getJson("/api/tasks?status=done&priority=high&q=status");
    assert.equal(highDone.body.tasks.length, 1);
    assert.equal(highDone.body.tasks[0].title, "status done one");
  });

  test("rejects an invalid status filter", async () => {
    const res = await fetch(`${base}/api/tasks?status=warp`);
    assert.equal(res.status, 400);
  });
});

describe("schema, seed, and persistence", () => {
  test("seed data is idempotent across database opens", () => {
    const count = (d, t) => Number(d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    const fresh = openDb(dbPath);
    const counts = { projects: count(fresh, "project"), tasks: count(fresh, "task") };
    fresh.close();
    assert.ok(counts.projects >= 3);
    const second = openDb(dbPath);
    const counts2 = { projects: count(second, "project"), tasks: count(second, "task") };
    second.close();
    assert.deepEqual(counts2, counts);
  });

  test("rows persist across database close and reopen", () => {
    const fresh = openDb(dbPath);
    const res = fresh
      .prepare("INSERT INTO project (name, description, status) VALUES (?, ?, 'active')")
      .run("persist target", "proves restart persistence");
    const projId = Number(res.lastInsertRowid);
    fresh.close();

    const reopened = openDb(dbPath);
    const row = reopened.prepare("SELECT * FROM project WHERE id = ?").get(projId);
    reopened.close();
    assert.ok(row);
    assert.equal(row.name, "persist target");
  });

  test("database grows a non-empty file on disk", () => {
    const st = statSync(dbPath);
    assert.ok(st.size > 0);
  });
});