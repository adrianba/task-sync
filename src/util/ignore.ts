import { sep } from "node:path";

/**
 * Decide whether a vault-relative path should be excluded from scanning/watching.
 *
 * Two independent rules:
 *  - `segmentNames` — directory names skipped **anywhere** in the tree (the
 *    standard set: `.obsidian`, `.trash`, `.git`, `node_modules`).
 *  - `pathPrefixes` — **vault-relative path prefixes** (e.g. `Tasks/Templates`)
 *    matched on a segment boundary, so `Tasks/Templates` excludes
 *    `Tasks/Templates/x.md` but not `Tasks/Templates2`. Case-insensitive.
 *
 * Pure: no I/O, so it is directly unit-testable.
 *
 * @param rel a path relative to the vault root (forward- or back-slashed).
 */
export function isPathIgnored(
  rel: string,
  segmentNames: readonly string[],
  pathPrefixes: readonly string[],
): boolean {
  const normalized = rel.split(sep).join("/").split("\\").join("/").replace(/^\/+|\/+$/g, "");
  if (normalized === "" || normalized.startsWith("..")) return true;

  const segments = normalized.split("/");
  if (segments.some((s) => segmentNames.includes(s))) return true;

  const lower = normalized.toLowerCase();
  for (const prefix of pathPrefixes) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** Normalize a path prefix: backslash→slash, strip surrounding slashes, lowercase. */
export function normalizeIgnorePath(p: string): string {
  return p.trim().split("\\").join("/").replace(/^\/+|\/+$/g, "").toLowerCase();
}
