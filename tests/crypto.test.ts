import { describe, it, expect } from "vitest";
import {
  parseKey,
  generateKeyBase64,
  encryptString,
  decryptString,
  safeEqual,
} from "../src/util/crypto.js";

describe("util/crypto", () => {
  it("round-trips encrypt/decrypt", () => {
    const key = parseKey(generateKeyBase64());
    const plaintext = "secret token 🔐 with unicode";
    const envelope = encryptString(plaintext, key);
    expect(envelope).not.toContain(plaintext);
    expect(decryptString(envelope, key)).toBe(plaintext);
  });

  it("produces a fresh IV per call (non-deterministic ciphertext)", () => {
    const key = parseKey(generateKeyBase64());
    const a = encryptString("same", key);
    const b = encryptString("same", key);
    expect(a).not.toBe(b);
    expect(decryptString(a, key)).toBe("same");
    expect(decryptString(b, key)).toBe("same");
  });

  it("fails to decrypt with the wrong key", () => {
    const env = encryptString("data", parseKey(generateKeyBase64()));
    expect(() => decryptString(env, parseKey(generateKeyBase64()))).toThrow();
  });

  it("fails to decrypt tampered ciphertext (auth tag check)", () => {
    const key = parseKey(generateKeyBase64());
    const env = encryptString("data", key);
    const tampered = env.slice(0, -2) + (env.endsWith("A") ? "B" : "A");
    expect(() => decryptString(tampered, key)).toThrow();
  });

  it("parseKey accepts base64 and hex 32-byte keys and rejects bad lengths", () => {
    const b64 = generateKeyBase64();
    expect(parseKey(b64)).toHaveLength(32);
    const hex = parseKey(b64).toString("hex");
    expect(parseKey(hex)).toHaveLength(32);
    expect(() => parseKey("tooshort")).toThrow();
  });

  it("safeEqual compares strings in constant time semantics", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
