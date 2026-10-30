import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomToken } from "../shared/transfer.js";

// No built-in default until the project owns a domain: a default pointing at an unregistered domain
// would hand every user's files to whoever registers it.
export const DEFAULT_SERVER = process.env.TOSSTOME_SERVER || "https://toss2.me";

export function configDir() {
  return process.env.TOSSTOME_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tosstome");
}

// One inbox per config dir. The agent key never leaves this file; the send key is what the inbox link carries.
export async function loadOrCreateInbox({ server, fresh = false } = {}) {
  const dir = configDir();
  const file = join(dir, "inbox.json");
  if (!fresh) {
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (!server || saved.server === server) return saved;
    } catch {}
  }
  if (!server && !DEFAULT_SERVER) throw new Error("no server: pass --server URL or set TOSSTOME_SERVER");
  const inbox = {
    server: (server || DEFAULT_SERVER).replace(/\/+$/, ""),
    inboxId: randomToken(16),
    agentKey: randomToken(32),
    sendKey: randomToken(16),
  };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(inbox, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
  return inbox;
}

export function inboxLink(inbox) {
  return `${inbox.server}/i#${inbox.inboxId}.${inbox.sendKey}`;
}

export function parseInboxLink(link) {
  const u = new URL(link);
  const [inboxId, sendKey] = u.hash.slice(1).split(".");
  if (!inboxId || !sendKey) throw new Error("not an inbox link: expected https://host/i#<inbox>.<key>");
  return { server: u.origin, inboxId, sendKey };
}
