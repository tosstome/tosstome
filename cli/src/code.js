import { hostname } from "node:os";
import { channel, openRelay, randomHex, sendFiles } from "../shared/transfer.js";
import { fit, senderPath } from "./direct.js";

// Sends files to a browser that is waiting in a 6-digit code room (the person pressed "Create a code").
// Uses the same room signals as the web app: ask {xfer, files, from} -> accept|decline {xfer}, then a direct
// WebRTC connection (offer/answer/ice {xfer, ...}) or, if that fails, relay {xfer, sid}. The browser waits on
// both after accepting. Joins as an "agent" peer, so browsers do not offer to send files to it.
export async function sendToCode(server, code, files, { name = `${hostname()} (tosstome)`, peerTimeoutMs = 60000, answerTimeoutMs = 120000, onProgress, signal } = {}) {
  if (!/^[0-9]{6}$/.test(code)) throw new Error("a code is 6 digits");
  const ws = new WebSocket(`${server.replace(/^http/, "ws")}/api/room/code/${code}?id=${randomHex(8)}&kind=agent&name=${encodeURIComponent(name)}`);
  const ch = channel(ws);
  let path = null;
  const abort = () => {
    ch.close();
    path?.ch.close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("code room connect failed")), { once: true });
    });

    // Reads room messages in the background, declining anyone who tries to send to us; null means closed.
    const subs = new Set();
    const on = (fn) => (subs.add(fn), () => subs.delete(fn));
    (async () => {
      for (;;) {
        const m = await ch.next();
        if (m?.t === "signal" && m.data?.kind === "ask") ch.send({ t: "signal", to: m.from, data: { kind: "decline", xfer: m.data.xfer } });
        else for (const fn of subs) fn(m);
        if (m === null) return;
      }
    })();
    const until = (ms, what, match) =>
      new Promise((resolve, reject) => {
        const done = (err, value) => {
          clearTimeout(timer);
          off();
          if (err) reject(err);
          else resolve(value);
        };
        const timer = setTimeout(() => done(new Error(what)), ms);
        const off = on((m) => {
          if (m === null) return done(new Error(signal?.aborted ? "cancelled" : "code room closed"));
          const hit = match(m);
          if (hit) done(null, hit);
        });
      });

    const peer = await until(peerTimeoutMs, `no browser is waiting on code ${code}`, (m) => m.t === "peers" && m.peers.find((p) => p.kind !== "agent"));
    const xfer = randomHex(8);
    const send = (data) => ch.send({ t: "signal", to: peer.id, data: { ...data, xfer } });
    send({ kind: "ask", files: files.map((f) => ({ name: f.name, size: f.size, ...(f.text && { text: true }) })), from: name });
    const answer = await until(answerTimeoutMs, `${peer.name} did not accept in time`, (m) =>
      m.t === "signal" && m.from === peer.id && m.data?.xfer === xfer && (m.data.kind === "accept" || m.data.kind === "decline") ? m.data : null,
    );
    if (answer.kind === "decline") throw new Error(`${peer.name} declined`);

    path = await senderPath({
      direct: true,
      send,
      subscribe: (fn) => on((m) => m?.t === "signal" && m.from === peer.id && m.data?.xfer === xfer && fn(m.data)),
      relay: () => {
        const sid = randomHex(16);
        send({ kind: "relay", sid });
        return openRelay(server, sid, "s");
      },
    });
    if (signal?.aborted) throw new Error("cancelled");
    await sendFiles(path.ch, fit(files, path.chunk), { onProgress });
    return { to: peer.name, via: path.via };
  } finally {
    signal?.removeEventListener("abort", abort);
    path?.ch.close();
    ch.close();
  }
}
