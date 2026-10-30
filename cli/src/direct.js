import { channel, CHUNK } from "../shared/transfer.js";
import { openDataChannel } from "../shared/rtc.js";

// WebRTC in Node comes from node-datachannel's W3C polyfill, an optional native dependency. Without it, or
// with TOSSTOME_DIRECT=0, every transfer takes the relay.
let loading;
export async function directAvailable() {
  if (process.env.TOSSTOME_DIRECT === "0") return false;
  loading ??= import("node-datachannel/polyfill").then(
    ({ RTCPeerConnection }) => {
      globalThis.RTCPeerConnection ??= RTCPeerConnection;
      return true;
    },
    () => false,
  );
  return loading;
}

// A channel over the data channel that also closes its peer connection, which holds native resources.
function direct({ dc, pc, maxMessageSize }) {
  const ch = channel(dc);
  return {
    ch: {
      ...ch,
      close() {
        ch.close();
        pc.close();
      },
    },
    via: "direct",
    chunk: Math.min(CHUNK, maxMessageSize),
  };
}

// Sender: tries a direct connection first when the receiver can take one, otherwise (or after the
// 8 second timeout) calls relay(), which tells the receiver and opens the sender's end.
export async function senderPath({ direct: tryDirect, send, subscribe, relay }) {
  if (tryDirect && (await directAvailable())) {
    try {
      return direct(await openDataChannel({ initiator: true, send, subscribe }));
    } catch {}
  }
  return { ch: await relay(), via: "relay", chunk: CHUNK };
}

// Receiver: waits on both paths at once and uses whichever connects, because only the sender decides.
// relay(signal) opens the receiver's end and must give up when signal aborts. Subscriptions are made
// before this returns, so the caller can accept right after without missing the sender's first signal.
export function receiverPath({ direct: tryDirect, send, subscribe, relay, timeoutMs = 15000 }) {
  const stopRelay = new AbortController();
  const stopDirect = new AbortController();
  let won = false;
  const take = (path, close, loser) => {
    if (won) {
      close();
      throw new Error("lost the race");
    }
    won = true;
    loser.abort();
    return path;
  };
  const attempts = [
    relay(stopRelay.signal).then((ch) => take({ ch, via: "relay", chunk: CHUNK }, () => ch.close(), stopDirect)),
  ];
  if (tryDirect) {
    attempts.push(
      openDataChannel({ initiator: false, send, subscribe, timeoutMs, signal: stopDirect.signal }).then((r) => {
        const path = direct(r);
        return take(path, () => path.ch.close(), stopRelay);
      }),
    );
  }
  return Promise.any(attempts).catch((e) => {
    throw e.errors[0];
  });
}

// Splits chunks to fit a data channel's message limit (some browsers cap it at 64 KB).
export function fit(files, size) {
  if (size >= CHUNK) return files;
  return files.map((f) => ({
    ...f,
    async *chunks() {
      for await (const c of f.chunks()) for (let o = 0; o < c.byteLength; o += size) yield c.subarray(o, o + size);
    },
  }));
}

// Reads `ch` in the background and hands each message to the current subscribers; returns subscribe(fn).
export function fanout(ch) {
  const subs = new Set();
  (async () => {
    for (;;) {
      const m = await ch.next();
      if (m === null) return;
      for (const fn of subs) fn(m);
    }
  })();
  return (fn) => (subs.add(fn), () => subs.delete(fn));
}
