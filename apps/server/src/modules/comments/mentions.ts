import { decodePublicId } from "@tabula/types";

/**
 * Mentions in comment bodies. Supported syntaxes:
 *  - `@[Display Name](usr_…)`  (what the web composer inserts)
 *  - `@user:<uuid>`            (legacy)
 */
const MARKUP_RE = /@\[([^\]\n]{1,200})\]\((usr_[A-Za-z0-9]+)\)/g;
const LEGACY_RE = /@(user|team|contact):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

export interface ParsedMention {
  principalType: "user" | "team" | "contact";
  principalId: string;
}

export function parseMentions(body: string): ParsedMention[] {
  const seen = new Set<string>();
  const out: ParsedMention[] = [];
  const push = (principalType: ParsedMention["principalType"], principalId: string) => {
    const key = `${principalType}:${principalId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ principalType, principalId });
  };
  for (const match of body.matchAll(MARKUP_RE)) {
    const id = match[2];
    if (!id) continue;
    try {
      push("user", String(decodePublicId(id, "usr").uuid));
    } catch {
      /* ignore malformed ids */
    }
  }
  for (const match of body.matchAll(LEGACY_RE)) {
    const type = (match[1] ?? "user").toLowerCase() as ParsedMention["principalType"];
    const id = match[2];
    if (id) push(type, id.toLowerCase());
  }
  return out;
}

/** Plain-text rendering of a body (mention markup → `@Name`), for notifications. */
export function plainTextBody(body: string): string {
  return body.replace(MARKUP_RE, (_m, name: string) => `@${name}`);
}
