import { DurableObject } from "cloudflare:workers";

type Role = "s" | "r";

// Blind byte relay between exactly two sockets of one session: a sender ("s") and a receiver ("r").
// Payloads are forwarded unchanged; the relay only emits its own control frames tagged `_relay`.
export class Relay extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const sid = url.pathname.split("/")[3];
    const role = url.searchParams.get("role");
    if (role !== "s" && role !== "r") return new Response("bad role", { status: 400 });
    if (this.ctx.getWebSockets(`${sid}:${role}`).length > 0) return new Response("role taken", { status: 409 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [sid, `${sid}:${role}`]);

    const peers = this.ctx.getWebSockets(`${sid}:${other(role)}`);
    if (peers.length > 0) {
      const ready = JSON.stringify({ _relay: "peer" });
      server.send(ready);
      for (const p of peers) p.send(ready);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): void {
    const { sid, role } = this.identify(ws);
    for (const p of this.ctx.getWebSockets(`${sid}:${other(role)}`)) p.send(msg);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.drop(ws, code, reason);
  }

  webSocketError(ws: WebSocket): void {
    this.drop(ws, 1011, "error");
  }

  private drop(ws: WebSocket, code: number, reason: string): void {
    const { sid, role } = this.identify(ws);
    for (const p of this.ctx.getWebSockets(`${sid}:${other(role)}`)) {
      try {
        p.send(JSON.stringify({ _relay: "left" }));
        p.close(1000, "peer left");
      } catch {}
    }
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {}
  }

  private identify(ws: WebSocket): { sid: string; role: Role } {
    const tag = this.ctx.getTags(ws).find((t) => t.includes(":"))!;
    const [sid, role] = tag.split(":");
    return { sid, role: role as Role };
  }
}

function other(role: Role): Role {
  return role === "s" ? "r" : "s";
}
