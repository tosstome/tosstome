# syntax=docker/dockerfile:1

# Bundles server/ into one ES module, exactly as `wrangler deploy` would upload it.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS bundle
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
RUN npx wrangler deploy --dry-run --outdir /out

# Fetches the workerd binary for the target platform without running it, so cross builds need no emulation.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS workerd
ARG TARGETARCH
ARG WORKERD_VERSION=1.20261029.1
WORKDIR /tmp/workerd
RUN case "$TARGETARCH" in amd64) arch=64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; esac \
 && npm pack --silent "@cloudflare/workerd-linux-$arch@$WORKERD_VERSION" \
 && tar -xzf ./*.tgz \
 && install -m 0755 package/bin/workerd /workerd \
 && mkdir /data

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=workerd /workerd /usr/local/bin/workerd
COPY --from=workerd --chown=nonroot:nonroot /data /data
COPY docker/tosstome.capnp /etc/tosstome/config.capnp
COPY --from=bundle /out/index.js /etc/tosstome/index.js
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/workerd", "serve", "--experimental", "/etc/tosstome/config.capnp"]
