// Direct-path check for shared/rtc.js, run in Node with node-datachannel's W3C polyfill.
// Two peers exchange signals through a real Room object and transfer a file over the data channel.
// (The fingerprint browser used by browser_e2e.py cannot resolve mDNS host candidates on this machine,
// so the direct path is verified here instead.)
// Usage: node tests/rtc_node.mjs [http://127.0.0.1:8787]
import { createHash, randomBytes } from "node:crypto";
import * as polyfill from "node-datachannel/polyfill";
import { channel, randomHex, receiveFiles, sendFiles } from "../shared/transfer.js";

globalThis.RTCPeerConnection = polyfill.RTCPeerConnection;
const { openDataChannel } = await import("../shared/rtc.js");

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
const code = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
const sha = (b) => createHash("sha256").update(b).digest("hex");

async function peer(name) {
  const id = randomHex(8);
  const ws = new WebSocket(`${WS}/api/room/code/${code}?id=${id}&name=${name}`);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const ch = channel(ws);
  const subs = new Set();
  let peersSeen;
  const peers = new Promise((r) => (peersSeen = r));
  (async () => {
    for (;;) {
      const m = await ch.next();
      if (m === null) return;
      if (m.t === "peers" && m.peers.length) peersSeen(m.peers[0].id);
      if (m.t === "signal") for (const fn of subs) fn(m.data);
    }
  })();
  return {
    id,
    peers,
    send: (to) => (data) => ch.send({ t: "signal", to, data }),
    subscribe: (fn) => (subs.add(fn), () => subs.delete(fn)),
    close: () => ch.close(),
  };
}

const a = await peer("A");
const b = await peer("B");
const bId = await a.peers;
const aId = await b.peers;

const t0 = Date.now();
const [ra, rb] = await Promise.all([
  openDataChannel({ initiator: true, send: a.send(bId), subscribe: a.subscribe }),
  openDataChannel({ initiator: false, send: b.send(aId), subscribe: b.subscribe }),
]);
const connectMs = Date.now() - t0;
const pair = ra.pc.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.();

const payload = randomBytes(20 * 1024 * 1024 + 11);
const chunk = Math.min(256 * 1024, ra.maxMessageSize);
const got = [];
const t1 = Date.now();
await Promise.all([
  receiveFiles(channel(rb.dc), { onFile: () => ({ write: (c) => got.push(Buffer.from(c)), close: () => Buffer.concat(got) }) }),
  sendFiles(channel(ra.dc), [
    {
      name: "direct.bin",
      size: payload.length,
      type: "",
      async *chunks() {
        for (let o = 0; o < payload.length; o += chunk) yield payload.subarray(o, o + chunk);
      },
    },
  ]),
]);
const secs = (Date.now() - t1) / 1000;
const ok = sha(Buffer.concat(got)) === sha(payload);
console.log(`${ok ? "PASS" : "FAIL"} direct data channel transfer intact  (connect ${connectMs} ms, ${(20 / secs).toFixed(1)} MB/s, chunk ${chunk} B${pair ? `, ${pair.local?.type}->${pair.remote?.type}` : ""})`);
ra.pc.close();
rb.pc.close();
a.close();
b.close();
process.exit(ok ? 0 : 1);
