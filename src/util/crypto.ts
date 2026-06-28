/**
 * Authenticated symmetric encryption for secrets at rest (the MSAL token
 * cache). Uses AES-256-GCM with a random 96-bit IV and the built-in 128-bit
 * auth tag, so tampering is detected on decrypt.
 *
 * The 32-byte key is supplied by the operator via env/Docker secret and parsed
 * with {@link parseKey}; it is never persisted by this module.
 *
 * On-disk format (single line, base64 fields):  v1:<iv>:<tag>:<ciphertext>
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = "v1";

/**
 * Parse a 32-byte key from a base64 or hex string (e.g. the value of
 * `TASK_SYNC_TOKEN_KEY`). Throws if the decoded length is not 32 bytes.
 */
export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  let key: Buffer | undefined;

  // Try hex first when it looks like hex of the right length.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === KEY_BYTES) key = buf;
  }

  if (!key || key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must decode to ${KEY_BYTES} bytes (got ${key?.length ?? 0}). ` +
        "Provide 32 bytes as base64 or 64 hex chars.",
    );
  }
  return key;
}

/**
 * Generate a fresh random 32-byte key, base64-encoded. Intended for operator
 * setup (e.g. seeding `TASK_SYNC_TOKEN_KEY`) and used by the unit tests; not
 * referenced by the running service.
 */
export function generateKeyBase64(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/** Encrypt UTF-8 plaintext, returning the serialized envelope string. */
export function encryptString(plaintext: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Decrypt an envelope produced by {@link encryptString}. Throws on tamper. */
export function decryptString(envelope: string, key: Buffer): string {
  assertKey(key);
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed or unsupported ciphertext envelope.");
  }
  const iv = Buffer.from(parts[1] as string, "base64");
  const tag = Buffer.from(parts[2] as string, "base64");
  const ciphertext = Buffer.from(parts[3] as string, "base64");
  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length.");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes.`);
  }
}
