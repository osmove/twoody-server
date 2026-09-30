import { BackendError } from "../account/backend.js";
import { bindingChecks, desktopBindingOf, deviceKind, mayApprove, readBinding, verifiedIds, type Anchor, type VaultDevice } from "./client.js";
import { onVaultChange, vaultRosterInput } from "./service.js";

// The verified mesh roster (docs/mesh-design.md §1, lot S2): which of the
// account's computers this one trusts, and which person-devices may vouch
// for a phone. Derived every time from the vault itself — GET /vault's
// devices, approvals and bindings, walked strictly forward from the person
// devices this computer pinned (src/vault/client.ts verifiedIds) — never
// stored, never taken from the backend's listing or account_peers.
//
//   computers  verified, trusted vault devices whose signed approval says
//              computer (approval/v2, client.ts deviceKind — never the kind
//              the account lists) with a valid binding for that same account
//              computer (tunnel_public_key, pairing_public_key), signed by a
//              verified device that may approve. Keyed by account computer
//              id. A Twoody Desktop counts too: a verified, trusted
//              person-device (by its signed approval) carrying a valid
//              desktop-binding-v1 — signed by its own vault key, naming its
//              account computer and its embedded server's tunnel key
//              (client.ts desktopBindingOf) — with canApprove true: it is
//              the person's machine. Two devices binding the same account
//              computer (either way): neither counts.
//   persons    verified, trusted devices that may approve (a person
//              device, or a computer whose binding says can_approve=true,
//              the Desktop): whose device-access-v1 lets a phone in
//              (account/approvals.ts rule 5).
//
// Cached 60 s; refreshed on each vault tick (service.ts onVaultChange), on
// a 401/404/410 from a peer (peers/index.ts), and at most every 10 s when
// asked about a computer it does not have (one just approved). When the
// account cannot be reached, the last verified roster is kept: it can only
// shrink by what the vault says. When the account says this computer has no
// vault (401, 403, 404, 410), nobody is in it.

export type RosterComputer = {
  accountComputerId: string;
  vaultDeviceId: string;
  label: string;
  tunnelPublicKey: string;
  pairingPublicKey: string;
  canApprove: boolean;
  /// "desktop": a person-device that bound itself (desktop-binding-v1);
  /// "computer": bound by a person-device (computer-binding-v1).
  via: "computer" | "desktop";
};
export type RosterPerson = { vaultDeviceId: string; label: string; signPublic: string };
export type Roster = { userId: string; computers: Map<string, RosterComputer>; persons: Map<string, RosterPerson> };
/// `revoked`: the devices the Desktop revoked (its append-only list, handed
/// with its keys): revoked here whatever the account says.
export type RosterInput = { userId: string; devices: VaultDevice[]; anchors: Anchor[]; revoked?: string[] };
export type RosterSource = () => Promise<RosterInput | null>;

/// The roster the vault's own signatures vouch for. Pure.
export function buildRoster({ userId, devices: listed, anchors, revoked = [] }: RosterInput): Roster {
  // A device the Desktop revoked is neither walked through nor counted,
  // even when the account shows it trusted again.
  const held = new Set(revoked);
  const devices = listed.map((d) => (held.has(d.id) && d.status !== "revoked" ? { ...d, status: "revoked" as const } : d));
  const byId = new Map(devices.map((d) => [d.id, d]));
  const verified = verifiedIds(userId, devices, anchors);
  const computers = new Map<string, RosterComputer>();
  const persons = new Map<string, RosterPerson>();
  const clashing = new Set<string>();
  const add = (computer: RosterComputer) => {
    const id = computer.accountComputerId;
    if (computers.has(id) || clashing.has(id)) {
      computers.delete(id);
      clashing.add(id);
      return;
    }
    computers.set(id, computer);
  };
  for (const device of devices) {
    if (device.status !== "trusted" || !verified.has(device.id)) continue;
    const approver = (binding: { approver_id: string }) => byId.get(binding.approver_id);
    const kind = deviceKind(userId, device, byId, verified);
    if (!kind) continue;
    if (kind.kind === "computer") {
      const binding = readBinding(device);
      if (!binding || binding.account_computer_id !== kind.account_computer_id) continue;
      if (!verified.has(binding.approver_id) || !bindingChecks(userId, device, binding, byId)) continue;
      if (!mayApprove(userId, approver(binding), byId, verified)) continue;
      add({
        accountComputerId: binding.account_computer_id,
        vaultDeviceId: device.id,
        label: device.label,
        tunnelPublicKey: binding.tunnel_public_key,
        pairingPublicKey: binding.pairing_public_key,
        canApprove: binding.can_approve,
        via: "computer",
      });
    }
    const person = mayApprove(userId, device, byId, verified);
    if (person) persons.set(device.id, { vaultDeviceId: device.id, label: device.label, signPublic: device.sign_public });
    // A Desktop: a person-device of the walk that says which computer it is.
    const desktop = person && kind.kind === "person" ? desktopBindingOf(userId, device, byId, verified) : null;
    if (desktop) {
      add({
        accountComputerId: desktop.account_computer_id,
        vaultDeviceId: device.id,
        label: device.label,
        tunnelPublicKey: desktop.tunnel_public_key,
        pairingPublicKey: desktop.pairing_public_key,
        canApprove: true,
        via: "desktop",
      });
    }
  }
  return { userId, computers, persons };
}

/// What changes the mesh: which computers, under which keys, and which
/// person devices.
function fingerprintOf(roster: Roster | null): string {
  if (!roster) return "";
  const computers = [...roster.computers.values()].map((c) => `${c.accountComputerId}=${c.vaultDeviceId}/${c.tunnelPublicKey}/${c.pairingPublicKey}/${c.canApprove}`).sort();
  const persons = [...roster.persons.values()].map((p) => `${p.vaultDeviceId}=${p.signPublic}`).sort();
  return `${roster.userId}|${computers.join(",")}|${persons.join(",")}`;
}

export type RosterChange = { roster: Roster | null; previous: Roster | null; left: string[]; joined: string[]; personsLeft: string[] };
export type RosterListener = (change: RosterChange) => void | Promise<void>;

export function createRosterCache({ source, ttlMs = 60_000, missRefreshMs = 10_000, now = Date.now }: { source: RosterSource; ttlMs?: number; missRefreshMs?: number; now?: () => number }) {
  let current: Roster | null = null;
  let fetchedAt = -Infinity;
  let running: Promise<Roster | null> | null = null;
  const listeners = new Set<RosterListener>();

  function settle(next: Roster | null) {
    const previous = current;
    current = next;
    fetchedAt = now();
    if (fingerprintOf(previous) === fingerprintOf(next)) return;
    const before = new Set(previous?.computers.keys() ?? []);
    const after = new Set(next?.computers.keys() ?? []);
    const change: RosterChange = {
      roster: next,
      previous,
      left: [...before].filter((id) => !after.has(id) || previous!.computers.get(id)!.tunnelPublicKey !== next!.computers.get(id)!.tunnelPublicKey),
      joined: [...after].filter((id) => !before.has(id) || previous!.computers.get(id)!.tunnelPublicKey !== next!.computers.get(id)!.tunnelPublicKey),
      personsLeft: [...(previous?.persons.keys() ?? [])].filter((id) => !next?.persons.has(id) || next.persons.get(id)!.signPublic !== previous!.persons.get(id)!.signPublic),
    };
    for (const listener of listeners) {
      try {
        void Promise.resolve(listener(change)).catch(() => undefined);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  /// Asks the vault again now (one call at a time).
  function refresh(): Promise<Roster | null> {
    running ??= (async () => {
      try {
        const input = await source();
        settle(input ? buildRoster(input) : null);
      } catch (err) {
        // The account said this computer has no vault here: nobody.
        if (err instanceof BackendError && [401, 403, 404, 410].includes(err.status)) settle(null);
        // Unreachable: the last verified roster stays, asked again next time.
        else fetchedAt = now() - ttlMs + missRefreshMs;
      }
      return current;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  /// The roster, at most `ttlMs` old.
  async function get(): Promise<Roster | null> {
    if (now() - fetchedAt < ttlMs) return current;
    return refresh();
  }

  /// A computer it does not have, asked about: maybe one approved a moment
  /// ago — asked again when the last look is older than `missRefreshMs`.
  async function lookup(accountComputerId: string): Promise<RosterComputer | null> {
    const roster = await get();
    const found = roster?.computers.get(accountComputerId);
    if (found) return found;
    if (now() - fetchedAt < missRefreshMs) return null;
    return (await refresh())?.computers.get(accountComputerId) ?? null;
  }

  return {
    get,
    refresh,
    /// The next get() asks the vault again.
    invalidate() {
      fetchedAt = -Infinity;
    },
    /// The roster as last verified, without asking (null before the first
    /// look, and once it is older than twice its lifetime).
    snapshot(): Roster | null {
      return now() - fetchedAt < 2 * ttlMs ? current : null;
    },
    lookup,
    async isTrustedComputer(accountComputerId: string): Promise<boolean> {
      return !!accountComputerId && (await lookup(accountComputerId)) !== null;
    },
    async tunnelKeyOf(accountComputerId: string): Promise<string | null> {
      return accountComputerId ? ((await lookup(accountComputerId))?.tunnelPublicKey ?? null) : null;
    },
    /// A person device's signing key, when it may vouch for a phone.
    async personOf(vaultDeviceId: string): Promise<RosterPerson | null> {
      return (await get())?.persons.get(vaultDeviceId) ?? null;
    },
    onChange(listener: RosterListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type RosterCache = ReturnType<typeof createRosterCache>;

// ── this server's roster ─────────────────────────────────────────────────

let cache: RosterCache = createRosterCache({ source: vaultRosterInput });
const moduleListeners = new Set<RosterListener>();
let unsubscribe = cache.onChange((change) => {
  for (const listener of moduleListeners) void Promise.resolve(listener(change)).catch(() => undefined);
});
export const meshRoster = (): RosterCache => cache;
export const isTrustedComputer = (accountComputerId: string) => cache.isTrustedComputer(accountComputerId);
export const tunnelKeyOf = (accountComputerId: string) => cache.tunnelKeyOf(accountComputerId);
export const rosterSnapshot = () => cache.snapshot();
export const refreshRoster = () => cache.refresh();

/// Whether `accountComputerId` is in the roster as last verified, reached
/// with `tunnelKey` (the key its link or session carries) — synchronous,
/// for the router: never a fetch.
export function trustedNow(accountComputerId: string, tunnelKey: string | null | undefined): boolean {
  const computer = cache.snapshot()?.computers.get(accountComputerId);
  return !!computer && !!tunnelKey && computer.tunnelPublicKey === tunnelKey.toLowerCase();
}

/// Called with what changed each time the roster does.
export function onRosterChange(listener: RosterListener): () => void {
  moduleListeners.add(listener);
  return () => moduleListeners.delete(listener);
}

let timer: NodeJS.Timeout | null = null;
let offVault: (() => void) | null = null;
/// Looks at the vault every `everyMs` (60 s), so that a computer that left
/// is noticed within that time even when nobody asks, and after each vault
/// tick. (Registered here, not when the module loads: vault/service.ts and
/// this module import each other through the account's modules.)
export function startRosterRefresh(everyMs = 60_000): () => void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void cache.refresh(), everyMs);
  timer.unref();
  offVault?.();
  offVault = onVaultChange(() => void cache.refresh());
  void cache.refresh();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    offVault?.();
    offVault = null;
  };
}

/// Tests: another source (a fake vault), clocks; `null` puts the vault back.
export function setRosterSource(source: RosterSource | null, options: { ttlMs?: number; missRefreshMs?: number; now?: () => number } = {}): RosterCache {
  unsubscribe();
  cache = createRosterCache({ source: source ?? vaultRosterInput, ...options });
  unsubscribe = cache.onChange((change) => {
    for (const listener of moduleListeners) void Promise.resolve(listener(change)).catch(() => undefined);
  });
  return cache;
}
