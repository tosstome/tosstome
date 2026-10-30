// Drives `tosstome mcp` over stdio against a running server (default: local `wrangler dev`).
// Usage: node tests/mcp.mjs [http://127.0.0.1:8787]
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { channel, openRelay, randomHex, receiveFiles, textFile } from "../shared/transfer.js";
import { parseInboxLink } from "../cli/src/config.js";
import { nodeFile } from "../cli/src/files.js";
import { sendToInbox } from "../cli/src/inbox.js";
import { directAvailable } from "../cli/src/direct.js";
import { openDataChannel } from "../shared/rtc.js";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const BIN = fileURLToPath(new URL("../cli/bin/tosstome.js", import.meta.url));
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const sha = (b) => createHash("sha256").update(b).digest("hex");

const tmp = await mkdtemp(join(tmpdir(), "tosstome-mcp-"));
const inboxDir = join(tmp, "inbox");
const proc = spawn(process.execPath, [BIN, "mcp", "--server", BASE, "--dir", inboxDir], {
  env: { ...process.env, TOSSTOME_HOME: join(tmp, "config") },
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();
const stray = [];
createInterface({ input: proc.stdout }).on("line", (line) => {
  const m = JSON.parse(line); // anything on stdout that is not JSON is a protocol violation and fails loudly
  if (pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else stray.push(m);
});
const modernMeta = { [`io.modelcontextprotocol/protocolVersion`]: "2026-07-28", [`io.modelcontextprotocol/clientInfo`]: { name: "test", version: "0" }, [`io.modelcontextprotocol/clientCapabilities`]: {} };
const request = (method, params = {}, id = nextId++) => {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: modernMeta } })}\n`);
  return new Promise((r) => pending.set(id, r));
};
const call = (name, args = {}) => request("tools/call", { name, arguments: args }).then((m) => m.result);

// 1. versions
{
  const d = await request("server/discover");
  check("discover lists the modern version", d.result?.supportedVersions?.includes("2026-07-28") && d.result.resultType === "complete");
  const bad = await new Promise((r) => {
    const id = nextId++;
    pending.set(id, r);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } })}\n`);
  });
  check("unsupported version is refused with -32022", bad.error?.code === -32022 && bad.error.data.supported.includes("2026-07-28"));
  const init = await new Promise((r) => {
    const id = nextId++;
    pending.set(id, r);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "0" } } })}\n`);
  });
  check("legacy initialize is answered", init.result?.protocolVersion === "2025-06-18" && init.result.capabilities.tools);
  const list = await request("tools/list");
  check("tools/list", list.result.tools.map((t) => t.name).join() === "get_inbox_link,wait_for_files,list_received_files,send_files");
}

// 2. phone -> agent through the inbox link
const linkResult = await call("get_inbox_link");
const link = linkResult.structuredContent.link;
check("get_inbox_link starts the inbox", linkResult.structuredContent.status === "listening", linkResult.structuredContent.status);
{
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(2000)]);
  const txt = randomBytes(300 * 1024);
  await writeFile(join(tmp, "shot.png"), png);
  await writeFile(join(tmp, "log.txt"), txt);
  const waiting = call("wait_for_files", { timeout_seconds: 30 });
  await new Promise((r) => setTimeout(r, 300));
  await sendToInbox(parseInboxLink(link), [await nodeFile(join(tmp, "shot.png")), await nodeFile(join(tmp, "log.txt"))], { name: "Phone" });
  const got = await waiting;
  const files = got.structuredContent.files;
  check("wait_for_files returns the whole batch", files.length === 2, files.map((f) => f.name).join());
  const saved = files.find((f) => f.name === "log.txt");
  check("received file is intact", saved && sha(await readFile(saved.path)) === sha(txt));
  const image = got.content.find((c) => c.type === "image");
  check("small image is returned inline", image?.mimeType === "image/png" && Buffer.from(image.data, "base64").equals(png));
  const listed = await call("list_received_files");
  check("list_received_files", listed.structuredContent.files.length === 2);
}

// 2b. a text message from the phone comes back inline, and is saved too
{
  const note = "deploy key is in 1Password\nhttps://example.com/a?b=1 ✓";
  const waiting = call("wait_for_files", { timeout_seconds: 30 });
  await new Promise((r) => setTimeout(r, 300));
  await sendToInbox(parseInboxLink(link), [textFile(note)], { name: "Phone" });
  const got = await waiting;
  const item = got.structuredContent.files[0];
  check("a text message is returned inline", item?.message === note && got.content[0].text.includes(note));
  check("a text message is also saved as .txt", item && item.path.endsWith(".txt") && (await readFile(item.path, "utf8")) === note);
}

// 3. wait_for_files times out cleanly
{
  const r = await call("wait_for_files", { timeout_seconds: 1 });
  check("wait_for_files times out with no files", r.structuredContent.files.length === 0 && !r.isError);
}

// 4. agent -> another inbox (its own link, so it loops back)
{
  const data = randomBytes(64 * 1024);
  await writeFile(join(tmp, "back.bin"), data);
  const waiting = call("wait_for_files", { timeout_seconds: 30 });
  await new Promise((r) => setTimeout(r, 300));
  const sent = await call("send_files", { paths: [join(tmp, "back.bin")], to: link });
  const got = await waiting;
  check("send_files to an inbox link", !sent.isError && got.structuredContent.files[0]?.name === "back.bin", sent.content[0].text);
}

// 5. agent -> a browser waiting on a 6-digit code. The test plays the browser, using the web app's signals:
// after accepting it waits on a direct connection and on the relay, like the page does. With direct: false
// it ignores WebRTC offers, like a browser where WebRTC fails, so the agent must fall back to the relay.
await directAvailable();
async function browserOnCode(code, { accept, direct = true }) {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/room/code/${code}?id=${randomHex(8)}&name=Phone`);
  const ch = channel(ws);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const subs = new Set();
  const asked = new Promise((resolve) => {
    (async () => {
      for (let m; (m = await ch.next()) !== null; ) {
        if (m.t !== "signal") continue;
        if (m.data.kind === "ask") resolve({ ask: m.data, from: m.from });
        else for (const fn of subs) fn(m.data);
      }
    })();
  });
  // Wrapped so awaiting the join does not also wait for the transfer.
  const done = (async () => {
    const { ask, from } = await asked;
    const send = (data) => ch.send({ t: "signal", to: from, data: { ...data, xfer: ask.xfer } });
    if (!accept) {
      send({ kind: "decline" });
      return { ask };
    }
    const subscribe = (fn) => (subs.add(fn), () => subs.delete(fn));
    const relay = new Promise((r) => subs.add((d) => d.kind === "relay" && r(d.sid))).then((sid) => openRelay(BASE, sid, "r")).then((c) => ({ c, via: "relay" }));
    const attempts = [relay];
    if (direct) attempts.push(openDataChannel({ initiator: false, send, subscribe, timeoutMs: 15000 }).then(({ dc, pc }) => ({ c: channel(dc), pc, via: "direct" })));
    send({ kind: "accept" });
    const { c, pc, via } = await Promise.any(attempts);
    const files = await receiveFiles(c, {
      onFile: () => {
        const parts = [];
        return { write: (x) => parts.push(Buffer.from(x)), close: () => Buffer.concat(parts) };
      },
    });
    c.close();
    pc?.close();
    ch.close();
    return { ask, files, via };
  })();
  return { done };
}
{
  const data = randomBytes(700 * 1024);
  await writeFile(join(tmp, "report.pdf"), data);
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const phone = await browserOnCode(code, { accept: true });
  const sent = await call("send_files", { paths: [join(tmp, "report.pdf")], code });
  const got = await phone.done;
  check("send_files to a code reaches the browser", !sent.isError && got.files?.[0]?.name === "report.pdf" && sha(got.files[0].result) === sha(data), sent.content[0].text);
  check("send_files to a code goes direct", got.via === "direct" && /\(direct\)/.test(sent.content[0].text), got.via);
  check("browser saw the file list in the ask", got.ask?.files?.[0]?.size === data.byteLength);

  const code2 = String(100000 + Math.floor(Math.random() * 900000));
  const declining = await browserOnCode(code2, { accept: false });
  const refused = await call("send_files", { paths: [join(tmp, "report.pdf")], code: code2 });
  await declining.done;
  check("decline is reported as a tool error", refused.isError && /declined/.test(refused.content[0].text), refused.content[0].text);

  const code3 = String(100000 + Math.floor(Math.random() * 900000));
  const phone3 = await browserOnCode(code3, { accept: true, direct: false });
  const msg = "npm run build && npm test";
  const sentText = await call("send_files", { text: msg, code: code3 });
  const got3 = await phone3.done;
  check("send_files text reaches the browser as a message", !sentText.isError && got3.files?.length === 1 && got3.files[0].text === true && got3.files[0].result.toString() === msg, sentText.content[0].text);
  check("the ask marks it as a message", got3.ask?.files?.[0]?.text === true);
  check("send_files falls back to the relay when WebRTC fails", got3.via === "relay" && /\(relay\)/.test(sentText.content[0].text), got3.via);
}

// 6. argument errors are tool errors, not protocol errors
{
  const both = await call("send_files", { paths: [join(tmp, "report.pdf")], code: "123456", to: link });
  check("code and to together is rejected", both.isError);
  const nothing = await call("send_files", { to: link });
  check("nothing to send is rejected", nothing.isError);
  const missing = await call("send_files", { paths: [join(tmp, "nope.bin")], to: link });
  check("missing file is rejected", missing.isError && /cannot read/.test(missing.content[0].text));
}

// 7. a cancelled wait sends no response
{
  const id = nextId++;
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "wait_for_files", arguments: { timeout_seconds: 5 }, _meta: modernMeta } })}\n`);
  await new Promise((r) => setTimeout(r, 300));
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } })}\n`);
  await new Promise((r) => setTimeout(r, 1500));
  check("cancelled request gets no response", !stray.some((m) => m.id === id));
}

proc.stdin.end();
const code = await new Promise((r) => proc.on("exit", r));
check("exits when stdin closes", code === 0);
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
