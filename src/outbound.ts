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

export async function outboundFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  if (LOCAL_ONLY && !(await isPrivateUrl(url))) {
    let host = String(url);
    try {
      host = new URL(url).host;
    } catch {
      // Keep the raw value in the message.
    }
    throw new LocalOnlyError(host);
  }
  return fetch(url, init);
}
