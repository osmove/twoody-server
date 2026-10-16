// What Twoody keeps for the accounts Osmove chooses (16/10/2026, Jimmy: at the
// public launch, E-mails and Google Analytics / Search Console are not
// offered to everyone — a v2; the code stays):
//   « email »       — Capacités › E-mails (src/email/): IMAP, Gmail,
//                     Outlook.com / Microsoft 365, drafts;
//   « google_data » — Connecteurs › Google (src/google/data*.ts): Google
//                     Analytics and Search Console in the chat.
//
// The account says who may (twoody-backend ReservedFeatures: /me
// `email_capability`, `google_data`, ticked per person in /admin). Inside
// Twoody Desktop the Desktop reads it and tells this server — first in
// TWOODY_RESERVED_FEATURES at start (what it last knew), then by message
// ({type: "reserved-features", email, google_data, final}) whenever it
// changes; its word replaces what was known. On its own (a Pi, `twoody
// serve`, the tests, the bench) only TWOODY_RESERVED_FEATURES says: a comma
// list of « email », « google_data », or « all ». Unset: nothing reserved
// is offered — a computer without an account, too.
//
// Not offered: the capability reads as off everywhere (localCapabilities.ts,
// so the tools, the sync, the routes and « Outils » follow), the Google link
// reads as off (google/dataLink.ts) and is not listed among the connectors;
// switching either on is refused (`reserved_feature`). What the person
// switched on is kept as it was until the Desktop's word is final (the
// account answered, or there is no account): then it is switched off, the
// data kept, and said once (reservedWithdrawal.ts).

export const RESERVED_FEATURES = ["email", "google_data"] as const;
export type ReservedFeature = (typeof RESERVED_FEATURES)[number];
export type ReservedWord = Record<ReservedFeature, boolean>;

export function reservedFeaturesFrom(value: string | undefined | null): ReservedWord {
  const words = new Set(String(value ?? "").split(",").map((word) => word.trim().toLowerCase()).filter(Boolean));
  const all = words.has("all");
  return Object.fromEntries(RESERVED_FEATURES.map((feature) => [feature, all || words.has(feature)])) as ReservedWord;
}

/// The Desktop's word once it gave one; until then, the environment's
/// (read each time: a test sets it after the imports).
let fromDesktop: ReservedWord | null = null;

function current(): ReservedWord {
  return fromDesktop ?? reservedFeaturesFrom(process.env.TWOODY_RESERVED_FEATURES);
}

export function reservedFeatureOffered(feature: ReservedFeature): boolean {
  return current()[feature] === true;
}

export function reservedFeatures(): ReservedWord {
  return { ...current() };
}

/// The Desktop's word, checked: only booleans count, anything else is
/// « not offered » (a message is data from another process).
export function reservedWordFrom(data: unknown): ReservedWord & { final: boolean } {
  const given = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const word = Object.fromEntries(RESERVED_FEATURES.map((feature) => [feature, given[feature] === true])) as ReservedWord;
  return { ...word, final: given.final === true };
}

export function setReservedFeatures(word: ReservedWord): void {
  fromDesktop = Object.fromEntries(RESERVED_FEATURES.map((feature) => [feature, word[feature] === true])) as ReservedWord;
}

/// For tests: back to what the environment says.
export function resetReservedFeatures(): void {
  fromDesktop = null;
}
