import { DurableObject } from "cloudflare:workers";

// M0 auth is two shared secrets set by the agent on first connect: an agent key (only the listening
// process knows it) and a send key (shared with senders through the inbox link). Only their hashes are
// stored. M1 replaces this with device signatures and CPace guest sessions.

interface Keys {
  agent: string;
  send: string;
}

interface Attachment {
  role: "agent" | "sender";
  authed: boolean;
  // Agents: an id, and whether they take direct WebRTC connections. Senders: their session and its agent.
  id?: string;
  rtc?: boolean;
  sid?: string;
  agent?: string;
}

const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 10;
const MAX_AUTH_BYTES = 4096;
const MAX_SIGNAL_BYTES = 64 * 1024;

export class Inbox extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get("role");
    if (role !== "agent" && role !== "sender") return new Response("bad role", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, authed: false } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== "string" || msg.length > MAX_SIGNAL_BYTES) return;
    let m: { t?: string; key?: string; sendHash?: string; name?: string; rtc?: boolean; sid?: string; data?: unknown };
    try {
      m = JSON.parse(msg);
    } catch {
      return;
    }
    const a = ws.deserializeAttachment() as Attachment;
    if (a.authed) return this.forward(a, m);
    if (msg.length > MAX_AUTH_BYTES) return;
    if (m.t !== "auth" || typeof m.key !== "string") return reject(ws, "auth required");
    if (await this.lockedOut(a.role)) return reject(ws, "too many failed attempts");

    const hash = await sha256Hex(m.key);
    let keys = await this.ctx.storage.get<Keys>("keys");
    if (a.role === "agent" && !keys) {
      if (typeof m.sendHash !== "string" || !/^[0-9a-f]{64}$/.test(m.sendHash)) return reject(ws, "missing sendHash");
      keys = { agent: hash, send: m.sendHash };
      await this.ctx.storage.put("keys", keys);
    }
    const expected = a.role === "agent" ? keys?.agent : keys?.send;
    if (!expected || !timingSafeEqual(expected, hash)) {
      await this.recordFailure(a.role);
      return reject(ws, "bad key");
    }

    const self: Attachment = a.role === "agent" ? { ...a, authed: true, id: randomHex(8), rtc: m.rtc === true } : { ...a, authed: true };
    ws.serializeAttachment(self);
    ws.send(JSON.stringify({ t: "auth", ok: true }));
    if (a.role === "sender") this.dispatch(ws, self, (m.name ?? "").slice(0, 40) || "A browser");
  }

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {}
  }

  // Gives the sender and an agent a relay session id. If the agent takes direct connections, the sender
  // may first try WebRTC, signaling through here; the agent waits on both and uses whichever connects.
  private dispatch(sender: WebSocket, a: Attachment, from: string): void {
    const agents = this.ctx
      .getWebSockets("agent")
      .filter((w) => (w.deserializeAttachment() as Attachment).authed);
    if (agents.length === 0) {
      sender.send(JSON.stringify({ t: "offline" }));
      return;
    }
    const agent = agents[0].deserializeAttachment() as Attachment;
    const sid = randomHex(16);
    sender.serializeAttachment({ ...a, sid, agent: agent.id } satisfies Attachment);
    agents[0].send(JSON.stringify({ t: "incoming", sid, from }));
    sender.send(JSON.stringify({ t: "relay", sid, ...(agent.rtc && { rtc: true }) }));
  }

  // WebRTC signals {t:"signal", sid, data} between a sender and the agent its session went to. File bytes
  // never pass here.
  private forward(from: Attachment, m: { t?: string; sid?: string; data?: unknown }): void {
    if (m.t !== "signal" || typeof m.sid !== "string") return;
    const out = JSON.stringify({ t: "signal", sid: m.sid, data: m.data });
    const targets =
      from.role === "sender"
        ? m.sid === from.sid
          ? this.ctx.getWebSockets("agent").filter((w) => (w.deserializeAttachment() as Attachment).id === from.agent)
          : []
        : this.ctx.getWebSockets("sender").filter((w) => {
            const s = w.deserializeAttachment() as Attachment;
            return s.sid === m.sid && s.agent === from.id;
          });
    for (const w of targets) {
      try {
        w.send(out);
      } catch {}
    }
  }

  // Counted per role, so senders guessing keys cannot lock the owner's agent out.
  private async lockedOut(role: Attachment["role"]): Promise<boolean> {
    const fails = (await this.ctx.storage.get<number[]>(`fails:${role}`)) ?? [];
    return fails.filter((t) => Date.now() - t < FAIL_WINDOW_MS).length >= FAIL_LIMIT;
  }

  private async recordFailure(role: Attachment["role"]): Promise<void> {
    const fails = ((await this.ctx.storage.get<number[]>(`fails:${role}`)) ?? []).filter((t) => Date.now() - t < FAIL_WINDOW_MS);
    fails.push(Date.now());
    await this.ctx.storage.put(`fails:${role}`, fails);
  }
}

function reject(ws: WebSocket, reason: string): void {
  try {
    ws.send(JSON.stringify({ t: "auth", ok: false, reason }));
    ws.close(4401, reason);
  } catch {}
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
