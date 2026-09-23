import { Channel, rendezvousId, startHandshake, type StaticIdentity } from "./channel.js";
import { createTunnelHost, type TunnelHost } from "./host.js";
import { helloFrame, readHello } from "./link.js";
import { createRelayTransport, type RelayTransport } from "./relayTransport.js";

// This computer, waiting at the relay for its own phone.
//
// It puts together the three pieces that were each written and tested
// on their own: the transport that carries frames, the channel that
// seals them, and the host that serves the requests inside. What is
// left here is the joining, and one decision worth stating.
//
// A session starts when a hello arrives, and a hello is the one frame
// nobody has authenticated yet — anyone who could reach this queue
// could send one. So a new session does not replace the one in use on
// the strength of a hello. It waits in the wings until a frame opens
// under it, which only the device holding the paired static key can
// produce. A phone that reconnects takes over in one round trip; a
// hello from anyone else changes nothing and is forgotten at the next
// one.

export interface TunnelHostLinkOptions {
  backendUrl: string;
  userToken: string;
  deviceToken?: string;
  /// This computer's long-lived key pair.
  identity: StaticIdentity;
  /// The public key of the phone paired with it. One link serves one
  /// phone: a second phone is a second rendezvous, and a second link.
  peerStaticKey: Buffer;
  /// The Twoody server on this machine.
  localBaseUrl: string;
  onError?(err: unknown): void;
  /// Whether the relay answers this link's waits (relayTransport.ts).
  onReachable?(reachable: boolean): void;
  fetchImpl?: typeof fetch;
  waitSeconds?: number;
}

export interface TunnelHostLink {
  /// The name this session has at the relay. Neither device tells it to
  /// the relay: both derive it from the two public keys.
  readonly rendezvous: string;
  /// Whether a phone has a session open right now.
  readonly connected: boolean;
  /// Whether the relay has seen the phone recently.
  readonly peerListening: boolean;
  stop(): void;
}

export function startTunnelHostLink(options: TunnelHostLinkOptions): TunnelHostLink {
  const rendezvous = rendezvousId(options.identity.publicKey, options.peerStaticKey);
  let active: { channel: Channel; host: TunnelHost } | null = null;
  let pending: { channel: Channel; host: TunnelHost } | null = null;
  let transport: RelayTransport;

  function session(channel: Channel): { channel: Channel; host: TunnelHost } {
    return {
      channel,
      host: createTunnelHost({
        channel,
        localBaseUrl: options.localBaseUrl,
        onError: options.onError,
        send: (frame) => transport.send([frame]),
      }),
    };
  }

  async function greet(peerEphemeral: Buffer): Promise<void> {
    const handshake = startHandshake();
    const channel = new Channel({
      role: "responder",
      handshake,
      identity: options.identity,
      peerEphemeral,
      peerStatic: options.peerStaticKey,
    });
    pending?.host.close();
    pending = session(channel);
    await transport.send([helloFrame(handshake.ephemeralPublicKey)]);
  }

  transport = createRelayTransport({
    backendUrl: options.backendUrl,
    userToken: options.userToken,
    deviceToken: options.deviceToken,
    rendezvous,
    as: "host",
    onError: options.onError,
    onReachable: options.onReachable,
    fetchImpl: options.fetchImpl,
    waitSeconds: options.waitSeconds,
    onFrames: async (frames) => {
      for (const frame of frames) {
        const hello = readHello(frame);
        if (hello) {
          await greet(hello);
          continue;
        }

        // The session in use gets first refusal, so an old hello left
        // lying at the relay cannot interrupt a conversation.
        if (active && (await active.host.receive(frame))) continue;

        if (pending) {
          const taking = pending;
          // Opening it is the proof: only the device holding the paired
          // static key can seal a frame this channel accepts.
          if (await taking.host.receive(frame)) {
            active?.host.close();
            active = taking;
            pending = null;
          }
        }
      }
    },
  });

  return {
    rendezvous,
    get connected() {
      return active !== null;
    },
    get peerListening() {
      return transport.peerListening;
    },
    stop(): void {
      transport.stop();
      active?.host.close();
      pending?.host.close();
      active = null;
      pending = null;
    },
  };
}
