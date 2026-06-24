/**
 * Atomic file writes: write to a temp file in the same directory, fsync, then
 * rename over the target. Rename is atomic on POSIX, so readers never observe a
 * partially-written file and a crash mid-write cannot corrupt the target.
 */
import { open, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface AtomicWriteOptions {
  /** File mode for the created file (e.g. 0o600 for secrets). */
  mode?: number;
}

/**
 * Atomically write `data` to `targetPath`. Ensures the parent directory exists.
 */
export async function atomicWriteFile(
  targetPath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(tmpPath, "wx", options.mode ?? 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    await safeUnlink(tmpPath);
    throw err;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(path);
  } catch {
    // ignore
  }
}
