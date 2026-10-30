#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import qrcode from "qrcode-terminal";
import { loadOrCreateInbox, inboxLink, parseInboxLink } from "../src/config.js";
import { textFile } from "../shared/transfer.js";
import { nodeFile, printable } from "../src/files.js";
import { listen, sendToInbox } from "../src/inbox.js";
import { joinNearby } from "../src/nearby.js";
import { serveMcp } from "../src/mcp.js";

const USAGE = `tosstome - an always-on inbox for files tossed from any browser

  tosstome listen [--dir DIR] [--server URL] [--new] [--nearby] [--json]
      Keep this computer's inbox open and save incoming files to DIR (default ./tosstome-inbox).
      Text messages are printed and also saved there as .txt files.
      Prints a link and QR code; open it on your phone to send files here.
      --nearby also shows this computer to browsers on the same network (no link needed);
      those files go to DIR/nearby, because anyone on that network can send them.
  tosstome url [--server URL]
      Print this computer's inbox link.
  tosstome send [FILE...] [--text TEXT] --to LINK
      Send files, a text message, or both to an inbox link. --text - reads the message from stdin.
  tosstome mcp [--dir DIR] [--server URL] [--nearby]
      Run as an MCP server over stdio, so coding agents can receive files from your phone
      and send files or messages back. The inbox starts on first use.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: "./tosstome-inbox" },
    server: { type: "string" },
    new: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    nearby: { type: "boolean", default: false },
    to: { type: "string" },
    text: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const cmd = positionals[0];
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

if (!cmd || values.help) {
  console.log(USAGE);
} else if (cmd === "url") {
  console.log(inboxLink(await loadOrCreateInbox({ server: values.server })));
} else if (cmd === "listen") {
  const inbox = await loadOrCreateInbox({ server: values.server, fresh: values.new });
  const link = inboxLink(inbox);
  if (!values.json) {
    console.log(`Inbox link (anyone with it can send files here):\n  ${link}\n`);
    qrcode.generate(link, { small: true });
    console.log(`Saving to ${values.dir}`);
  }
  let lastPct = -1;
  const onEvent = (e) => {
    if (values.json) {
      if (e.type !== "progress") console.log(JSON.stringify(e));
      return;
    }
    if (e.type === "ready") console.log("Listening.");
    else if (e.type === "offer") console.log(`Incoming from ${printable(e.from)} (${e.via}): ${e.files.map((f) => printable(f.name)).join(", ")}`);
    else if (e.type === "progress") {
      const pct = e.total ? Math.floor((e.received / e.total) * 100) : 100;
      if (pct !== lastPct && pct % 10 === 0) console.log(`  ${pct}% (${mb(e.received)} / ${mb(e.total)})`);
      lastPct = pct;
    } else if (e.type === "file" && e.message !== undefined) console.log(`Message from ${printable(e.from)} (saved to ${e.path}):\n${printable(e.message)}`);
    else if (e.type === "file") console.log(`Saved ${e.path} (${mb(e.size)})`);
    else if (e.type === "error") console.error(`Error: ${e.message}`);
    else if (e.type === "disconnected") console.error("Disconnected, reconnecting...");
    else if (e.type === "nearby-ready") console.log(`Visible to browsers on this network as "${e.name}".`);
  };
  const tasks = [listen(inbox, { dir: values.dir, onEvent })];
  if (values.nearby) tasks.push(joinNearby(inbox.server, { dir: values.dir, onEvent }));
  await Promise.all(tasks);
} else if (cmd === "mcp") {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await serveMcp({ server: values.server, dir: values.dir, nearby: values.nearby, version });
  process.exit(0);
} else if (cmd === "send") {
  if (!values.to || (positionals.length < 2 && values.text === undefined)) {
    console.error(USAGE);
    process.exit(2);
  }
  const files = await Promise.all(positionals.slice(1).map(nodeFile));
  if (values.text !== undefined) {
    let text = values.text;
    if (text === "-") {
      const parts = [];
      for await (const c of process.stdin) parts.push(c);
      text = Buffer.concat(parts).toString("utf8");
    }
    files.unshift(textFile(text));
  }
  const t0 = Date.now();
  let total = 0;
  const via = await sendToInbox(parseInboxLink(values.to), files, {
    onProgress: (p) => {
      total = p.total;
    },
  });
  const secs = (Date.now() - t0) / 1000;
  const n = files.length - (values.text !== undefined ? 1 : 0);
  console.log(`Sent ${[values.text !== undefined && "a message", n && `${n} file(s)`].filter(Boolean).join(" and ")}, ${mb(total)} in ${secs.toFixed(1)}s (${via})`);
  process.exit(0);
} else {
  console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
  process.exit(2);
}
