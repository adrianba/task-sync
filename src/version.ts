/**
 * Single source of truth for the running version.
 *
 * Read from `package.json` at runtime via `import.meta.url` so the value always
 * tracks the published package without a code edit or build-time substitution.
 * This resolves correctly both in development (`src/version.ts` → repo root
 * `package.json`) and in the container image (`dist/version.js` → `/app/package.json`,
 * which the Dockerfile copies next to `dist/`).
 */
import { readFileSync } from "node:fs";

function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // fall through to sentinel
  }
  return "0.0.0-dev";
}

/** The current task-sync version, e.g. "1.2.3". */
export const VERSION: string = readVersion();
