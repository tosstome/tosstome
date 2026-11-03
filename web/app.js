import { browserFile, channel, CHUNK, closeWhenPeerDone, openRelay, randomHex, receiveFiles, sendFiles, textFile } from "./shared/transfer.js";
import { openDataChannel } from "./shared/rtc.js";
import { deviceName } from "./shared/names.js";
import { $, copyText, el, linkify, plural, qrSvg, size, splitName } from "./ui.js";

// Room signal protocol (the `data` of {t:"signal"}), shared with the CLI's nearby and code modes:
//   ask {xfer, files, from} -> accept|decline {xfer}
//   then either offer/answer/ice {xfer, ...} (direct) or relay {xfer, sid} (fallback)
// A CLI agent's accept carries rtc: true when it takes direct connections; older agents only use the relay.

const me = { id: tabId(), name: deviceName() };
const rooms = new Map(); // key ("ip" or "code:123456") -> {ch, peers, left}
const listeners = new Map(); // xfer -> Set(fn)
const rows = new Map(); // peer id -> its row in a device list
const sending = new Map(); // peer id -> progress 0..1 while a send to it runs
let code = null; // {value, created} once a code is in use

$("#me").textContent = me.name;
const isAgent = (peer) => peer.kind === "agent";
const shortName = (full) => splitName(String(full || "someone").slice(0, 40)).name;

function onXfer(xfer, fn) {
  if (!listeners.has(xfer)) listeners.set(xfer, new Set());
  listeners.get(xfer).add(fn);
  return () => {
    const set = listeners.get(xfer);
    set?.delete(fn);
    if (set?.size === 0) listeners.delete(xfer);
  };
}

function waitFor(xfer, match, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("no answer"));
    }, ms);
    const off = onXfer(xfer, (d) => {
      if (!match(d)) return;
      clearTimeout(timer);
      off();
      resolve(d);
    });
  });
}

// Messages up to this many JSON characters travel inside the ask signal (the room caps a signal at 64 KB).
const INLINE_MAX = 32000;

// Room heartbeat, answered by the server without waking the room (see server/src/room.ts).
const PING = '{"t":"ping"}';
const HEARTBEAT_MS = 15000;
const DEAD_MS = 40000; // nothing heard for this long: the socket is gone even if the browser has not noticed

// One id per tab, kept across reloads so a reloaded page replaces its old entry instead of adding a twin.
function tabId() {
  try {
    const saved = sessionStorage.getItem("tosstome:id");
    if (saved && /^[0-9a-f]{16}$/.test(saved)) return saved;
    const id = randomHex(8);
    sessionStorage.setItem("tosstome:id", id);
    return id;
  } catch {
    return randomHex(8);
  }
}

function joinRoom(key, path) {
  if (rooms.has(key)) return;
  const room = { ch: null, peers: [], lastSeen: 0, retry: null, paused: false };
  rooms.set(key, room);
  room.connect = () => {
    clearTimeout(room.retry);
    room.ch?.close();
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/room/${path}?id=${me.id}&name=${encodeURIComponent(me.name)}`);
    const ch = channel(ws);
    let code = 0;
    room.ch = ch;
    room.lastSeen = Date.now();
    ws.addEventListener("open", () => ch.send(PING), { once: true });
    ws.addEventListener("close", (e) => (code = e.code), { once: true });
    (async () => {
      for (;;) {
        const m = await ch.next();
        if (m === null || room.ch !== ch) break;
        room.lastSeen = Date.now();
        if (m.t === "peers") {
          room.peers = m.peers;
          render();
        } else if (m.t === "signal" && m.data && typeof m.data.xfer === "string") {
          if (m.data.kind === "ask") incoming(key, m.from, m.data);
          else for (const fn of listeners.get(m.data.xfer) ?? []) fn(m.data);
        }
      }
      if (room.ch !== ch) return; // replaced by a newer socket, or paused
      room.ch = null;
      room.peers = [];
      render();
      // 4000: a tab with the same id took the slot (a duplicated tab copies sessionStorage), so take a new one.
      if (code === 4000) me.id = randomHex(8);
      room.retry = setTimeout(room.connect, code === 4000 ? 0 : 2000);
    })();
  };
  // Pings the server; reconnects if the socket is closed or has gone quiet.
  room.check = () => {
    if (room.paused) return;
    const ch = room.ch;
    if (!ch || ch.raw.readyState !== WebSocket.OPEN || Date.now() - room.lastSeen > DEAD_MS) return room.connect();
    ch.send(PING);
  };
  room.connect();
}

setInterval(() => {
  for (const room of rooms.values()) room.check();
}, HEARTBEAT_MS);

// Phones freeze a page soon after it goes to the background, and its socket can then die without a close
// event, leaving a device in everyone's list that never answers. So a phone leaves the rooms when hidden
// (unless a transfer is being set up) and rejoins with a fresh socket when it comes back. Desktop tabs stay.
const leavesWhenHidden = matchMedia("(pointer: coarse)").matches;
const busy = () => sending.size > 0 || [...listeners.values()].some((set) => set.size > 0);
function pause() {
  if (!leavesWhenHidden || busy()) return;
  for (const room of rooms.values()) {
    room.paused = true;
    clearTimeout(room.retry);
    const ch = room.ch;
    room.ch = null;
    room.peers = [];
    ch?.close();
  }
  render();
}
function resume() {
  for (const room of rooms.values()) {
    const wasPaused = room.paused;
    room.paused = false;
    // A page that was frozen cannot trust its socket; a fresh one costs one round trip.
    if (wasPaused || Date.now() - room.lastSeen > HEARTBEAT_MS) room.connect();
    else room.check();
  }
}
document.addEventListener("visibilitychange", () => (document.visibilityState === "visible" ? resume() : pause()));
addEventListener("pageshow", (e) => e.persisted && resume());
addEventListener("online", resume);

function signalTo(key, peerId, xfer) {
  return (data) => rooms.get(key)?.ch?.send({ t: "signal", to: peerId, data: { ...data, xfer } });
}

// Every peer once, from whichever room saw it first.
function peerList() {
  const out = [];
  const seen = new Set();
  for (const [key, room] of rooms) {
    for (const p of room.peers) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ key, p });
    }
  }
  return out;
}

// Peers on this network go under "Same network"; peers met through a code go right under the code,
// where the person who typed it is looking.
function render() {
  const nearby = $("#peers");
  const viaCode = $("#code-peers");
  const hadCodePeers = viaCode.childElementCount > 0;
  nearby.replaceChildren();
  viaCode.replaceChildren();
  rows.clear();
  for (const { key, p } of peerList()) {
    const { name, platform } = splitName(p.name);
    const button = el("button", { type: "button", className: "peer" }, el("span", { className: "peer-name", textContent: name }), el("span", { className: "muted", textContent: isAgent(p) ? "inbox" : platform }));
    button.addEventListener("click", () => compose(key, p));
    button.addEventListener("dragover", (e) => {
      e.preventDefault();
      button.classList.add("target");
    });
    button.addEventListener("dragleave", () => button.classList.remove("target"));
    button.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      endDrag();
      dropTo(key, p, e.dataTransfer);
    });
    const row = el("li", {}, button);
    (key === "ip" ? nearby : viaCode).append(row);
    rows.set(p.id, button);
    if (sending.has(p.id)) setBusy(p.id, sending.get(p.id));
  }
  $("#empty").hidden = nearby.childElementCount > 0;
  viaCode.hidden = viaCode.childElementCount === 0;
  if (code) {
    $("#code-label").textContent = viaCode.childElementCount
      ? "Connected. Select the device below to send."
      : code.created
        ? "Enter this code on the other device, or scan it."
        : "Waiting for the other device...";
  }
  if (viaCode.childElementCount && !hadCodePeers) viaCode.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function setBusy(peerId, p) {
  if (p === null) sending.delete(peerId);
  else sending.set(peerId, p);
  const button = rows.get(peerId);
  if (!button) return;
  button.classList.toggle("busy", p !== null);
  button.style.setProperty("--p", `${Math.round((p ?? 0) * 100)}%`);
}

// Selecting a device offers both: pick files, or type a message.
function compose(key, peer) {
  const dialog = $("#compose");
  const input = $("#compose-text");
  $("#compose-title").textContent = `Send to ${shortName(peer.name)}`;
  $("#compose-files").onclick = () => {
    dialog.close();
    pickFiles((files) => sendTo(key, peer, { files }));
  };
  $("#compose-form").onsubmit = (e) => {
    e.preventDefault();
    if (!input.value.trim()) return input.focus();
    dialog.close();
    sendTo(key, peer, { text: input.value });
    input.value = "";
  };
  dialog.showModal();
}
$("#compose-cancel").addEventListener("click", () => $("#compose").close());
$("#compose-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#compose-form").requestSubmit();
});

function pickFiles(cb) {
  const input = el("input", { type: "file", multiple: true });
  input.addEventListener("change", () => input.files.length && cb([...input.files]));
  input.click();
}

function dropTo(key, peer, data) {
  if (data.files.length) sendTo(key, peer, { files: [...data.files] });
  else if (data.getData("text/plain")) sendTo(key, peer, { text: data.getData("text/plain") });
}

// Files dragged over the page highlight the devices; with exactly one device, the whole page is its drop target.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
function endDrag() {
  dragDepth = 0;
  document.body.classList.remove("dragging");
  $("#drop-overlay").hidden = true;
}
addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  const peers = peerList();
  $("#drop-overlay p").textContent =
    peers.length === 0 ? "Open this page on another device first" : peers.length === 1 ? `Drop to send to ${shortName(peers[0].p.name)}` : "Drop on a device to send";
  document.body.classList.add("dragging");
  $("#drop-overlay").hidden = false;
});
addEventListener("dragleave", (e) => {
  if (hasFiles(e) && --dragDepth <= 0) endDrag();
});
addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  endDrag();
  const peers = peerList();
  if (peers.length === 1) dropTo(peers[0].key, peers[0].p, e.dataTransfer);
});

// One line in the Transfers list, updated as the transfer moves along.
function transferRow(title) {
  const status = el("span", { className: "t-status" });
  const via = el("span", { className: "via" });
  const bar = el("progress", { max: 1, value: 0 });
  const out = el("div", { className: "received" });
  const row = el("li", { className: "transfer" }, el("div", { className: "t-head" }, el("span", { className: "t-title", textContent: title }), el("span", {}, via, status)), bar, out);
  $("#transfers").prepend(row);
  $("#transfers-section").hidden = false;
  const links = [];
  return {
    status(text, { path, state } = {}) {
      status.textContent = text;
      if (path) {
        via.textContent = path;
        via.title = path === "direct" ? "Straight between the two devices" : "Through a relay that forwards the bytes and keeps nothing";
      }
      if (state) {
        row.dataset.state = state;
        bar.hidden = true;
      }
    },
    progress: (v) => (bar.value = v),
    addText(text) {
      const copy = el("button", { type: "button", textContent: "Copy" });
      copy.addEventListener("click", () => copyText(copy, text, "Select the text to copy"));
      out.append(el("div", { className: "text" }, linkify(text), copy));
    },
    addFile(name, blob) {
      const a = el("a", { className: "file", href: URL.createObjectURL(blob), download: name }, el("span", { textContent: name }), el("span", { className: "muted", textContent: `${size(blob.size)}, save` }));
      out.append(a);
      links.push(a);
    },
    done() {
      if (links.length < 2) return;
      const all = el("button", { type: "button", textContent: `Save all ${links.length}` });
      all.addEventListener("click", async () => {
        for (const a of links) {
          a.click();
          await new Promise((r) => setTimeout(r, 300));
        }
      });
      out.append(all);
    },
  };
}

// What to send is either {files: File[]} or {text: string}.
async function sendTo(key, peer, { files = [], text = null }) {
  const xfer = randomHex(8);
  const send = signalTo(key, peer.id, xfer);
  const name = shortName(peer.name);
  const entries = (chunkSize) => (text !== null ? [textFile(text, { chunkSize })] : files.map((f) => browserFile(f, chunkSize)));
  const total = files.reduce((n, f) => n + f.size, 0);
  const ui = transferRow(text !== null ? `Message to ${name}` : `${files.length === 1 ? files[0].name : plural(files.length, "file")} (${size(total)}) to ${name}`);
  try {
    const offer = entries(CHUNK); // throws for a message over MAX_TEXT
    setBusy(peer.id, 0);
    ui.status(`Waiting for ${name} to accept`);
    const answer = waitFor(xfer, (d) => d.kind === "accept" || d.kind === "decline", 120000);
    // A short message rides along in the ask itself, so accepting it needs no data connection at all.
    // Receivers that do not know `body` reply without `got` and the message goes the usual way.
    const inline = text !== null && !isAgent(peer) && JSON.stringify(text).length <= INLINE_MAX ? { body: text } : {};
    send({ kind: "ask", files: offer.map((f) => ({ name: f.name, size: f.size, ...(f.text && { text: true }) })), from: me.name, ...inline });
    const reply = await answer;
    if (reply.kind === "decline") return ui.status(`${name} declined`, { state: "failed" });
    if (reply.got === true && inline.body !== undefined) return ui.status("Sent", { state: "done" });

    let ch = null;
    let chunk = CHUNK;
    let path = "relay";
    if (!isAgent(peer) || reply.rtc === true) {
      ui.status("Connecting...");
      try {
        const { dc, maxMessageSize } = await openDataChannel({ initiator: true, send, subscribe: (fn) => onXfer(xfer, fn) });
        ch = channel(dc);
        chunk = Math.min(CHUNK, maxMessageSize);
        path = "direct";
      } catch {}
    }
    if (!ch) {
      const sid = randomHex(16);
      send({ kind: "relay", sid });
      ch = await openRelay(location.origin, sid, "s");
    }
    ui.status("Sending", { path });
    await sendFiles(ch, entries(chunk), {
      onProgress: (p) => {
        const v = p.total ? p.acked / p.total : 1;
        ui.progress(v);
        setBusy(peer.id, v);
      },
    });
    ch.close();
    ui.status("Sent", { state: "done" });
  } catch (e) {
    ui.status(e.message === "no answer" ? `No answer from ${name}. Is the page still open there?` : `Could not send: ${e.message}`, { state: "failed" });
  } finally {
    setBusy(peer.id, null);
  }
}

function incoming(key, from, ask) {
  const files = Array.isArray(ask.files) ? ask.files : [];
  const total = files.reduce((n, f) => n + (Number(f.size) || 0), 0);
  const isMessage = files.length === 1 && files[0].text === true;
  const sender = shortName(ask.from);
  const dialog = $("#incoming");
  $("#incoming-title").textContent = `${sender} wants to send you ${isMessage ? "a message" : plural(files.length, "file")}`;
  const list = $("#incoming-files");
  list.replaceChildren();
  if (!isMessage) {
    for (const f of files.slice(0, 5)) list.append(el("li", {}, el("span", { textContent: String(f.name) }), el("span", { className: "muted", textContent: size(Number(f.size) || 0) })));
    if (files.length > 5) list.append(el("li", { className: "muted", textContent: `and ${files.length - 5} more` }));
  }
  $("#incoming-total").textContent = isMessage ? "Accept to see it." : `${size(total)} in total`;
  dialog.returnValue = "";
  dialog.showModal();
  dialog.addEventListener(
    "close",
    () => {
      const send = signalTo(key, from, ask.xfer);
      if (dialog.returnValue !== "accept") send({ kind: "decline" });
      else if (isMessage && typeof ask.body === "string") {
        send({ kind: "accept", got: true });
        const ui = transferRow(`Message from ${sender}`);
        ui.status("Received", { state: "done" });
        ui.addText(ask.body);
      } else receive(send, ask, { isMessage, total, count: files.length });
    },
    { once: true },
  );
}

// The receiver waits on both paths after accepting and takes whichever connects first.
async function receive(send, ask, offer) {
  const name = shortName(ask.from);
  const ui = transferRow(offer.isMessage ? `Message from ${name}` : `${plural(offer.count, "file")} (${size(offer.total)}) from ${name}`);
  const abort = new AbortController();
  let stopRelay = () => {};
  try {
    const relay = new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("no answer")), 120000);
      const off = onXfer(ask.xfer, (d) => d.kind === "relay" && /^[0-9a-f]{32}$/.test(d.sid) && done(null, d.sid));
      const done = (err, sid) => {
        clearTimeout(timer);
        off();
        if (err) reject(err);
        else resolve(openRelay(location.origin, sid, "r").then((ch) => ({ ch, path: "relay" })));
      };
      stopRelay = () => done(new Error("direct won"));
    });
    const direct = openDataChannel({ initiator: false, send, subscribe: (fn) => onXfer(ask.xfer, fn), timeoutMs: 15000, signal: abort.signal }).then(
      ({ dc }) => ({ ch: channel(dc), path: "direct" }),
    );
    send({ kind: "accept" });
    ui.status("Connecting...");
    const { ch, path } = await Promise.any([direct, relay]);
    if (path === "relay") abort.abort();
    else stopRelay();
    ui.status("Receiving", { path });
    const results = await receiveFiles(ch, {
      onOffer: () => true,
      onFile: (meta) => {
        const parts = [];
        return { write: (c) => parts.push(c), close: () => new Blob(parts, { type: meta.type || "application/octet-stream" }) };
      },
      onProgress: (p) => ui.progress(p.total ? p.received / p.total : 1),
    });
    closeWhenPeerDone(ch);
    ui.status("Received", { state: "done" });
    for (const r of results) {
      if (r.text) ui.addText(await r.result.text());
      else ui.addFile(r.name, r.result);
    }
    ui.done();
  } catch (e) {
    ui.status(`Could not receive: ${e.errors?.[0]?.message || e.message}`, { state: "failed" });
  }
}

// Codes connect devices on different networks; a code link (/#code=123456) or its QR joins straight away.
function useCode(value, created) {
  code = { value, created };
  joinRoom(`code:${value}`, `code/${value}`);
  const display = $("#code-display");
  display.textContent = `${value.slice(0, 3)} ${value.slice(3)}`;
  display.setAttribute("aria-label", value.split("").join(" "));
  $("#code-box").hidden = false;
  const link = `${location.origin}${location.pathname}#code=${value}`;
  const copy = $("#code-copy");
  copy.textContent = "Copy link";
  copy.onclick = () => copyText(copy, link);
  $("#qr-code").replaceChildren(qrSvg(link));
  render();
}

$("#create-code").addEventListener("click", () => {
  useCode(String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0"), true);
});

const joinInput = $("#join-code");
joinInput.addEventListener("input", () => {
  const digits = joinInput.value.replace(/\D/g, "").slice(0, 6);
  if (digits !== joinInput.value) joinInput.value = digits;
  if (digits.length === 6) $("#join-form").requestSubmit();
});
$("#join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = joinInput.value.replace(/\D/g, "");
  if (value.length !== 6) return joinInput.focus();
  useCode(value, false);
  joinInput.value = "";
  joinInput.blur();
});

const linked = /^#code=(\d{6})$/.exec(location.hash);
if (linked) {
  history.replaceState(null, "", location.pathname + location.search);
  useCode(linked[1], false);
}

$("#qr-here").append(qrSvg(`${location.origin}${location.pathname}`));
joinRoom("ip", "ip");
