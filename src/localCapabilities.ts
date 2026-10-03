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

export const LOCAL_CAPABILITIES = ["documents", "contacts", "calendar", "web", "dictation", "agent", "home", "connectors"] as const;
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

/// Every switch, the ones never set being off.
export function localCapabilities(userId: string): Record<LocalCapability, boolean> {
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
  const current = localCapabilities(userId);
  const prefs = readPrefs(userId);
  sqlite.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify({ ...prefs, local_capabilities: { ...current, [id]: enabled } }), userId);
  return { ...current, [id]: enabled };
}
