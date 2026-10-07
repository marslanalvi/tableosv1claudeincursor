import net from "node:net";
import tls from "node:tls";
import type { TabulaDb } from "@tabula/db";
import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";

/**
 * Outbound email. Every message is stored in `core.email_outbox` (the dev
 * "mailbox"). When `SMTP_URL` is set (smtp://user:pass@host:587 or
 * smtps://user:pass@host:465) the message is also delivered over SMTP.
 * `SMTP_FROM` sets the sender (default "TableOS <no-reply@tableos.local>").
 */
export interface OutgoingEmail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  orgId?: string | null;
  workspaceId?: string | null;
  source?: string;
  sourceId?: string | null;
}

export interface SendResult {
  id: string;
  status: "stored" | "sent" | "failed";
  error?: string;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

export async function sendEmail(db: TabulaDb, msg: OutgoingEmail): Promise<SendResult> {
  const id = generateUuidV7();
  const to = msg.to.map((s) => s.trim()).filter(isValidEmail);
  const cc = (msg.cc ?? []).map((s) => s.trim()).filter(isValidEmail);
  if (to.length === 0) {
    throw new Error("No valid recipient email address");
  }
  await sql`
    INSERT INTO core.email_outbox (id, org_id, workspace_id, source, source_id, to_addresses, cc_addresses, subject, body_text)
    VALUES (
      ${id}, ${msg.orgId ?? null}, ${msg.workspaceId ?? null}, ${msg.source ?? "automation"},
      ${msg.sourceId ?? null}, ${to}::text[], ${cc}::text[], ${msg.subject.slice(0, 998)}, ${msg.text}
    )
  `.execute(db);

  const smtpUrl = process.env["SMTP_URL"];
  if (!smtpUrl) {
    console.info(`[mail] stored ${id} → ${to.join(", ")}: ${msg.subject}`);
    return { id, status: "stored" };
  }
  try {
    await smtpSend(smtpUrl, {
      from: process.env["SMTP_FROM"] ?? "TableOS <no-reply@tableos.local>",
      to,
      cc,
      subject: msg.subject,
      text: msg.text,
    });
    await sql`UPDATE core.email_outbox SET status = 'sent', sent_at = now() WHERE id = ${id}`.execute(db);
    return { id, status: "sent" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await sql`UPDATE core.email_outbox SET status = 'failed', error = ${error} WHERE id = ${id}`.execute(db);
    return { id, status: "failed", error };
  }
}

// ---------------------------------------------------------------------------
// Minimal SMTP client (AUTH PLAIN, STARTTLS, implicit TLS). Enough for relays
// such as Mailpit, SES SMTP, SendGrid SMTP.
// ---------------------------------------------------------------------------

interface SmtpMessage {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
}

function addrOnly(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1]! : s).trim();
}

async function smtpSend(url: string, msg: SmtpMessage): Promise<void> {
  const u = new URL(url);
  const implicitTls = u.protocol === "smtps:";
  const port = Number(u.port || (implicitTls ? 465 : 587));
  const host = u.hostname;
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);

  let socket: net.Socket = implicitTls
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setTimeout(15_000);

  let buffer = "";
  let waiter: ((line: string) => void) | null = null;
  const lines: string[] = [];
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      // multi-line replies use "250-"; the final line uses "250 "
      if (/^\d{3} /.test(line) || !/^\d{3}-/.test(line)) {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(line);
        } else {
          lines.push(line);
        }
      }
    }
  };
  const attach = (s: net.Socket) => {
    s.on("data", onData);
  };
  attach(socket);

  const read = () =>
    new Promise<string>((resolve, reject) => {
      const queued = lines.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      waiter = resolve;
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("SMTP timeout")));
    });
  const expect = async (code: string) => {
    const line = await read();
    if (!line.startsWith(code)) throw new Error(`SMTP: ${line}`);
    return line;
  };
  const cmd = async (c: string, code: string) => {
    socket.write(`${c}\r\n`);
    return expect(code);
  };

  await expect("220");
  await cmd(`EHLO tabula.local`, "250");
  if (!implicitTls && port !== 25) {
    await cmd("STARTTLS", "220");
    socket.removeListener("data", onData);
    socket = tls.connect({ socket, servername: host });
    attach(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", () => resolve());
      socket.once("error", reject);
    });
    await cmd(`EHLO tabula.local`, "250");
  }
  if (user) {
    const token = Buffer.from(`\u0000${user}\u0000${pass}`).toString("base64");
    await cmd(`AUTH PLAIN ${token}`, "235");
  }
  await cmd(`MAIL FROM:<${addrOnly(msg.from)}>`, "250");
  for (const r of [...msg.to, ...msg.cc]) {
    await cmd(`RCPT TO:<${r}>`, "25");
  }
  await cmd("DATA", "354");
  const headers = [
    `From: ${msg.from}`,
    `To: ${msg.to.join(", ")}`,
    ...(msg.cc.length ? [`Cc: ${msg.cc.join(", ")}`] : []),
    `Subject: ${msg.subject.replace(/[\r\n]+/g, " ")}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  const body = msg.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  await cmd(`${headers.join("\r\n")}\r\n\r\n${body}\r\n.`, "250");
  socket.write("QUIT\r\n");
  socket.end();
}
