import { createReadStream } from "node:fs";
import { open, readFile, rename, stat, mkdir, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { CHUNK } from "../shared/transfer.js";

// Names come from the sender, so they are reduced to a plain file name inside the target directory.
export function safeName(name) {
  let n = basename(String(name).replace(/\\/g, "/"))
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return n || "file";
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Writes to "<name>.part" and renames on completion, never overwriting an existing file.
export async function diskSink(dir, meta) {
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  const name = safeName(meta.name);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let finalPath = join(root, name);
  for (let i = 1; await exists(finalPath); i++) finalPath = join(root, `${stem} (${i})${ext}`);
  if (!finalPath.startsWith(root + sep)) throw new Error("refusing path outside target dir");
  const partPath = `${finalPath}.part`;
  const fh = await open(partPath, "wx");
  return {
    async write(chunk) {
      await fh.write(chunk);
    },
    async close() {
      await fh.close();
      await rename(partPath, finalPath);
      return finalPath;
    },
    async abort() {
      await fh.close().catch(() => {});
      await unlink(partPath).catch(() => {});
    },
  };
}

// The "file" event for a received entry. Text messages are saved like files and also carry their content.
export async function fileEvent(from, f) {
  const e = { type: "file", from, name: f.name, size: f.size, path: f.result };
  if (f.text) e.message = await readFile(f.result, "utf8");
  return e;
}

// Sender-controlled text for a terminal: keeps newlines and tabs, drops control characters (escape sequences).
export const printable = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

export async function nodeFile(path) {
  const s = await stat(path);
  return {
    name: basename(path),
    size: s.size,
    type: "",
    async *chunks() {
      for await (const c of createReadStream(path, { highWaterMark: CHUNK })) yield new Uint8Array(c);
    },
  };
}
