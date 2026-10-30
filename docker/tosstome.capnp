# workerd config for the Docker image: the same Worker as on Cloudflare, with Durable Objects
# stored as SQLite files under /data. index.js is the bundle built from server/ by the Dockerfile.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    (name = "data", disk = (path = "/data", writable = true)),
  ],
  sockets = [(name = "http", address = "*:8080", http = (), service = "main")],
);

const worker :Workerd.Worker = (
  modules = [(name = "index.js", esModule = embed "index.js")],
  compatibilityDate = "2026-10-01",
  # uniqueKey decides object ids, so it must never change once a server holds inboxes.
  durableObjectNamespaces = [
    (className = "Room", uniqueKey = "tosstome-room", enableSql = true),
    (className = "Relay", uniqueKey = "tosstome-relay", enableSql = true),
    (className = "Inbox", uniqueKey = "tosstome-inbox", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "data"),
  bindings = [
    (name = "ROOM", durableObjectNamespace = (className = "Room")),
    (name = "RELAY", durableObjectNamespace = (className = "Relay")),
    (name = "INBOX", durableObjectNamespace = (className = "Inbox")),
    (name = "CLIENT_IP_HEADER", fromEnvironment = "CLIENT_IP_HEADER"),
  ],
);
