// End-to-end checks against a running server (default: local `wrangler dev`).
// Usage: node tests/integration.mjs [http://127.0.0.1:8787]
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channel, MAX_TEXT, openRelay, randomHex, receiveFiles, sendFiles, textFile } from "../shared/transfer.js";
import { loadOrCreateInbox, inboxLink, parseInboxLink } from "../cli/src/config.js";
import { listen, sendToInbox } from "../cli/src/inbox.js";
import { nodeFile } from "../cli/src/files.js";
import { joinNearby } from "../cli/src/nearby.js";
import { directAvailable } from "../cli/src/direct.js";
import { openDataChannel } from "../shared/rtc.js";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const sha = (b) => createHash("sha256").update(b).digest("hex");
const memFile = (name, buf) => ({
  name,
  size: buf.byteLength,
  type: "application/octet-stream",
  async *chunks() {
    for (let o = 0; o < buf.byteLength; o += 256 * 1024) yield buf.subarray(o, o + 256 * 1024);
  },
});
const memSink = (store) => async (meta) => {
  const parts = [];
  return { write: async (c) => parts.push(Buffer.from(c)), close: async () => (store[meta.name] = Buffer.concat(parts)) };
};
const wsOpen = (url) =>
  new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => res(ws), { once: true });
    ws.addEventListener("error", () => rej(new Error(`connect failed: ${url}`)), { once: true });
  });
const closedWith = (ws) => new Promise((r) => ws.addEventListener("close", (e) => r(e.code), { once: true }));

// 1. relay: two files, one empty, integrity by sha256
{
  const sid = randomHex(16);
  const a = randomBytes(30 * 1024 * 1024 + 123), b = Buffer.alloc(0);
  const got = {};
  const [rx, tx] = await Promise.all([openRelay(BASE, sid, "r"), openRelay(BASE, sid, "s")]);
  const t0 = Date.now();
  await Promise.all([
    receiveFiles(rx, { onFile: memSink(got) }),
    sendFiles(tx, [memFile("a.bin", a), memFile("empty.txt", b)]),
  ]);
  const secs = (Date.now() - t0) / 1000;
  check("relay transfers 30 MB intact", got["a.bin"] && sha(got["a.bin"]) === sha(a), `${(30 / secs).toFixed(1)} MB/s`);
  check("relay transfers empty file", got["empty.txt"]?.byteLength === 0);
  rx.close(); tx.close();
}

// 2. relay: a third socket for a taken role is refused
{
  const sid = randomHex(16);
  const first = await wsOpen(`${WS}/api/relay/${sid}?role=r`);
  let refused = false;
  try {
    const dup = await wsOpen(`${WS}/api/relay/${sid}?role=r`);
    refused = (await closedWith(dup)) !== 1000;
  } catch {
    refused = true;
  }
  check("relay refuses a second receiver", refused);
  first.close();
}

// 3. relay: receiver declining stops the sender
{
  const sid = randomHex(16);
  const [rx, tx] = await Promise.all([openRelay(BASE, sid, "r"), openRelay(BASE, sid, "s")]);
  const [, sendResult] = await Promise.allSettled([
    receiveFiles(rx, { onOffer: () => false }),
    sendFiles(tx, [memFile("x", randomBytes(10))]),
  ]);
  check("declined offer rejects the send", sendResult.status === "rejected" && /declined/.test(sendResult.reason?.message));
  rx.close(); tx.close();
}

// 4. inbox: agent listens, CLI sender delivers to disk; wrong key is refused; offline is reported
{
  process.env.TOSSTOME_HOME = await mkdtemp(join(tmpdir(), "tosstome-home-"));
  const dir = await mkdtemp(join(tmpdir(), "tosstome-inbox-"));
  const inbox = await loadOrCreateInbox({ server: BASE });
  const target = parseInboxLink(inboxLink(inbox));

  try {
    await sendToInbox(target, [memFile("early.txt", Buffer.from("x"))]);
    check("sending before any agent registered is refused", false);
  } catch (e) {
    check("sending before any agent registered is refused", /rejected/.test(e.message), e.message);
  }

  const ac = new AbortController();
  const events = [];
  let ready;
  const readyP = new Promise((r) => (ready = r));
  listen(inbox, { dir, signal: ac.signal, onEvent: (e) => { events.push(e); if (e.type === "ready") ready(); } }).catch(() => {});
  await readyP;

  const payload = randomBytes(5 * 1024 * 1024);
  const src = join(dir, "..", `src-${randomHex(4)}.bin`);
  await writeFile(src, payload);
  const via = await sendToInbox(target, [await nodeFile(src), memFile("../../etc/evil.txt", Buffer.from("nope"))]);
  await new Promise((r) => setTimeout(r, 500));
  check("inbox transfer goes direct when both sides have WebRTC", via === "direct" && events.find((e) => e.type === "offer")?.via === "direct", via);
  const saved = await readdir(dir);
  const savedBin = saved.find((n) => n.startsWith("src-"));
  check("inbox saves the file to disk intact", savedBin && sha(await readFile(join(dir, savedBin))) === sha(payload));
  check("inbox strips path traversal from names", saved.includes("evil.txt") && !saved.some((n) => n.includes("/")), saved.join(","));

  const note = "héllo\n\x1b[31mnot red\x1b[0m https://example.com";
  const big = { ...memFile("big.txt", Buffer.alloc(MAX_TEXT + 1, 97)), text: true };
  const before = events.length;
  // A sender without WebRTC (like an older page) goes straight to the relay; the agent takes it from there.
  process.env.TOSSTOME_DIRECT = "0";
  const t0 = Date.now();
  const viaRelay = await sendToInbox(target, [textFile(note), big]);
  delete process.env.TOSSTOME_DIRECT;
  await new Promise((r) => setTimeout(r, 500));
  check("a sender without WebRTC uses the relay without waiting", viaRelay === "relay" && Date.now() - t0 < 5000, `${viaRelay}, ${Date.now() - t0} ms`);
  const got = events.slice(before).filter((e) => e.type === "file");
  check("inbox delivers a text message with its content", got[0]?.message === note && got[0].name.endsWith(".txt"), got[0]?.name);
  check("an oversized text entry is treated as a plain file", got[1] && got[1].message === undefined && got[1].size === MAX_TEXT + 1);
  try {
    textFile("x".repeat(MAX_TEXT + 1));
    check("textFile refuses oversized messages", false);
  } catch {
    check("textFile refuses oversized messages", true);
  }

  try {
    await sendToInbox({ ...target, sendKey: "wrong-key-wrong-key" }, [memFile("x", Buffer.from("x"))]);
    check("wrong send key is refused", false);
  } catch (e) {
    check("wrong send key is refused", /rejected/.test(e.message), e.message);
  }

  const impostor = await wsOpen(`${WS}/api/inbox/${inbox.inboxId}?role=agent`);
  const ich = channel(impostor);
  ich.send({ t: "auth", key: "not-the-agent-key", sendHash: "0".repeat(64) });
  const reply = await ich.next();
  check("impostor agent is refused", reply?.t === "auth" && reply.ok === false, reply?.reason);

  ac.abort();
  await new Promise((r) => setTimeout(r, 500));

  // An agent without WebRTC (like an older CLI) is never offered a direct connection.
  process.env.TOSSTOME_DIRECT = "0";
  const ac2 = new AbortController();
  let ready2;
  const ready2P = new Promise((r) => (ready2 = r));
  listen(inbox, { dir, signal: ac2.signal, onEvent: (e) => e.type === "ready" && ready2() }).catch(() => {});
  await ready2P;
  delete process.env.TOSSTOME_DIRECT;
  const t1 = Date.now();
  const viaOld = await sendToInbox(target, [memFile("old-agent.txt", Buffer.from("x"))]);
  check("an agent without WebRTC gets the relay without waiting", viaOld === "relay" && Date.now() - t1 < 5000, `${viaOld}, ${Date.now() - t1} ms`);
  ac2.abort();
  await new Promise((r) => setTimeout(r, 500));

  try {
    await sendToInbox(target, [memFile("late.txt", Buffer.from("x"))]);
    check("offline inbox is reported", false);
  } catch (e) {
    check("offline inbox is reported", /offline/.test(e.message), e.message);
  }
}

// 5. room: two peers on the same network see each other and can signal
{
  const idA = randomHex(8), idB = randomHex(8);
  const a = channel(await wsOpen(`${WS}/api/room/ip?id=${idA}&name=Alpha`));
  const b = channel(await wsOpen(`${WS}/api/room/ip?id=${idB}&name=Beta`));
  let seen = null;
  for (let i = 0; i < 5 && !seen; i++) {
    const m = await a.next();
    if (m?.t === "peers" && m.peers.some((p) => p.id === idB)) seen = m;
  }
  check("room lists the other peer", !!seen);
  a.send({ t: "signal", to: idB, data: { kind: "ping" } });
  let sig = null;
  for (let i = 0; i < 5 && !sig; i++) {
    const m = await b.next();
    if (m?.t === "signal") sig = m;
  }
  check("room forwards a signal to the named peer", sig?.from === idA && sig.data?.kind === "ping");
  a.close(); b.close();
}

// 6. nearby: an agent in the same-network room accepts an ask and receives into DIR/nearby
{
  const dir = await mkdtemp(join(tmpdir(), "tosstome-nearby-"));
  const ac = new AbortController();
  let ready;
  const readyP = new Promise((r) => (ready = r));
  joinNearby(BASE, { dir, name: "Test Agent", signal: ac.signal, onEvent: (e) => e.type === "nearby-ready" && ready() }).catch(() => {});
  await readyP;
  const me = randomHex(8);
  const room = channel(await wsOpen(`${WS}/api/room/ip?id=${me}&name=Phone`));
  let agent = null;
  for (let i = 0; i < 5 && !agent; i++) {
    const m = await room.next();
    if (m?.t === "peers") agent = m.peers.find((p) => p.kind === "agent" && p.name === "Test Agent");
  }
  check("agent is visible to browsers on the same network", !!agent);
  const xfer = randomHex(8);
  room.send({ t: "signal", to: agent.id, data: { kind: "ask", xfer, files: [{ name: "photo.jpg", size: 3 }], from: "Phone" } });
  let accepted = null;
  for (let i = 0; i < 5 && !accepted; i++) {
    const m = await room.next();
    if (m?.t === "signal" && m.data?.xfer === xfer && m.data.kind === "accept") accepted = m.data;
  }
  check("agent accepts a nearby ask and says it takes direct connections", accepted?.rtc === true);
  const sid = randomHex(16);
  room.send({ t: "signal", to: agent.id, data: { kind: "relay", xfer, sid } });
  const tx = await openRelay(BASE, sid, "s");
  await sendFiles(tx, [memFile("photo.jpg", Buffer.from("abc"))]);
  tx.close();
  await new Promise((r) => setTimeout(r, 300));
  const saved = await readdir(join(dir, "nearby")).catch(() => []);
  check("nearby files land in DIR/nearby", saved.includes("photo.jpg"), saved.join(","));

  // The same, the way a current browser does it: a direct connection after the agent's rtc accept.
  await directAvailable();
  const xfer2 = randomHex(8);
  const subs = new Set();
  const reader = (async () => {
    for (let m; (m = await room.next()) !== null; ) if (m.t === "signal" && m.data?.xfer === xfer2) for (const fn of subs) fn(m.data);
  })();
  const accept2 = new Promise((r) => subs.add((d) => d.kind === "accept" && r(d)));
  const payload = randomBytes(2 * 1024 * 1024);
  room.send({ t: "signal", to: agent.id, data: { kind: "ask", xfer: xfer2, files: [{ name: "video.mov", size: payload.length }], from: "Phone" } });
  await accept2;
  const { dc, pc } = await openDataChannel({
    initiator: true,
    send: (data) => room.send({ t: "signal", to: agent.id, data: { ...data, xfer: xfer2 } }),
    subscribe: (fn) => (subs.add(fn), () => subs.delete(fn)),
  });
  await sendFiles(channel(dc), [memFile("video.mov", payload)]);
  dc.close();
  pc.close();
  await new Promise((r) => setTimeout(r, 300));
  const direct = await readFile(join(dir, "nearby", "video.mov")).catch(() => null);
  check("nearby transfer over a direct connection", direct && sha(direct) === sha(payload));
  ac.abort();
  room.close();
  await reader;
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
