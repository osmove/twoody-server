// Keys for the local runtimes that ask for one.
//
// A runtime on loopback is reachable by anything running on the computer,
// including a web page in a browser (a form post needs no CORS approval,
// and DNS rebinding gets around the same-origin policy). The runtime the
// desktop app ships is therefore started with an API key, generated at
// each launch. The app hands the key to this process — environment for the
// embedded server, a message for the bridge worker — and it is attached to
// the calls made to that runtime, and to nothing else.
//
// Never stored, and never sent off this computer: a key is only accepted
// for, and only attached to, a loopback address.

const keys = new Map<string, string>();
/// The keys of the runtimes this process starts itself (the built-in
/// engine, src/engine.ts): never replaced by what the Desktop hands over.
const own = new Map<string, string>();

function normalize(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function isLoopback(baseUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(baseUrl);
    return protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

/// Replaces the known keys. Entries that are not loopback addresses, or
/// not strings, are dropped.
export function configureRuntimeKeys(entries: unknown): void {
  keys.clear();
  if (!entries || typeof entries !== "object") return;
  for (const [baseUrl, key] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof key === "string" && key && isLoopback(baseUrl)) keys.set(normalize(baseUrl), key);
  }
}

/// Adds the key of a runtime this process started, beside the ones it was
/// handed (configureRuntimeKeys does not wipe it). Loopback only.
export function addRuntimeKey(baseUrl: string, key: string): boolean {
  if (typeof key !== "string" || !key || !isLoopback(baseUrl)) return false;
  own.set(normalize(baseUrl), key);
  return true;
}

/// Headers to add to a call to `baseUrl` (or to a path under it).
export function runtimeAuthHeaders(baseUrl: string): Record<string, string> {
  const base = normalize(baseUrl);
  const key = own.get(base) ?? keys.get(base);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// TWOODY_RUNTIME_KEYS: {"http://127.0.0.1:47831/v1": "<key>"}
try {
  if (process.env.TWOODY_RUNTIME_KEYS) configureRuntimeKeys(JSON.parse(process.env.TWOODY_RUNTIME_KEYS));
} catch {
  // a malformed value means no key, and the runtime will answer 401
}
