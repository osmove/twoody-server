import { sqlite } from "./db.js";

// What Twoody may do for the person on this computer, each switched on by
// them, one by one (Jimmy, 02/10/2026: « toutes les capacités doivent être
// désactivées par défaut, le user pourra les activer et les configurer une
// à une »). The server holds the switches because it is what reads the
// documents, the contacts and the agenda for a chat — this computer's or a
// phone's. Web search, dictation and the Agent are clicked in the chat:
// their switch only shows or hides the button.
//
// Kept in `users.prefs` as `local_capabilities: { documents: true }`.
// An installation from before the switches keeps what it was using: the
// first read turns on documents when folders are granted, contacts and the
// agenda when there are some.

// « email »: the person's mailbox, read over IMAP from this computer
// (src/email/, Jimmy, 04/10/2026: « IMAP d'abord »).
// « bank »: the bank statements the person imports, read and kept on this
// computer (src/bank/, Jimmy, 04/10/2026: « import de relevés pour la banque »).
export const LOCAL_CAPABILITIES = ["documents", "contacts", "calendar", "web", "dictation", "agent", "home", "connectors", "memory", "email", "bank"] as const;
export type LocalCapability = (typeof LOCAL_CAPABILITIES)[number];

export function isLocalCapability(value: unknown): value is LocalCapability {
  return typeof value === "string" && (LOCAL_CAPABILITIES as readonly string[]).includes(value);
}

function readPrefs(userId: string): Record<string, unknown> {
  const row = sqlite.prepare("SELECT prefs AS prefs FROM users WHERE id = ?").get(userId) as { prefs: string } | undefined;
  try {
    const parsed = JSON.parse(row?.prefs || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function some(sql: string, userId: string): boolean {
  try {
    return Boolean(sqlite.prepare(sql).get(userId));
  } catch {
    return false;
  }
}

/// Every switch, the ones never set being off — except Mémoire (Jimmy,
/// 04/10/2026: « mets aussi Mémoire dans Capacités »), which is the
/// person's `memory_enabled`, on unless they turned it off: Twoody has
/// always remembered, and a capability must not take that away unasked.
export function localCapabilities(userId: string): Record<LocalCapability, boolean> {
  const switches = storedCapabilities(userId);
  const prefs = readPrefs(userId);
  return { ...switches, memory: prefs.memory_enabled !== false && prefs.memory_enabled !== "false" };
}

function storedCapabilities(userId: string): Record<LocalCapability, boolean> {
  const prefs = readPrefs(userId);
  let stored = prefs.local_capabilities as Record<string, unknown> | undefined;
  if (!stored || typeof stored !== "object") {
    stored = {
      documents: some("SELECT 1 FROM document_folders WHERE user_id = ? LIMIT 1", userId),
      contacts: some("SELECT 1 FROM contacts WHERE user_id = ? LIMIT 1", userId),
      calendar: some("SELECT 1 FROM events WHERE user_id = ? LIMIT 1", userId),
    };
    sqlite.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify({ ...prefs, local_capabilities: stored }), userId);
  }
  return Object.fromEntries(LOCAL_CAPABILITIES.map((id) => [id, stored![id] === true])) as Record<LocalCapability, boolean>;
}

export function capabilityOn(userId: string, id: LocalCapability): boolean {
  return localCapabilities(userId)[id];
}

export function setLocalCapability(userId: string, id: LocalCapability, enabled: boolean): Record<LocalCapability, boolean> {
  if (id === "memory") {
    const prefs = readPrefs(userId);
    sqlite.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify({ ...prefs, memory_enabled: enabled }), userId);
    return localCapabilities(userId);
  }
  const current = storedCapabilities(userId);
  const prefs = readPrefs(userId);
  sqlite.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify({ ...prefs, local_capabilities: { ...current, [id]: enabled } }), userId);
  return localCapabilities(userId);
}

// Where a capability that is on shows (Jimmy, 04/10/2026): in the app's menu
// — its own page in the sidebar, Maison to switch the lights — and in the
// chat — its icon under the message, to leave it out of one. Both on unless
// the person says otherwise. Kept in `users.prefs` as
// `capability_places: { home: { menu: false } }`.
export interface CapabilityPlace { menu: boolean; chat: boolean }

export function capabilityPlaces(userId: string): Record<LocalCapability, CapabilityPlace> {
  const stored = readPrefs(userId).capability_places as Record<string, Partial<CapabilityPlace>> | undefined;
  return Object.fromEntries(LOCAL_CAPABILITIES.map((id) => {
    const place = stored && typeof stored === "object" ? stored[id] : undefined;
    return [id, { menu: place?.menu !== false, chat: place?.chat !== false }];
  })) as Record<LocalCapability, CapabilityPlace>;
}

export function setCapabilityPlace(userId: string, id: LocalCapability, place: Partial<CapabilityPlace>): Record<LocalCapability, CapabilityPlace> {
  const current = capabilityPlaces(userId);
  const next = { ...current, [id]: { ...current[id], ...place } };
  const prefs = readPrefs(userId);
  sqlite.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify({ ...prefs, capability_places: next }), userId);
  return next;
}

/// The capabilities a message leaves out (`capabilities_off`, the chat's
/// icons): only known ids, the rest ignored.
export function capabilitiesOff(value: unknown): Set<LocalCapability> {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return new Set(list.map((item) => String(item).trim()).filter(isLocalCapability));
}

/// The order of the capabilities' pages in the app's menu, as the person
/// arranged them (Jimmy, 04/10/2026: « qu'on puisse réorganiser les
/// positions dans le menu »); null until they do — the app then lists them
/// alphabetically, in its language.
export function capabilityOrder(userId: string): LocalCapability[] | null {
  const stored = readPrefs(userId).capability_order;
  if (!Array.isArray(stored)) return null;
  const known = stored.filter(isLocalCapability);
  return known.length ? [...new Set(known)] : null;
}

export function setCapabilityOrder(userId: string, order: unknown): LocalCapability[] | null {
  const list = Array.isArray(order) ? [...new Set(order.filter(isLocalCapability))] : [];
  const prefs = readPrefs(userId);
  sqlite.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify({ ...prefs, capability_order: list.length ? list : null }), userId);
  return capabilityOrder(userId);
}

// How the person uses Twoody (Jimmy, 04/10/2026: « voulez-vous utiliser
// Twoody pour votre usage personnel, ou votre entreprise, organisation »),
// asked at the first launch and changed in Settings: « pro » is Twoody Pro
// — client files first, the hobby capabilities set aside, diagnostics asked
// rather than assumed. Null until answered (an installation from before the
// question counts as personal). Kept in `users.prefs` as `usage_profile`.
export const USAGE_KINDS = ["personal", "pro"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];
export const PROFESSIONS = ["lawyer", "health", "accounting", "notary", "consulting", "business", "other"] as const;
export type Profession = (typeof PROFESSIONS)[number];
export interface UsageProfile { kind: UsageKind | null; team: boolean; profession: Profession | null }

export function usageProfile(userId: string): UsageProfile {
  const stored = readPrefs(userId).usage_profile as Partial<UsageProfile> | undefined;
  const kind = stored && (USAGE_KINDS as readonly string[]).includes(String(stored.kind)) ? stored.kind as UsageKind : null;
  const profession = stored && (PROFESSIONS as readonly string[]).includes(String(stored.profession)) ? stored.profession as Profession : null;
  return { kind, team: stored?.team === true, profession };
}

export function setUsageProfile(userId: string, patch: { kind?: unknown; team?: unknown; profession?: unknown }): UsageProfile {
  const current = usageProfile(userId);
  const next: UsageProfile = {
    kind: (USAGE_KINDS as readonly string[]).includes(String(patch.kind)) ? patch.kind as UsageKind : current.kind,
    team: typeof patch.team === "boolean" ? patch.team : current.team,
    profession: patch.profession === null ? null : (PROFESSIONS as readonly string[]).includes(String(patch.profession)) ? patch.profession as Profession : current.profession,
  };
  const prefs = readPrefs(userId);
  sqlite.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify({ ...prefs, usage_profile: next }), userId);
  return next;
}
