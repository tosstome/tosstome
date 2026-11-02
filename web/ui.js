// Small view helpers shared by the send page and the inbox page.
import qrcode from "./vendor/qrcode.mjs";

export const $ = (sel) => document.querySelector(sel);

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

export function size(n) {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(n / 1024))} KB`;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Device names are "Adjective Animal (Platform)" in browsers and "host (tosstome)" for a CLI inbox.
export function splitName(full) {
  const m = /^(.*\S)\s+\(([^()]+)\)$/.exec(String(full));
  return m ? { name: m[1], platform: m[2] } : { name: String(full), platform: "" };
}

// Sender-controlled text as a paragraph of text nodes, with http(s) URLs turned into links.
export function linkify(text) {
  const p = el("p", { className: "message" });
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]/g)) {
    p.append(text.slice(last, m.index), el("a", { href: m[0], textContent: m[0], target: "_blank", rel: "noopener noreferrer" }));
    last = m.index + m[0].length;
  }
  p.append(text.slice(last));
  return p;
}

// A QR code as an inline SVG drawn in currentColor.
export function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `-2 -2 ${n + 4} ${n + 4}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `QR code for ${text}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

export async function copyText(button, text, label) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = label ?? text;
  }
}
