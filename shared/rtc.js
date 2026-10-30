// WebRTC data channel over room signaling. Peers on the same LAN connect over their local addresses,
// so the bytes never leave the network; across NATs STUN usually finds a path. When it cannot,
// callers fall back to the relay.
const ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];

// send(data): deliver a signal to the peer. subscribe(fn): receive the peer's signals, returns unsubscribe.
// Always returns a promise: a browser without WebRTC (or with it disabled) rejects, so callers fall back.
export function openDataChannel(opts) {
  try {
    return connect(opts);
  } catch (e) {
    return Promise.reject(e);
  }
}

function connect({ initiator, send, subscribe, timeoutMs = 8000, signal }) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const pendingIce = [];
  let unsubscribe = () => {};

  return new Promise((resolve, reject) => {
    const fail = (err) => {
      clearTimeout(timer);
      unsubscribe();
      pc.close();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("direct connection timed out")), timeoutMs);
    signal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });

    const ready = (dc) => {
      clearTimeout(timer);
      unsubscribe();
      resolve({ dc, pc, maxMessageSize: pc.sctp?.maxMessageSize || 65536 });
    };
    const adopt = (dc) => {
      dc.binaryType = "arraybuffer";
      if (dc.readyState === "open") ready(dc);
      else dc.addEventListener("open", () => ready(dc), { once: true });
    };
    const flushIce = async () => {
      while (pendingIce.length) await pc.addIceCandidate(pendingIce.shift()).catch(() => {});
    };

    unsubscribe = subscribe(async (d) => {
      try {
        if (d.kind === "offer" && !initiator) {
          await pc.setRemoteDescription(d.sdp);
          await flushIce();
          await pc.setLocalDescription(await pc.createAnswer());
          send({ kind: "answer", sdp: pc.localDescription });
        } else if (d.kind === "answer" && initiator) {
          await pc.setRemoteDescription(d.sdp);
          await flushIce();
        } else if (d.kind === "ice" && d.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(d.candidate).catch(() => {});
          else pendingIce.push(d.candidate);
        }
      } catch (e) {
        fail(e);
      }
    });
    pc.addEventListener("icecandidate", (e) => e.candidate && send({ kind: "ice", candidate: e.candidate.toJSON() }));

    if (initiator) {
      adopt(pc.createDataChannel("tosstome", { ordered: true }));
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => send({ kind: "offer", sdp: pc.localDescription }))
        .catch(fail);
    } else {
      pc.addEventListener("datachannel", (e) => adopt(e.channel), { once: true });
    }
  });
}
