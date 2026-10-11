import { lockTunnelIdentity, useTunnelKeyStore } from "./identity.js";

// The tunnel key inside Twoody Desktop (twoody-desktop
// src/main/tunnelKey.ts): sealed there by safeStorage, handed to this
// process at start, never written to a file here. The Desktop says it
// keeps the key with TWOODY_TUNNEL_KEY_STORE=desktop; a server started
// without it (a Pi, `twoody serve`, an older Desktop) keeps its 0600 file.
//
// The exchange, once, before anything can ask for the key:
//   server  → Desktop  {type: "tunnel-key-request"}
//   Desktop → server   {type: "tunnel-key", state, hex?}
//       "ok"     the key, sealed and read back (hex)
//       "none"   nothing kept yet: a key is made here, and handed back
//                {type: "tunnel-key-save", hex} to be sealed
//       "file"   no protected storage on this computer and nothing sealed:
//                the 0600 file, as before (Linux without a keyring)
//       "locked" a sealed key the Desktop cannot open now: nothing that
//                needs the key works, and no other key is made in its
//                place (every paired device pins it)
// No answer within the timeout counts as "locked", for the same reason.

export interface KeyParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  removeListener?(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

export type TunnelKeyHandOver = "ok" | "none" | "file" | "locked";

const HEX_KEY = /^[0-9a-f]{64}$/;

export function desktopKeepsTunnelKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TWOODY_TUNNEL_KEY_STORE === "desktop";
}

/// Asks the Desktop for the key and sets it up (identity.ts). Resolves with
/// what the Desktop said.
export function tunnelKeyFromDesktop(port: KeyParentPort, { timeoutMs = 30_000 } = {}): Promise<TunnelKeyHandOver> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (state: TunnelKeyHandOver, hex: string | null = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      port.removeListener?.("message", listener);
      if (state === "ok" || state === "none") {
        useTunnelKeyStore({
          initial: state === "ok" ? hex : null,
          save: (made) => port.postMessage({ type: "tunnel-key-save", hex: made }),
        });
      } else if (state === "locked") {
        lockTunnelIdentity("this computer's tunnel key is sealed in a keyring that cannot be opened now");
      } else {
        useTunnelKeyStore(null);
      }
      resolve(state);
    };
    const listener = ({ data }: { data: unknown }) => {
      const message = (data ?? {}) as { type?: unknown; state?: unknown; hex?: unknown };
      if (message.type !== "tunnel-key") return;
      if (message.state === "ok" && typeof message.hex === "string" && HEX_KEY.test(message.hex)) finish("ok", message.hex);
      else if (message.state === "none" || message.state === "file") finish(message.state);
      // "locked", or anything malformed: never a new key in place of the kept one.
      else finish("locked");
    };
    const timer = setTimeout(() => finish("locked"), timeoutMs);
    port.on("message", listener);
    port.postMessage({ type: "tunnel-key-request" });
  });
}
