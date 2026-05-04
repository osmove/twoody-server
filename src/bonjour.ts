// Bonjour / mDNS advertisement for the local server. Lets the RN app
// (and any compliant client) browse for `_twoody._tcp.` on the LAN
// instead of asking the user to type an IP. Without this, every
// install requires the user to know their Mac's IP address — which
// changes on DHCP renewal and is a friction wall for non-technical
// users.
//
// We publish a single service:
//   name: "Twoody Local"
//   type: "twoody"             → advertised as `_twoody._tcp.local`
//   port: <listen port>
//   txt:
//     version: package.json semver
//     api:     "/api/v1"
//     paired:  "true" | "false" (lets the client skip the pairing
//              prompt when an existing setup_token is on this host)
//
// Lifecycle is owned by the caller (index.ts) — `start(...)` returns
// a `stop()` so a graceful shutdown can unpublish before the process
// exits, otherwise stale entries linger in the local mDNS cache for
// up to 75 seconds (per RFC 6762).
import { Bonjour } from "bonjour-service";

export type BonjourHandle = {
  stop(): Promise<void>;
};

export type BonjourOptions = {
  port: number;
  /// Service display name — shows up in the Discover UI on the app.
  /// We default to "Twoody Local · <hostname>" so a household with
  /// two Macs running twoody-server can tell them apart.
  name?: string;
  /// Service version stamped on the TXT record so clients can
  /// negotiate API compat without an extra HTTP round-trip.
  version?: string;
  /// Whether the server already has a paired account. When false,
  /// the app can chain straight into the setup-token flow after
  /// picking the service.
  paired?: boolean;
};

export function startBonjour(options: BonjourOptions): BonjourHandle {
  const bonjour = new Bonjour();
  const hostnameSuffix = process.env.HOSTNAME?.split(".")[0]
    ?? require("os").hostname?.()?.split(".")[0]
    ?? "this-mac";
  const name = options.name ?? `Twoody Local · ${hostnameSuffix}`;

  const service = bonjour.publish({
    name,
    type: "twoody",
    protocol: "tcp",
    port: options.port,
    txt: {
      version: options.version ?? "0.0.0",
      api:     "/api/v1",
      paired:  options.paired ? "true" : "false",
    },
  });

  // Errors are non-fatal: advertisement failure means the user falls
  // back to the manual URL entry, which is fine. Logged through the
  // bonjour-service event bus so the Fastify logger picks it up via
  // process stderr if the caller wired logging that way.
  service.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.warn("[bonjour] publish error:", err.message ?? err);
  });

  return {
    async stop() {
      await new Promise<void>((resolve) => {
        try {
          // bonjour-service typings flag `service.stop` as
          // `(() => void) | undefined`; the runtime always provides
          // it on a successfully-published service, so the optional
          // call below is just to keep the compiler happy without
          // forcing a non-null assertion that masks a real bug if
          // the API changes upstream.
          if (typeof service.stop === "function") {
            service.stop(() => resolve());
          } else {
            resolve();
          }
        } catch {
          resolve();
        }
      });
      bonjour.destroy();
    },
  };
}
