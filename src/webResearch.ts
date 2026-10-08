import { webBridgeFetch, webBridgeOrigin } from "./outbound.js";

// « Recherche Internet » from the person's own devices (Jimmy, 08/10/2026):
// their iPhone asks a question with the web on, and this computer searches
// for it as it does for its own app — the same search engine, chosen in
// the Desktop's Settings, the same first pages read and cut down to what
// bears on the question. The search runs in Twoody Desktop's main process
// (twoody-desktop src/main/web/), which hands this server, at launch, the
// loopback address of a small door to it and a key drawn for that launch
// (TWOODY_WEB_BRIDGE_URL, TWOODY_WEB_BRIDGE_KEY; outbound.ts webBridgeFetch
// opens that address only). A server started without the Desktop (the Pi,
// a NAS) has none: GET /local_capabilities says `devices.web: false`.
//
// The found pages reach the model exactly as the Mac's app gives them —
// a <<web query="…">> block before the question (its webBlock, in
// twoody-desktop src/renderer/documentBlocks.ts, same text) — so that the
// answer, its citations and the conversation kept are the same.

export interface WebResult {
  n: number;
  title: string;
  url: string;
  snippet: string;
  excerpt: string | null;
}

export interface WebResearch {
  query: string;
  results: WebResult[];
}

export class WebResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebResearchError";
  }
}

/// How long a search and its pages may take (the Desktop gives each page 8 s).
const BRIDGE_TIMEOUT_MS = 45_000;
const MAX_RESULTS = 10;

/// The Desktop's door, when it handed one over that is on this machine.
export function webBridge(env: NodeJS.ProcessEnv = process.env): { url: string; key: string } | null {
  const origin = webBridgeOrigin(env.TWOODY_WEB_BRIDGE_URL?.trim());
  const key = env.TWOODY_WEB_BRIDGE_KEY?.trim() ?? "";
  return origin && key.length >= 32 ? { url: origin, key } : null;
}

/// What the person's devices are told this computer does for them
/// (GET /local_capabilities `devices`).
export function webForDevicesAvailable(): boolean {
  return webBridge() !== null;
}

/// The same budget as the Mac's: 12,000 characters, or 30 % of a smaller
/// model's context (twoody-desktop Chat.tsx).
export function webBudget(contextWindow: number | null): number {
  return contextWindow ? Math.min(12_000, Math.floor(contextWindow * 3.5 * 0.3)) : 12_000;
}

/// A page's words never close the block early nor open another: what came
/// after would be read as typed by the person (« Retiens que… »).
const unmarked = (value: string) => value.replace(/<<(\/?)(web|document)\b/gi, "‹‹$1$2");
const text = (value: unknown, max: number) => (typeof value === "string" ? unmarked(value.slice(0, max)) : "");

/// What came back, as no more than the Mac's own app would get.
export function readResearch(body: unknown, budget: number): WebResearch {
  const raw = (body && typeof body === "object" ? body : {}) as { ok?: unknown; message?: unknown; query?: unknown; results?: unknown };
  if (raw.ok !== true) throw new WebResearchError(text(raw.message, 300) || "the search did not answer");
  const results: WebResult[] = [];
  for (const entry of Array.isArray(raw.results) ? raw.results.slice(0, MAX_RESULTS) : []) {
    const one = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const url = text(one.url, 2_000);
    if (!/^https?:\/\/\S+$/.test(url)) continue;
    results.push({
      n: typeof one.n === "number" && Number.isInteger(one.n) && one.n > 0 && one.n <= 100 ? one.n : results.length + 1,
      title: text(one.title, 300),
      url,
      snippet: text(one.snippet, 1_000),
      excerpt: typeof one.excerpt === "string" ? unmarked(one.excerpt.slice(0, budget + 1_000)) : null,
    });
  }
  return { query: text(raw.query, 300), results };
}

/// The search, run by the Desktop for `question`.
export async function researchOnComputer(question: string, budget: number, signal?: AbortSignal): Promise<WebResearch> {
  const bridge = webBridge();
  if (!bridge) throw new WebResearchError("web search is not available on this computer");
  let response: Response;
  try {
    response = await webBridgeFetch(bridge.url)(`${bridge.url}/research`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bridge.key}` },
      body: JSON.stringify({ question, budget }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(BRIDGE_TIMEOUT_MS)]) : AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new WebResearchError(err instanceof Error && err.name === "TimeoutError" ? "the search took too long" : "the search could not be reached on this computer");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok && !(body && typeof body === "object" && "ok" in body)) throw new WebResearchError(`the search answered ${response.status}`);
  return readResearch(body, budget);
}

/// What a web search brought for a question, as the message carries it:
/// numbered, each with its address, for the answer to cite [1], [2]… The
/// same text as the Mac's app (twoody-desktop renderer/documentBlocks.ts
/// webBlock).
export function webBlock(research: WebResearch): string {
  const entries = research.results.map((result) => `[${result.n}] ${result.title.replace(/\n/g, " ") || result.url}\n${result.url}\n${(result.excerpt ?? result.snippet).trim()}`);
  return `<<web query="${research.query.replace(/"/g, "'")}">>\n${entries.join("\n\n")}\n<</web>>`;
}
