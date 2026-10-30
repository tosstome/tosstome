# tosstome

Toss files between devices from the browser, and keep an always-on inbox on your computer that your phone (or any browser) can send to. Runs entirely on Cloudflare Workers. Nothing is stored: files go device to device over WebRTC when possible, otherwise through a relay that forwards bytes without keeping them.

Status: **M0 prototype**. Running at https://toss2.me, which is also the CLI default server.

## What works

- **Nearby**: open the page on two devices on the same network and they see each other (grouped by public IP, like Snapdrop/PairDrop). Tap a device, pick files, the other side accepts.
- **Codes**: on different networks, one device creates a 6-digit code and the other enters it.
- **Text messages**: tap a device and type or paste instead of picking files; the inbox page has a message box too. A message is a UTF-8 `.txt` entry flagged `text: true` in the transfer protocol (up to 1 MB), so it takes every path a file does: the receiving page shows it with a Copy button and clickable links, `tosstome listen` prints it and saves the `.txt`, and `tosstome send --text` sends one.
- **Direct first, relay second**: transfers try a WebRTC data channel (STUN via `stun.cloudflare.com`) and fall back to a Durable Object relay after 8 seconds. On the same network a direct transfer never leaves it. This holds for the CLI too: browser to `tosstome listen` (inbox link and `--nearby`), and `tosstome` to a browser on a code, all go direct when they can. The CLI gets WebRTC from `node-datachannel`, an optional dependency; without it, or with `TOSSTOME_DIRECT=0`, the CLI uses only the relay.
- **Inbox**: `tosstome listen` keeps an always-on inbox on a computer and prints a link and QR code. Opening the link on a phone sends files straight to that computer's folder.
- **MCP** (`tosstome mcp`): a stdio MCP server so coding agents can receive files from a phone (`get_inbox_link`, `wait_for_files`, `list_received_files`) and send files or text back (`send_files` with `paths` and/or `text`, to a 6-digit code or an inbox link). Answers both the 2026-07-28 per-request `_meta` revision and the legacy `initialize` handshake. The inbox starts on first use, so only run one inbox holder at a time.
- **Nearby inbox** (`--nearby`): the listening computer also appears in the Nearby list of browsers on the same network. Those files go to a separate `nearby/` folder, because anyone on that network can send them.

## Repository layout

- `server/`: the Cloudflare Worker and its Durable Objects. AGPL-3.0.
- `cli/`: the `tosstome` command line tool and MCP server. MIT. `npm install` in `cli/` copies `shared/` into `cli/shared/` so the published package is self-contained; run `npm run prepare --prefix cli` (or `npm test`, which does it first) after editing `shared/`.
- `shared/`: the transfer protocol, WebRTC and device-name code used by the CLI and by browser clients. MIT.
- `tests/`: end-to-end tests against a running server.

The toss2.me website (the browser app and content pages) is not part of this repository. The server here is the API it talks to; any client that uses `shared/` can talk to it the same way.

## Run locally

```sh
npm install                                     # test dependencies
cd server && npm install && npx wrangler dev --port 8787
cd cli && npm install
node cli/bin/tosstome.js listen --server http://127.0.0.1:8787
```

## Deploy

### Cloudflare Workers

```sh
cd server && npx wrangler deploy   # uses wrangler's own login
```

This deploys the API only. To serve your own web client from the same Worker, add an `assets` block with `"binding": "ASSETS"` to `server/wrangler.jsonc`; every path outside `/api/` is then handed to it.

Uses only Workers and SQLite-backed Durable Objects, so the Workers Free plan is enough to try it. Workers do not charge for egress; relayed transfers are billed as Durable Object duration while the relay is active.

### Docker

```sh
docker run -d -p 8080:8080 -v tosstome-data:/data tosstome/tosstome
```

The image runs the same Worker code in [workerd](https://github.com/cloudflare/workerd), Cloudflare's open source Workers runtime, with Durable Objects kept as SQLite files in `/data` (only inbox key hashes are stored there; files never are). It listens on plain HTTP port 8080, so put a reverse proxy with TLS in front of it for use over the internet. See `docker-compose.yml`.

Nearby grouping needs the client address, which workerd does not see. Set `CLIENT_IP_HEADER` to the header your reverse proxy overwrites with it (for example `X-Real-IP`, or `X-Forwarded-For`, of which the last entry is used). Never set it to a header the proxy passes through from clients, or anyone could join another network's Nearby list. Without it, every device lands in one group, which is fine for a server reachable from only one network.

Build it yourself with `docker build -t tosstome .`. The `docker` GitHub Actions workflow builds the image, runs the tests below against it, and on pushes to `main` and `v*` tags publishes `linux/amd64` and `linux/arm64` images to Docker Hub; pushes to `main` also copy this README to the Docker Hub page. It needs the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (Read, Write, Delete) secrets and the `DOCKERHUB_IMAGE` variable (such as `yourname/tosstome`).

## Architecture

```
browser / CLI
   | WebSocket
Worker on Cloudflare or workerd in Docker (/api routing, optional static assets)
   |-- Room DO    presence + WebRTC signaling (one per network or code)
   |-- Relay DO   blind byte relay, a fixed pool of 8 shared objects so concurrent transfers share duration billing
   `-- Inbox DO   one per inbox: key check, hands sender and agent a relay session
```

The transfer protocol (`shared/transfer.js`) is shared by browser clients and the CLI: JSON control frames plus binary chunks, with end-to-end acks so flow control behaves the same over WebRTC and the relay. The sender picks the path; the receiver waits on both and takes whichever connects. WebRTC signals travel through the Room (nearby and codes) or the Inbox (inbox links). A CLI agent says it takes direct connections (`rtc: true` in its nearby accept and inbox auth), so clients never wait on WebRTC with an agent that cannot answer.

## Security model (M0)

- An inbox has two secrets created by the CLI: an **agent key** (never leaves `~/.config/tosstome/inbox.json`) and a **send key** carried in the inbox link's `#fragment`. The server stores only their SHA-256 hashes. Keys are sent in the first WebSocket message, not in URLs.
- Wrong keys are counted per role: senders guessing keys lock out senders, never the owner's agent.
- File names from senders are reduced to a plain name inside the target folder; files are written as `.part` and renamed when complete.
- **Not yet**: end-to-end encryption on the relay (traffic is TLS to Cloudflare only), signed device pairing, TOTP/CPace guest sessions, rate limits. These are M1.

## Tests

```sh
node tests/integration.mjs http://127.0.0.1:8787   # relay, inbox, auth, nearby, rooms
node tests/rtc_node.mjs http://127.0.0.1:8787      # WebRTC direct path via node-datachannel
node tests/mcp.mjs http://127.0.0.1:8787           # tosstome mcp over stdio: versions, inbox, code room, cancel
```

## License

`server/` and everything not marked otherwise: AGPL-3.0 (`LICENSE`). `cli/` and `shared/`: MIT (their own `LICENSE` files).
