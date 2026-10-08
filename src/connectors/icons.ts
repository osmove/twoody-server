import { connectorOriginFetch } from "../outbound.js";

// A connector's icon (« Outils » and Connecteurs, Jimmy, 08/10/2026): the
// service's own little picture beside its name, on the Mac and the iPhone,
// instead of the same plug for all. Asked of the connector's own origin
// only — the address the person gave, which this computer already calls
// (outbound.ts connectorOriginFetch): its /favicon.ico, /favicon.png,
// /apple-touch-icon.png and the icons its home page declares there, never
// a picture on another host, never with the connector's token. The best
// one is kept as a data URI (PNG, ICO, or an SVG that is only a drawing),
// 64 KB at most, in connectors.json; none otherwise, and the app shows its
// plug. A command connector has none.

export const ICON_MAX_BYTES = 64 * 1024;
const PAGE_MAX_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
/// Declared icons tried, at most, besides the three usual addresses.
const DECLARED_MAX = 4;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Found {
  type: "png" | "ico" | "svg";
  bytes: Buffer;
  /// The larger, the sharper on a phone's screen.
  size: number;
}

/// At most `max` bytes of a body; null when it is longer.
async function readCapped(response: Response, max: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function get(fetcher: Fetcher, url: string, accept: string, max: number): Promise<{ type: string; bytes: Buffer } | null> {
  try {
    const response = await fetcher(url, { method: "GET", headers: { accept }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readCapped(response, max);
    return bytes && bytes.length ? { type: (response.headers.get("content-type") ?? "").toLowerCase(), bytes } : null;
  } catch {
    return null;
  }
}

/// An SVG drawn as a picture and nothing else: no script, no event
/// handler, no embedded page, no reference to anything outside it. A
/// browser's <img> would not run them anyway; a phone's SVG renderer is not
/// held to that, so they are refused here.
export function safeSvg(text: string): boolean {
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text)) return false;
  if (/<!ENTITY|<script|<foreignObject|<iframe|<object|<embed|<use[\s>]|<image[\s>]|<style|javascript:|\son[a-z]+\s*=/i.test(text)) return false;
  // Every link points inside the drawing (#id) or nowhere.
  for (const match of text.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    if (!match[1]!.startsWith("#")) return false;
  }
  return !/url\(\s*["']?(?!#)/i.test(text);
}

/// What the bytes are, whatever the server called them.
export function iconOf(bytes: Buffer, contentType: string): Found | null {
  if (bytes.length > ICON_MAX_BYTES || bytes.length < 8) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    // IHDR: the width, then the height.
    const width = bytes.length >= 24 ? bytes.readUInt32BE(16) : 0;
    const height = bytes.length >= 24 ? bytes.readUInt32BE(20) : 0;
    return { type: "png", bytes, size: Math.min(width, height) };
  }
  if (bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1 && bytes.readUInt16LE(4) > 0 && bytes.length >= 6 + 16 * bytes.readUInt16LE(4)) {
    // ICONDIR: each entry's width, 0 meaning 256.
    let size = 0;
    for (let i = 0; i < bytes.readUInt16LE(4); i += 1) size = Math.max(size, bytes[6 + 16 * i] || 256);
    return { type: "ico", bytes, size };
  }
  if (contentType.includes("image/svg+xml") && safeSvg(bytes.toString("utf8"))) return { type: "svg", bytes, size: 128 };
  return null;
}

const MIME = { png: "image/png", ico: "image/x-icon", svg: "image/svg+xml" } as const;

export function iconDataUri(found: Found): string {
  return `data:${MIME[found.type]};base64,${found.bytes.toString("base64")}`;
}

/// The icons a home page declares, on its own origin only, the largest first.
export function declaredIcons(html: string, origin: string): string[] {
  const head = html.slice(0, PAGE_MAX_BYTES);
  const found: Array<{ url: string; size: number }> = [];
  for (const tag of head.matchAll(/<link\b[^>]*>/gi)) {
    const attribute = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag[0]);
    const value = (name: string) => {
      const match = attribute(name);
      return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : "";
    };
    const rel = value("rel").toLowerCase().split(/\s+/);
    if (!rel.includes("icon") && !rel.includes("apple-touch-icon") && !rel.includes("apple-touch-icon-precomposed")) continue;
    const href = value("href");
    if (!href || /^data:/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href.replace(/&amp;/g, "&"), `${origin}/`);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const size = Math.max(0, ...value("sizes").split(/\s+/).map((one) => Number(one.split("x")[0]) || 0));
    found.push({ url: url.href, size: rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed") ? Math.max(size, 180) : size });
  }
  return [...new Map(found.sort((a, b) => b.size - a.size).map((entry) => [entry.url, entry])).keys()];
}

/// Which of two is better: a sharp PNG first, then a drawing, then the
/// largest of what is left.
function score(found: Found): number {
  if (found.type === "png") return found.size >= 64 ? 1_000 + Math.min(found.size, 512) : 300 + found.size;
  if (found.type === "svg") return 900;
  return 200 + Math.min(found.size, 256);
}

/// The best icon of a connector at `url` — its origin only — as a data
/// URI, or null. `fetcher` is the door (tests: the same door, to a site on
/// this machine).
export async function fetchConnectorIcon(url: string, fetcher?: Fetcher): Promise<string | null> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  if (origin === "null") return null;
  const door = fetcher ?? connectorOriginFetch(origin);
  const page = await get(door, `${origin}/`, "text/html", PAGE_MAX_BYTES);
  const declared = page && page.type.includes("html") ? declaredIcons(page.bytes.toString("utf8"), origin).slice(0, DECLARED_MAX) : [];
  const usual = ["/apple-touch-icon.png", "/favicon.png", "/favicon.ico"].map((path) => `${origin}${path}`);
  const candidates = [...new Set([...declared, ...usual])];
  let best: Found | null = null;
  for (const candidate of candidates) {
    const fetched = await get(door, candidate, "image/png,image/x-icon,image/svg+xml,image/*;q=0.8", ICON_MAX_BYTES);
    const found = fetched ? iconOf(fetched.bytes, fetched.type) : null;
    if (found && (!best || score(found) > score(best))) best = found;
    // Sharp enough: the rest is not asked for.
    if (best && score(best) >= 1_064) break;
  }
  return best ? iconDataUri(best) : null;
}
