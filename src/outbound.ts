import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

// Single gate for every outbound HTTP call the server makes.
//
// With TWOODY_LOCAL_ONLY=1 the server may only talk to this machine and
// to private-network hosts (a local LLM runtime, Home Assistant on the
// LAN, another box on the user's tailnet). Anything else — cloud LLMs,
// OpenAI Realtime, Spotify, an upstream Twoody backend — is refused
// here, whatever the rest of the configuration says. Clients read the
// flag from `/capabilities` and `/deployment` to show a truthful
// "local only" state.
//
// `test/outbound.test.ts` fails if a bare `fetch(` appears anywhere else
// in `src/`, so a new call site cannot bypass the gate by accident.

export const LOCAL_ONLY = ["1", "true"].includes(
  (process.env.TWOODY_LOCAL_ONLY ?? "").trim().toLowerCase(),
);

export class LocalOnlyError extends Error {
  constructor(host: string) {
    super(`Blocked by local-only mode: ${host} is not on this machine or a private network`);
    this.name = "LocalOnlyError";
  }
}

const privateRanges = new BlockList();
privateRanges.addSubnet("127.0.0.0", 8, "ipv4");
privateRanges.addSubnet("10.0.0.0", 8, "ipv4");
privateRanges.addSubnet("172.16.0.0", 12, "ipv4");
privateRanges.addSubnet("192.168.0.0", 16, "ipv4");
privateRanges.addSubnet("169.254.0.0", 16, "ipv4");
// Carrier-grade NAT space, which is where Tailscale addresses live.
privateRanges.addSubnet("100.64.0.0", 10, "ipv4");
privateRanges.addAddress("::1", "ipv6");
privateRanges.addSubnet("fc00::", 7, "ipv6");
privateRanges.addSubnet("fe80::", 10, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const candidate = mapped ? mapped[1] : address;
  const family = isIP(candidate);
  if (family === 0) return false;
  return privateRanges.check(candidate, family === 4 ? "ipv4" : "ipv6");
}

/// True when every address the URL's host resolves to is loopback or
/// private. A name that does not resolve is treated as not private.
export async function isPrivateUrl(url: string | URL): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (hostname === "localhost") return true;
  if (isIP(hostname) !== 0) return isPrivateAddress(hostname);
  try {
    const addresses = await lookup(hostname, { all: true });
    return addresses.length > 0 && addresses.every((entry) => isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

export async function outboundFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  // Judged by where it goes; sent as it came, method and body included.
  const href = url instanceof Request ? url.url : url;
  if (LOCAL_ONLY && !(await isPrivateUrl(href))) {
    let host = String(href);
    try {
      host = new URL(href).host;
    } catch {
      // Keep the raw value in the message.
    }
    throw new LocalOnlyError(host);
  }
  return fetch(url, init);
}

// The one door local-only mode has, and only for the tunnel.
//
// Local-only promises that nothing readable leaves this machine. The
// tunnel keeps that promise — every frame is sealed with keys only the
// two paired devices hold, and the relay carries bytes it cannot open —
// but it cannot keep it without reaching one outside address: a
// computer at home has no port anyone can call, so it has to go and
// fetch what its phone left at the relay.
//
// So the gate gets exactly one door, as narrow as the transport allows:
// the relay's origin, the single path the transport uses, and nothing
// else. A different path on the same host, a look-alike host, another
// port — all go through the ordinary gate and are refused there. And the
// door does not open over cleartext to anything outside the private
// network, in any mode: the account token rides in a header beside the
// sealed frames, and it is not sealed.

/// The only path the tunnel's transport asks of the relay
/// (relayTransport.ts), under the relay's own base path.
export const RELAY_FRAMES_PATH = "/api/v1/tunnel/frames";

export class RelayRefusedError extends Error {
  constructor(reason: string) {
    super(`Refused on the way to the relay: ${reason}`);
    this.name = "RelayRefusedError";
  }
}

/// A fetch for the tunnel: the relay's frames endpoint goes through the
/// door, everything else through `outboundFetch` as usual.
export function relayFetch(relayUrl: string | URL): typeof fetch {
  const relay = new URL(relayUrl);
  const framesPath = `${relay.pathname.replace(/\/+$/, "")}${RELAY_FRAMES_PATH}`;

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let target: URL | null = null;
    try {
      target = new URL(input instanceof Request ? input.url : input);
    } catch {
      // Not a URL: the ordinary gate will say so.
    }

    // The parser has already resolved "..", "%2e%2e" and the like, so
    // an exact comparison is a comparison of where the request really
    // goes, not of how it was spelled.
    if (target && target.origin === relay.origin && target.pathname === framesPath) {
      if (target.protocol !== "https:" && !(await isPrivateUrl(target))) {
        throw new RelayRefusedError(`${target.host} is outside the private network and not reached over HTTPS`);
      }
      return fetch(input, init);
    }
    return outboundFetch(input, init);
  }) as typeof fetch;
}
