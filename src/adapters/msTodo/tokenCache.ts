import { constants } from "node:fs";
import { access, chmod, readFile } from "node:fs/promises";
import type { ICachePlugin, TokenCacheContext } from "@azure/msal-node";
import type { Logger } from "../../logger.js";
import { logger as defaultLogger } from "../../logger.js";
import { atomicWriteFile } from "../../util/atomicFile.js";
import { decryptString, encryptString } from "../../util/crypto.js";

export class EncryptedTokenCachePlugin implements ICachePlugin {
  constructor(
    private readonly filePath: string,
    private readonly key: Buffer,
    private readonly log: Logger = defaultLogger,
  ) {}

  async beforeCacheAccess(cacheContext: TokenCacheContext): Promise<void> {
    try {
      await access(this.filePath, constants.R_OK);
    } catch {
      return;
    }

    // Tighten permissions on an existing cache in case it was pre-created with
    // looser modes; writes always use 0o600 but a pre-existing file may not.
    try {
      await chmod(this.filePath, 0o600);
    } catch {
      // Best-effort (e.g. unsupported on the host filesystem); ignore.
    }

    try {
      const encrypted = await readFile(this.filePath, "utf8");
      const serialized = decryptString(encrypted, this.key);
      cacheContext.tokenCache.deserialize(serialized);
    } catch {
      // Do not log the raw error: it can carry file paths or crypto internals.
      this.log.error("Failed to decrypt MSAL token cache; starting fresh");
    }
  }

  async afterCacheAccess(cacheContext: TokenCacheContext): Promise<void> {
    if (!cacheHasChanged(cacheContext)) return;

    const serialized = cacheContext.tokenCache.serialize();
    const encrypted = encryptString(serialized, this.key);
    await atomicWriteFile(this.filePath, encrypted, { mode: 0o600 });
  }
}

export function createEncryptedTokenCachePlugin(
  filePath: string,
  key: Buffer,
  log?: Logger,
): ICachePlugin {
  return new EncryptedTokenCachePlugin(filePath, key, log);
}

function cacheHasChanged(cacheContext: TokenCacheContext): boolean {
  const value = cacheContext.cacheHasChanged as boolean | (() => boolean);
  return typeof value === "function" ? value() : value;
}
