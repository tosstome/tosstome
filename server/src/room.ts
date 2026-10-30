import { DurableObject } from "cloudflare:workers";

interface Peer {
  id: string;
  name: string;
  // "agent" peers are always-on CLI inboxes; browsers skip WebRTC for them and go straight to the relay.
  kind: "browser" | "agent";
}

const PEER_ID = /^[0-9a-f]{16,32}$/;
const MAX_PEERS = 50;
const MAX_SIGNAL_BYTES = 64 * 1024;

// Presence and WebRTC signaling for one room (a shared network, or a 6-digit code).
// File bytes never pass through here; peers either connect directly or get a relay session id.
export class Room extends DurableObject {
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
    return new Response(null, { status: 101, webSocket: client });
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
    this.broadcastPeers(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  private broadcastPeers(gone?: WebSocket): void {
    const sockets = this.ctx.getWebSockets().filter((w) => w !== gone);
    const peers = sockets.map((w) => w.deserializeAttachment() as Peer);
    for (const w of sockets) {
      const self = (w.deserializeAttachment() as Peer).id;
      try {
        w.send(JSON.stringify({ t: "peers", peers: peers.filter((p) => p.id !== self) }));
      } catch {}
    }
  }
}
