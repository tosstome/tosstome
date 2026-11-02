// Copies shared/ into web/shared/ so the browser client can import it as plain ES modules, with no bundler.
import { cpSync, rmSync } from "node:fs";

const from = new URL("../shared/", import.meta.url);
const to = new URL("./shared/", import.meta.url);
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
