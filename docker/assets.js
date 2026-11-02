// Serves the browser client from /etc/tosstome/web for the main Worker's ASSETS binding, the way Workers static
// assets do on Cloudflare: "/" is index.html, "/i" is i.html, and each file gets its content type.
const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
};

export default {
  async fetch(req, env) {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.split("/").includes("..")) return new Response("not found", { status: 404 });
    if (path.endsWith("/")) path += "index.html";
    else if (!/\.[A-Za-z0-9]+$/.test(path)) path += ".html";
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (!TYPES[ext]) return new Response("not found", { status: 404 });
    const file = await env.FILES.fetch(`http://files${path}`, { method: req.method });
    if (!file.ok) return new Response("not found", { status: 404 });
    return new Response(file.body, { headers: { "Content-Type": TYPES[ext], "Cache-Control": "no-cache" } });
  },
};
