import { browserFile, channel, CHUNK, openRelay, sendFiles, textFile } from "./shared/transfer.js";
import { openDataChannel } from "./shared/rtc.js";
import { deviceName } from "./shared/names.js";
import { $, el, plural, size } from "./ui.js";

// An inbox link is /i#<inbox id>.<send key>, printed by `tosstome listen`. The key stays in the fragment,
// so it never reaches the server in a URL, and is sent in the first WebSocket message instead.
const [inboxId, sendKey] = location.hash.slice(1).split(".");
let chosen = [];
let again = false;

const status = (text, state = "") => {
  $("#status").textContent = text;
  $("#status").dataset.state = state;
};
if (!inboxId || !sendKey) status("This inbox link is incomplete. Copy the whole link that tosstome listen printed.", "failed");

const message = () => $("#message").value;
const ready = () => (chosen.length > 0 || message().trim() !== "") && !!inboxId && !!sendKey;

// "2 files and a message".
function what() {
  return [chosen.length && plural(chosen.length, "file"), message().trim() && "a message"].filter(Boolean).join(" and ");
}

function refresh() {
  const parts = what();
  $("#send").textContent = again ? "Send more" : parts ? `Send ${parts}` : "Send";
  $("#send").disabled = !again && !ready();
}

function choose(files) {
  chosen = [...files];
  $("#chosen").replaceChildren(
    ...chosen.map((f, i) => {
      const remove = el("button", { type: "button", className: "link", textContent: "remove" });
      remove.setAttribute("aria-label", `Remove ${f.name}`);
      remove.addEventListener("click", () => choose(chosen.filter((_, j) => j !== i)));
      return el("li", {}, el("span", { textContent: f.name }), el("span", { className: "muted", textContent: size(f.size) }), remove);
    }),
  );
  refresh();
}

$("#message").addEventListener("input", refresh);
$("#files").addEventListener("change", (e) => {
  choose([...chosen, ...e.target.files]);
  e.target.value = "";
});
$("#drop").addEventListener("dragover", (e) => {
  e.preventDefault();
  $("#drop").classList.add("over");
});
$("#drop").addEventListener("dragleave", () => $("#drop").classList.remove("over"));
$("#drop").addEventListener("drop", (e) => {
  e.preventDefault();
  $("#drop").classList.remove("over");
  choose([...chosen, ...e.dataTransfer.files]);
});

$("#send").addEventListener("click", async () => {
  if (again) {
    again = false;
    status("");
    refresh();
    return $("#files").click();
  }
  $("#send").disabled = true;
  $("#progress").hidden = false;
  $("#progress").value = 0;
  try {
    const entries = (chunkSize) => [...(message().trim() ? [textFile(message(), { chunkSize })] : []), ...chosen.map((f) => browserFile(f, chunkSize))];
    entries(CHUNK); // throws for a message over the size limit before anything is sent
    status("Connecting to the inbox...");
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/inbox/${inboxId}?role=sender`);
    const ch = channel(ws);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("the server could not be reached")), { once: true });
    });
    ch.send({ t: "auth", key: sendKey, name: deviceName() });
    const auth = await ch.next();
    if (!auth?.ok) throw new Error("this inbox link is not valid");
    const m = await ch.next();
    if (m?.t === "offline") throw new Error("the computer is offline. Is tosstome listen running?");
    if (m?.t !== "relay") throw new Error("unexpected answer from the server");

    // An agent that takes direct connections (rtc) is tried over WebRTC first, signaling through the inbox;
    // it waits on the relay too, for when this fails.
    let out = null;
    let chunk = CHUNK;
    let path = "relay";
    if (m.rtc === true) {
      status("Connecting directly...");
      const subs = new Set();
      (async () => {
        for (let s; (s = await ch.next()) !== null; ) if (s.t === "signal" && s.sid === m.sid) for (const fn of subs) fn(s.data);
      })();
      try {
        const { dc, maxMessageSize } = await openDataChannel({
          initiator: true,
          send: (data) => ch.send({ t: "signal", sid: m.sid, data }),
          subscribe: (fn) => (subs.add(fn), () => subs.delete(fn)),
        });
        out = channel(dc);
        chunk = Math.min(CHUNK, maxMessageSize);
        path = "direct";
      } catch {}
    }
    ch.close();
    out ??= await openRelay(location.origin, m.sid, "s");
    status(`Sending (${path})...`);
    await sendFiles(out, entries(chunk), { onProgress: (p) => ($("#progress").value = p.total ? p.acked / p.total : 1) });
    out.close();
    status(`Sent ${what()} (${path}).`, "done");
    $("#progress").hidden = true;
    $("#message").value = "";
    again = true;
    choose([]);
  } catch (e) {
    $("#progress").hidden = true;
    status(`Not sent: ${e.message}`, "failed");
    $("#send").disabled = !ready();
  }
});
