import { Room } from "./room";
import { Relay } from "./relay";
import { Inbox } from "./inbox";

export { Room, Relay, Inbox };

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  RELAY: DurableObjectNamespace<Relay>;
  INBOX: DurableObjectNamespace<Inbox>;
  ASSETS?: Fetcher;
  // Header carrying the client address. Cloudflare sets CF-Connecting-IP; self-hosted behind a reverse
  // proxy this is whatever header that proxy overwrites, such as X-Real-IP or X-Forwarded-For.
  CLIENT_IP_HEADER?: string;
}

// Relay sessions are spread over a small fixed pool of objects. Duration is billed per object
// (wall clock while any socket is active), so concurrent transfers sharing an object share the bill.
const RELAY_SHARDS = 8;

const SID = /^[0-9a-f]{32}$/;
const INBOX_ID = /^[A-Za-z0-9_-]{22}$/;
const ROOM_CODE = /^[0-9]{6}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api") return env.ASSETS ? env.ASSETS.fetch(req) : new Response("tosstome server\n", { status: parts.length ? 404 : 200 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });

    if (parts[1] === "relay" && SID.test(parts[2] ?? "")) {
      const shard = fnv1a(parts[2]) % RELAY_SHARDS;
      return env.RELAY.get(env.RELAY.idFromName(`relay-${shard}`)).fetch(req);
    }
    if (parts[1] === "room" && parts[2] === "ip") {
      const key = await networkKey(clientIp(req, env.CLIENT_IP_HEADER || "CF-Connecting-IP"));
      return env.ROOM.get(env.ROOM.idFromName(`ip:${key}`)).fetch(req);
    }
    if (parts[1] === "room" && parts[2] === "code" && ROOM_CODE.test(parts[3] ?? "")) {
      return env.ROOM.get(env.ROOM.idFromName(`code:${parts[3]}`)).fetch(req);
    }
    if (parts[1] === "inbox" && INBOX_ID.test(parts[2] ?? "")) {
      return env.INBOX.get(env.INBOX.idFromName(parts[2])).fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

// The last entry of a list header is the one added by the nearest proxy; earlier ones come from the client.
// Without the header every device lands in one group, which suits a server used on a single network.
function clientIp(req: Request, header: string): string {
  return req.headers.get(header)?.split(",").pop()?.trim() || "local";
}

// Devices behind the same public IPv4, or the same IPv6 /64, are treated as one network.
// The address is hashed so raw IPs never become object names.
async function networkKey(ip: string): Promise<string> {
  const net = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tosstome-net:${net}`));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
