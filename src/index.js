import { createServer } from "node:http";
import { createRequestListener } from "./app.js";
import { defaultConfig } from "./config.js";
import { openDb } from "./db.js";

const config = defaultConfig();

let db = null;
try {
  db = openDb(config.dbPath);
} catch (err) {
  console.error(
    `[taskboard] FATAL: could not open database at ${config.dbPath}; ` +
      `serving liveness only, readiness and API routes will report 503. ` +
      `${err instanceof Error ? err.message : String(err)}`,
  );
}

const server = createServer(createRequestListener({ config, db }));

server.on("clientError", (err, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

try {
  server.listen(config.port, config.bind);
} catch (err) {
  console.error(
    `[taskboard] FATAL: could not bind ${config.bind}:${config.port}: ${err instanceof Error ? err.message : String(err)}`,
  );
  db?.close();
  process.exit(1);
}

server.on("listening", () => {
  console.log(
    `[taskboard] serving ${config.buildMarker} (node ${process.version}, native node:http) at http://${config.bind}:${config.port}`,
  );
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[taskboard] received ${signal}, shutting down cleanly`);
  const finish = () => {
    try {
      db?.close();
    } catch (err) {
      console.error("[taskboard] error closing database:", err);
    }
    process.exit(0);
  };
  try {
    server.close(finish);
  } catch {
    finish();
  }
  setTimeout(finish, 3000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[taskboard] unhandledRejection:", reason);
});