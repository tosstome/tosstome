// Chunked file transfer over any message channel: a browser or Node WebSocket, or an RTCDataChannel.
// Flow control is end to end (receiver acks), so it works the same through the relay and over WebRTC.
//
// Wire format, in order:
//   sender   -> {t:"hello", files:[{name,size,type,text?}]}
//   receiver -> {t:"accept"} | {t:"reject"}
//   sender   -> {t:"file", name, size, type, text?}, binary chunks..., {t:"end"}   (repeated per file)
//   sender   -> {t:"done"}
//   receiver -> {t:"ack", n} (every ACK_EVERY bytes and after each file), then {t:"fin"}
//
// A text message is a UTF-8 .txt entry with text:true, so it travels every path a file does. Receivers
// that predate the flag simply save it as a file; newer ones show it inline when it is at most MAX_TEXT.

export const CHUNK = 256 * 1024;
const WINDOW = 8 * 1024 * 1024;
const ACK_EVERY = 1024 * 1024;
export const MAX_TEXT = 1024 * 1024;

export class TransferError extends Error {}

// Wraps a WebSocket or RTCDataChannel into a pull-based message queue so no frame is lost
// between setup steps. JSON text frames become objects, binary frames become Uint8Array.
export function channel(raw) {
  raw.binaryType = "arraybuffer";
  const queue = [];
  const waiters = [];
  let closed = false;
  const push = (item) => (waiters.length ? waiters.shift()(item) : queue.push(item));
  raw.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      try {
        push(JSON.parse(e.data));
      } catch {
        push({ t: "error", reason: "bad json" });
      }
    } else {
      push(new Uint8Array(e.data));
    }
  });
  const end = () => {
    if (closed) return;
    closed = true;
    while (waiters.length) waiters.shift()(null);
  };
  raw.addEventListener("close", end);
  raw.addEventListener("error", end);
  return {
    raw,
    send(data) {
      raw.send(data instanceof Uint8Array || typeof data === "string" ? data : JSON.stringify(data));
    },
    // Resolves to the next message, or null once the channel is closed and drained.
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((r) => waiters.push(r));
    },
    close() {
      try {
        raw.close();
      } catch {}
    },
  };
}

async function control(ch) {
  const m = await ch.next();
  if (m === null) throw new TransferError("connection closed");
  if (m instanceof Uint8Array) throw new TransferError("unexpected binary frame");
  if (m._relay === "left") throw new TransferError("peer disconnected");
  if (m.t === "error") throw new TransferError(m.reason || "peer error");
  return m;
}

// files: [{name, size, type, chunks(): AsyncIterable<Uint8Array>}]
export async function sendFiles(ch, files, { onProgress } = {}) {
  const total = files.reduce((n, f) => n + f.size, 0);
  ch.send({ t: "hello", files: files.map(({ name, size, type, text }) => ({ name, size, type, ...(text && { text: true }) })) });
  const answer = await control(ch);
  if (answer.t !== "accept") throw new TransferError("receiver declined");

  let sent = 0;
  let acked = 0;
  const waitAcked = async (target) => {
    while (acked < target) {
      const m = await control(ch);
      if (m.t === "ack") acked = m.n;
    }
  };
  for (const f of files) {
    ch.send({ t: "file", name: f.name, size: f.size, type: f.type || "", ...(f.text && { text: true }) });
    for await (const chunk of f.chunks()) {
      await waitAcked(sent + chunk.byteLength - WINDOW);
      ch.send(chunk);
      sent += chunk.byteLength;
      onProgress?.({ sent, acked, total, file: f.name });
    }
    ch.send({ t: "end" });
  }
  ch.send({ t: "done" });
  await waitAcked(sent);
  for (;;) {
    const m = await control(ch);
    if (m.t === "fin") break;
  }
  onProgress?.({ sent, acked: sent, total, file: null });
}

// onOffer(files) -> boolean (may be async); onFile(meta) -> sink {write(Uint8Array), close()} (may be async)
export async function receiveFiles(ch, { onOffer, onFile, onProgress } = {}) {
  const hello = await control(ch);
  if (hello.t !== "hello" || !Array.isArray(hello.files)) throw new TransferError("expected hello");
  const total = hello.files.reduce((n, f) => n + (f.size | 0), 0);
  const ok = onOffer ? await onOffer(hello.files) : true;
  ch.send({ t: ok ? "accept" : "reject" });
  if (!ok) return [];

  const results = [];
  let received = 0;
  let lastAck = 0;
  let current = null;
  let sink = null;
  let got = 0;
  for (;;) {
    const m = await ch.next();
    if (m === null) throw new TransferError("connection closed");
    if (m instanceof Uint8Array) {
      if (!current) throw new TransferError("data before file header");
      got += m.byteLength;
      if (got > current.size) throw new TransferError(`more data than announced for ${current.name}`);
      await sink.write(m);
      received += m.byteLength;
      if (received - lastAck >= ACK_EVERY) {
        ch.send({ t: "ack", n: received });
        lastAck = received;
      }
      onProgress?.({ received, total, file: current.name });
      continue;
    }
    if (m._relay === "left") throw new TransferError("peer disconnected");
    if (m.t === "file") {
      current = { name: String(m.name), size: Number(m.size), type: String(m.type || "") };
      if (m.text === true && current.size <= MAX_TEXT) current.text = true;
      got = 0;
      sink = await onFile(current);
    } else if (m.t === "end") {
      if (!current || got !== current.size) throw new TransferError(`size mismatch for ${current?.name}`);
      results.push({ ...current, result: await sink.close() });
      ch.send({ t: "ack", n: received });
      lastAck = received;
      current = null;
    } else if (m.t === "done") {
      ch.send({ t: "ack", n: received });
      ch.send({ t: "fin" });
      return results;
    } else if (m.t === "error") {
      throw new TransferError(m.reason || "peer error");
    }
  }
}

// For the receiver after receiveFiles: leaves closing to the sender, which closes once it has read "fin",
// and closes anyway after ms. A data channel closed right after a send can lose that last message.
export async function closeWhenPeerDone(ch, ms = 10000) {
  const timer = setTimeout(() => ch.close(), ms);
  while ((await ch.next()) !== null);
  clearTimeout(timer);
  ch.close();
}

// Opens one side of a relay session and resolves once the other side is connected.
// Aborting `signal` (another path won) closes the socket.
export async function openRelay(base, sid, role, { signal, WebSocketImpl = globalThis.WebSocket } = {}) {
  const ws = new WebSocketImpl(`${base.replace(/^http/, "ws")}/api/relay/${sid}?role=${role}`);
  const ch = channel(ws);
  signal?.addEventListener("abort", () => ch.close(), { once: true });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new TransferError("relay connect failed")), { once: true });
    ws.addEventListener("close", () => reject(new TransferError("relay closed")), { once: true });
  });
  const first = await ch.next();
  if (first === null) throw new TransferError("relay closed");
  if (first._relay !== "peer") throw new TransferError("unexpected relay frame");
  return ch;
}

export function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// chunkSize must not exceed the channel's message limit (RTCDataChannel peers may cap it at 64 KB).
export function browserFile(file, chunkSize = CHUNK) {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    async *chunks() {
      for (let off = 0; off < file.size; off += chunkSize) {
        yield new Uint8Array(await file.slice(off, off + chunkSize).arrayBuffer());
      }
    },
  };
}

// A text message as a transfer entry. The name is what receivers save it as; chunkSize as in browserFile.
export function textFile(text, { name = `message-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}.txt`, chunkSize = CHUNK } = {}) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_TEXT) throw new TransferError(`a message can be at most ${MAX_TEXT / 1024} KB`);
  return {
    name,
    size: bytes.byteLength,
    type: "text/plain;charset=utf-8",
    text: true,
    async *chunks() {
      for (let off = 0; off < bytes.byteLength; off += chunkSize) yield bytes.subarray(off, off + chunkSize);
    },
  };
}
