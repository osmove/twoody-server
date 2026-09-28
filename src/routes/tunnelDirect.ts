import type { FastifyInstance } from "fastify";
import { Channel, rendezvousId, startHandshake } from "../tunnel/channel.js";
import { createTunnelHost, type TunnelHost } from "../tunnel/host.js";
import { helloFrame, readHello } from "../tunnel/link.js";
import { allTunnelPeers, tunnelIdentity } from "../tunnel/identity.js";

// `/tunnel` — the paired phone's way in on the local network, sealed.
//
// Until 28/09/2026 a phone on the same Wi-Fi called this server in plain
// HTTP: its documents, questions, answers and session token crossed the
// network readable by anyone on it. Away from home the same requests were
// already sealed, through the account's relay (tunnel/hostLink.ts). This
// is that channel, carried by a WebSocket straight to this computer
// instead of by the relay: the same keys exchanged at pairing, the same
// frames, the same host serving the requests inside.
//
// Nothing here needs a token: the phone names its session by the
// rendezvous derived from the two public keys, and only the device
// holding the paired private key can seal a frame the channel opens. A
// socket that sends anything else before a first frame opens is closed.
export async function tunnelDirectRoutes(app: FastifyInstance) {
  app.get("/tunnel", { websocket: true }, (socket, req) => {
    const rendezvous = String((req.query as { rendezvous?: string }).rendezvous ?? "").toLowerCase();
    const identity = tunnelIdentity();
    const peer = allTunnelPeers().find((candidate) => rendezvousId(identity.publicKey, candidate.publicKey) === rendezvous);
    if (!peer) {
      socket.close(1008, "unknown");
      return;
    }

    // The requests inside go to this server itself, never elsewhere.
    const localBaseUrl = `http://127.0.0.1:${req.socket.localPort}`;
    let host: TunnelHost | null = null;
    let proven = false;
    let queue = Promise.resolve();

    const handle = async (frame: Buffer) => {
      const hello = readHello(frame);
      if (hello) {
        // One session per socket: a second hello is not a reconnection.
        if (host) {
          socket.close(1008, "hello");
          return;
        }
        const handshake = startHandshake();
        const channel = new Channel({ role: "responder", handshake, identity, peerEphemeral: hello, peerStatic: peer.publicKey });
        host = createTunnelHost({
          channel,
          localBaseUrl,
          send: (sealed) => {
            if (socket.readyState === socket.OPEN) socket.send(sealed);
          },
          onError: (err) => req.log.debug({ err }, "tunnel direct"),
        });
        socket.send(helloFrame(handshake.ephemeralPublicKey));
        return;
      }
      if (!host) {
        socket.close(1008, "hello first");
        return;
      }
      const opened = await host.receive(frame);
      if (opened) proven = true;
      // Before its first authentic frame, a session is anyone's guess.
      else if (!proven) socket.close(1008, "not authentic");
    };

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const frame = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      queue = queue.then(() => handle(frame)).catch(() => socket.close(1011, "error"));
    });
    socket.on("close", () => host?.close());
  });
}
