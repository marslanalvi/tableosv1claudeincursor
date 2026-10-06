import type { DecodedCursor, ManualOrderCursor } from "./types.js";

export class InvalidCursorError extends Error {
  constructor(message = "INVALID_CURSOR") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

function encodeBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

interface CursorV2 {
  v: 2;
  s: string;
  k: (string | null)[];
  id: string;
}

export function encodeRecordCursor(signature: string, cursor: DecodedCursor): string {
  const c: CursorV2 = { v: 2, s: signature, k: cursor.keys, id: cursor.id };
  return encodeBase64Url(JSON.stringify(c));
}

/**
 * Decode a cursor for a query with `signature` (sort spec hash).
 * `legacyManual` is true when the query uses the default manual order (legacy
 * cursors are only valid there). Throws InvalidCursorError.
 */
export function decodeRecordCursor(
  encoded: string,
  signature: string,
  legacyManual: boolean,
): DecodedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(encoded));
  } catch {
    const legacy = decodeLegacyCursor(encoded);
    if (legacy && legacyManual) return { keys: [legacy.manualOrder], id: legacy.id };
    throw new InvalidCursorError("Invalid cursor");
  }
  if (!parsed || typeof parsed !== "object") throw new InvalidCursorError("Invalid cursor");
  const o = parsed as Record<string, unknown>;
  if (o["v"] === 2) {
    const k = o["k"];
    if (
      typeof o["s"] !== "string" ||
      typeof o["id"] !== "string" ||
      !Array.isArray(k) ||
      !k.every((x) => x === null || typeof x === "string")
    ) {
      throw new InvalidCursorError("Invalid cursor");
    }
    if (o["s"] !== signature) {
      throw new InvalidCursorError("Cursor does not match this query's sort; restart pagination");
    }
    return { keys: k as (string | null)[], id: o["id"] };
  }
  if (o["kind"] === "manualOrder" && typeof o["manualOrder"] === "string" && typeof o["id"] === "string" && legacyManual) {
    return { keys: [o["manualOrder"]], id: o["id"] };
  }
  throw new InvalidCursorError("Invalid cursor");
}

/** Legacy cursor: `manualOrder|id` */
export function decodeLegacyCursor(encoded: string): ManualOrderCursor | null {
  if (!encoded.includes("|")) return null;
  const [manualOrder, id] = encoded.split("|");
  if (!manualOrder || !id) return null;
  return { kind: "manualOrder", manualOrder, id };
}

/** Small stable string hash (FNV-1a, hex). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
