/** Supernote's MariaDB uses 3-byte utf8, so non-BMP code points must not be stored raw. */
const ENCODED_CODE_POINT = /\[U\+([0-9A-Fa-f]{1,6})\]/g;

export function encodeEmoji(text: string): string {
  let encoded = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && codePoint > 0xffff) {
      encoded += `[U+${codePoint.toString(16).toUpperCase()}]`;
    } else {
      encoded += char;
    }
  }
  return encoded;
}

export function decodeEmoji(text: string): string {
  return text.replace(ENCODED_CODE_POINT, (match, hex: string) => {
    const codePoint = Number.parseInt(hex, 16);
    if (
      !Number.isFinite(codePoint) ||
      codePoint <= 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return match;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

export function truncateEncoded(text: string, max: number): string {
  if (max <= 0) return "";
  const encoded = encodeEmoji(text);
  if (encoded.length <= max) return encoded;

  let truncated = encoded.slice(0, max);
  const tokenStart = truncated.lastIndexOf("[U+");
  if (tokenStart !== -1) {
    const tokenEnd = encoded.indexOf("]", tokenStart);
    if (tokenEnd >= max) truncated = truncated.slice(0, tokenStart);
  }
  return truncated;
}
