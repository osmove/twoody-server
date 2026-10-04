import { sqlite } from "../db.js";
import { homeOn } from "../home/homeAssistant.js";
import { LOCAL_CAPABILITIES, localCapabilities, usageProfile } from "../localCapabilities.js";
import { runtimeAuthHeaders } from "../runtimeAuth.js";
import { CATALOG } from "../builtin/catalog.js";

// What this computer's server says of its installation for « Partager des
// diagnostics » (GET /diagnostics/installation): Twoody Desktop puts it in
// its daily `installation_active` event, with what it knows itself (system,
// class of computer, engine), and the account keeps the latest on its
// `installations` row (twoody-backend). Only ids from fixed lists, counts
// and families: never a name, a title, an address, a path, a provider's
// name or anything the person wrote.

/// Where the models a provider answers with run: the engine Twoody ships,
/// Apple's on-device model, a well-known runtime of this computer, another
/// address, another computer of the account, or a cloud service.
export const PROVIDER_FAMILIES = ["builtin", "apple", "ollama", "lmstudio", "mlx", "custom", "peer", "cloud"] as const;
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

export interface InstallationFacts {
  /// The capabilities switched on (src/localCapabilities.ts ids).
  capabilities_on: string[];
  /// The first launch's answer (`usage_profile`): null until answered.
  setup_kind: "personal" | "pro" | null;
  /// Twoody Pro alone or as a team; null otherwise.
  setup_team: "solo" | "team" | null;
  /// The model Twoody answers with by default: its catalog id, or the
  /// model's name without any folder (a file's stem), never a path.
  default_model: string | null;
  /// The families of the enabled providers, in PROVIDER_FAMILIES order.
  providers_used: ProviderFamily[];
  /// Devices paired with this computer (phones), as 0, 1 or 2 for « 2 or more ».
  phones_paired: 0 | 1 | 2;
}

const WELL_KNOWN_PORTS: Record<string, ProviderFamily> = { "11434": "ollama", "1234": "lmstudio", "8080": "mlx" };

/// A provider's family, from its kind and address — never from its name,
/// but for telling Apple's on-device model from the engine Twoody ships
/// (both are runtimes of the app, with a key: src/runtimeAuth.ts).
export function providerFamily(kind: string, baseUrl: string | null | undefined, name?: string | null): ProviderFamily {
  if (kind === "peer_openai") return "peer";
  if (kind !== "local_openai") return "cloud";
  let url: URL;
  try {
    url = new URL(String(baseUrl ?? ""));
  } catch {
    return "custom";
  }
  if (runtimeAuthHeaders(String(baseUrl)).Authorization) return /^apple/i.test(String(name ?? "").trim()) ? "apple" : "builtin";
  return WELL_KNOWN_PORTS[url.port] ?? "custom";
}

/// The models of Twoody's catalogue, by their id in lower case.
const CATALOG_IDS = new Map(CATALOG.map((model) => [model.id.toLowerCase(), model.id]));

/// A model as diagnostics name it: a model of Twoody's catalogue by its id,
/// any other as « custom ». Another model's name may be a file the person
/// named, and the privacy policy promises never a file name.
export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  const last = String(model).trim().split(/[\\/]/).pop() ?? "";
  return CATALOG_IDS.get(last.replace(/\.gguf$/i, "").toLowerCase()) ?? "custom";
}

export function installationFacts(userId: string): InstallationFacts {
  const switches: Record<string, boolean> = { ...localCapabilities(userId), home: homeOn(userId) };
  const usage = usageProfile(userId);
  const providers = sqlite
    .prepare("SELECT kind, name, base_url, model FROM llm_endpoints WHERE user_id = ? AND enabled = 1 ORDER BY is_default DESC, created_at ASC")
    .all(userId) as Array<{ kind: string; name: string | null; base_url: string | null; model: string | null }>;
  const families = new Set(providers.map((row) => providerFamily(row.kind, row.base_url, row.name)));
  // The phone that scanned this computer's code, or was let in through the
  // account: `pair:` sessions that are not this computer's own app.
  const paired = (sqlite
    .prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ? AND client_kind LIKE 'pair:%' AND COALESCE(origin, '') <> 'owner'")
    .get(userId) as { n: number }).n;
  return {
    capabilities_on: LOCAL_CAPABILITIES.filter((id) => switches[id] === true),
    setup_kind: usage.kind,
    setup_team: usage.kind === "pro" ? (usage.team ? "team" : "solo") : null,
    default_model: modelLabel(providers[0]?.model),
    providers_used: PROVIDER_FAMILIES.filter((family) => families.has(family)),
    phones_paired: paired >= 2 ? 2 : paired === 1 ? 1 : 0,
  };
}
