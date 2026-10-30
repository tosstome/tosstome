import { channel, closeWhenPeerDone, openRelay, receiveFiles, sendFiles, sha256Hex, TransferError } from "../shared/transfer.js";
import { directAvailable, fanout, fit, receiverPath, senderPath } from "./direct.js";
import { diskSink, fileEvent } from "./files.js";

function connect(server, inboxId, role) {
  const ws = new WebSocket(`${server.replace(/^http/, "ws")}/api/inbox/${inboxId}?role=${role}`);
  const ch = channel(ws);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ch), { once: true });
    ws.addEventListener("error", () => reject(new Error("inbox connect failed")), { once: true });
  });
}

async function expectAuth(ch) {
  const m = await ch.next();
  if (!m || m.t !== "auth") throw new Error("inbox closed during auth");
  if (!m.ok) throw new Error(`inbox rejected: ${m.reason}`);
}

// Keeps one authenticated agent connection open and receives every incoming session into `dir`.
// Reconnects with backoff; resolves only when `signal` aborts.
export async function listen(inbox, { dir, onEvent = () => {}, signal } = {}) {
  let delay = 1000;
  while (!signal?.aborted) {
    try {
      const ch = await connect(inbox.server, inbox.inboxId, "agent");
      signal?.addEventListener("abort", () => ch.close(), { once: true });
      const rtc = await directAvailable();
      ch.send({ t: "auth", key: inbox.agentKey, sendHash: await sha256Hex(inbox.sendKey), rtc });
      await expectAuth(ch);
      onEvent({ type: "ready" });
      delay = 1000;
      const signals = new Map(); // sid -> fn, for direct-connection signals from that session's sender
      for (;;) {
        const m = await ch.next();
        if (m === null) break;
        if (m.t === "signal") signals.get(m.sid)?.(m.data);
        else if (m.t === "incoming" && /^[0-9a-f]{32}$/.test(m.sid)) {
          const session = {
            rtc,
            send: (data) => ch.send({ t: "signal", sid: m.sid, data }),
            subscribe: (fn) => (signals.set(m.sid, fn), () => signals.delete(m.sid)),
          };
          receiveSession(inbox, m, session, dir, onEvent);
        }
      }
      onEvent({ type: "disconnected" });
    } catch (e) {
      onEvent({ type: "error", message: e.message });
      if (/inbox rejected/.test(e.message)) throw e;
    }
    if (signal?.aborted) break;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30000);
  }
}

async function receiveSession(inbox, { sid, from }, { rtc, send, subscribe }, dir, onEvent) {
  const sinks = [];
  try {
    const { ch, via } = await receiverPath({ direct: rtc, send, subscribe, relay: (signal) => openRelay(inbox.server, sid, "r", { signal }) });
    const files = await receiveFiles(ch, {
      onOffer: (list) => {
        onEvent({ type: "offer", from, files: list, via });
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
    for (const f of files) onEvent(await fileEvent(from, f));
  } catch (e) {
    for (const s of sinks) await s.abort();
    onEvent({ type: "error", message: `transfer from ${from} failed: ${e instanceof TransferError ? e.message : e}` });
  }
}

// Resolves to "direct" or "relay", the path the files took.
export async function sendToInbox(target, files, { name = "tosstome cli", onProgress } = {}) {
  const ch = await connect(target.server, target.inboxId, "sender");
  try {
    ch.send({ t: "auth", key: target.sendKey, name });
    await expectAuth(ch);
    const m = await ch.next();
    if (!m || m.t === "offline") throw new Error("inbox is offline (no listening agent)");
    if (m.t !== "relay") throw new Error(`unexpected inbox reply: ${JSON.stringify(m)}`);
    const on = fanout(ch);
    const path = await senderPath({
      direct: m.rtc === true,
      send: (data) => ch.send({ t: "signal", sid: m.sid, data }),
      subscribe: (fn) => on((s) => s.t === "signal" && s.sid === m.sid && fn(s.data)),
      relay: () => openRelay(target.server, m.sid, "s"),
    });
    ch.close();
    try {
      await sendFiles(path.ch, fit(files, path.chunk), { onProgress });
    } finally {
      path.ch.close();
    }
    return path.via;
  } finally {
    ch.close();
  }
}
