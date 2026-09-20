import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");

export function defaultConfig(env = process.env) {
  const dataDir = env.DATA_DIR ? resolve(env.DATA_DIR) : join(ROOT, "data");
  const dbPath = env.DATABASE_PATH
    ? resolve(env.DATABASE_PATH)
    : join(dataDir, "taskboard.db");

  let buildMarker = (env.BUILD_MARKER || "").trim();
  if (!buildMarker) {
    const versionFile = join(ROOT, "VERSION");
    if (existsSync(versionFile)) {
      const value = readFileSync(versionFile, "utf8").trim();
      if (value) buildMarker = value;
    }
  }
  if (!buildMarker) buildMarker = "develop";

  const port = Number.parseInt(env.PORT || "8080", 10);
  const bind = env.BIND_HOST || "0.0.0.0";

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer in [0, 65535], got "${env.PORT}"`);
  }

  return { port, bind, dataDir, dbPath, buildMarker };
}