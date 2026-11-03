import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

interface Peer {
  id: string;
  name: string;
  // "agent" peers are always-on CLI inboxes; browsers skip WebRTC for them and go straight to the relay.
  kind: "browser" | "agent";
}

const PEER_ID = /^[0-9a-f]{16,32}$/;
const MAX_PEERS = 50;
const MAX_SIGNAL_BYTES = 64 * 1024;
// Clients send PING every HEARTBEAT_MS and the runtime answers PONG without waking the object.
// A socket whose last ping is older than STALE_MS belongs to a frozen or vanished page (a phone that
// switched apps, a dropped network) and is pruned so others stop seeing a device that cannot answer.
// Sockets that never pinged (older CLI agents) are left alone.
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';
const STALE_MS = 35_000;
const SWEEP_MS = 15_000;

// Presence and WebRTC signaling for one room (a shared network, or a 6-digit code).
// File bytes never pass through here; peers either connect directly or get a relay session id.
export class Room extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = url.searchParams.get("id") ?? "";
    const name = (url.searchParams.get("name") ?? "").slice(0, 40) || "Unnamed device";
    const kind = url.searchParams.get("kind") === "agent" ? "agent" : "browser";
    if (!PEER_ID.test(id)) return new Response("bad peer id", { status: 400 });

    for (const ws of this.ctx.getWebSockets(id)) ws.close(4000, "replaced");
    if (this.ctx.getWebSockets().length >= MAX_PEERS) return new Response("room full", { status: 429 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id, name, kind } satisfies Peer);
    this.broadcastPeers();
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const stale = new Set<WebSocket>();
    for (const ws of this.ctx.getWebSockets()) {
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (last && now - last.getTime() > STALE_MS) stale.add(ws);
    }
    for (const ws of stale) {
      try {
        ws.close(4001, "stale");
      } catch {}
    }
    if (stale.size) this.broadcastPeers(stale);
    if (this.ctx.getWebSockets().some((w) => !stale.has(w))) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): void {
    if (typeof msg !== "string" || msg.length > MAX_SIGNAL_BYTES) return;
    let m: { t?: string; to?: string; data?: unknown };
    try {
      m = JSON.parse(msg);
    } catch {
      return;
    }
    if (m.t !== "signal" || typeof m.to !== "string") return;
    const from = ws.deserializeAttachment() as Peer;
    const out = JSON.stringify({ t: "signal", from: from.id, data: m.data });
    for (const p of this.ctx.getWebSockets(m.to)) p.send(out);
  }

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {}
    this.broadcastPeers(new Set([ws]));
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  private broadcastPeers(gone?: Set<WebSocket>): void {
    const sockets = this.ctx.getWebSockets().filter((w) => !gone?.has(w) && w.readyState === WebSocket.OPEN);
    const peers = sockets.map((w) => w.deserializeAttachment() as Peer);
    for (const w of sockets) {
      const self = (w.deserializeAttachment() as Peer).id;
      try {
        w.send(JSON.stringify({ t: "peers", peers: peers.filter((p) => p.id !== self) }));
      } catch {}
    }
  }
}
