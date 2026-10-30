import { hostname } from "node:os";
import { join } from "node:path";
import { channel, closeWhenPeerDone, openRelay, randomHex, receiveFiles } from "../shared/transfer.js";
import { directAvailable, receiverPath } from "./direct.js";
import { diskSink, fileEvent } from "./files.js";

// Appears as a device in the "same network" room so browsers on this network can send without the link.
// Anyone behind the same public IP can see and send to it, so it is opt-in and files land in a
// separate "nearby" folder rather than next to files that came through the authenticated inbox.
//
// Room signals (data field of {t:"signal"}), shared with the web app:
//   ask {xfer, files, from} -> accept {xfer, rtc} -> offer/answer/ice {xfer, ...} (direct) or relay {xfer, sid}
// rtc: true tells the browser this agent takes direct connections; without it browsers go to the relay.
export async function joinNearby(server, { dir, name = `${hostname()} (tosstome)`, onEvent = () => {}, signal } = {}) {
  const id = randomHex(8);
  const nearbyDir = join(dir, "nearby");
  const asks = new Map(); // xfer -> {peer, fns}: signals for a transfer, from the device that asked
  let delay = 1000;
  while (!signal?.aborted) {
    try {
      const url = `${server.replace(/^http/, "ws")}/api/room/ip?id=${id}&kind=agent&name=${encodeURIComponent(name)}`;
      const ws = new WebSocket(url);
      const ch = channel(ws);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", () => rej(new Error("nearby room connect failed")), { once: true });
      });
      signal?.addEventListener("abort", () => ch.close(), { once: true });
      onEvent({ type: "nearby-ready", name });
      delay = 1000;
      for (;;) {
        const m = await ch.next();
        if (m === null) break;
        if (m.t !== "signal" || !m.data) continue;
        const d = m.data;
        if (typeof d.xfer !== "string") continue;
        if (d.kind === "ask" && !asks.has(d.xfer)) {
          const fns = new Set();
          asks.set(d.xfer, { peer: m.from, fns });
          const session = {
            send: (data) => ch.send({ t: "signal", to: m.from, data: { ...data, xfer: d.xfer } }),
            subscribe: (fn) => (fns.add(fn), () => fns.delete(fn)),
          };
          const from = String(d.from || "A nearby device").slice(0, 40);
          receiveNearby(server, session, from, nearbyDir, onEvent).finally(() => asks.delete(d.xfer));
        } else if (asks.get(d.xfer)?.peer === m.from) {
          for (const fn of asks.get(d.xfer).fns) fn(d);
        }
      }
    } catch (e) {
      onEvent({ type: "error", message: e.message });
    }
    if (signal?.aborted) break;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30000);
  }
}

async function receiveNearby(server, { send, subscribe }, from, dir, onEvent) {
  const sinks = [];
  try {
    const rtc = await directAvailable();
    // The relay session id arrives as a signal, only if the sender gives up on (or skips) the direct path.
    const relay = (signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => done(new Error("no relay session")), 120000);
        const done = (err, sid) => {
          clearTimeout(timer);
          off();
          if (err) reject(err);
          else resolve(openRelay(server, sid, "r", { signal }));
        };
        const off = subscribe((d) => d.kind === "relay" && /^[0-9a-f]{32}$/.test(d.sid) && done(null, d.sid));
        signal.addEventListener("abort", () => done(new Error("aborted")), { once: true });
      });
    const path = receiverPath({ direct: rtc, send, subscribe, relay });
    send({ kind: "accept", ...(rtc && { rtc: true }) });
    const { ch, via } = await path;
    const files = await receiveFiles(ch, {
      onOffer: (list) => {
        onEvent({ type: "offer", from: `${from} (nearby)`, files: list, via });
        return true;
      },
      onFile: async (meta) => {
        const s = await diskSink(dir, meta);
        sinks.push(s);
        return s;
      },
      onProgress: (p) => onEvent({ type: "progress", ...p }),
    });
    closeWhenPeerDone(ch);
    for (const f of files) onEvent(await fileEvent(`${from} (nearby)`, f));
  } catch (e) {
    for (const s of sinks) await s.abort();
    onEvent({ type: "error", message: `nearby transfer from ${from} failed: ${e.message}` });
  }
}
