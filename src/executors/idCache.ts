// Opaque document_id ↔ absolute path map.
//
// Bridge contract (see twoody-mac/shared/bridge-v1.schema.json) returns
// opaque ids from `search` and consumes them in `read` / `list_dir` /
// `open_document`. Real filesystem paths never appear in the wire
// payload, so a compromised LLM transcript can't leak `/home/pi/.ssh`.
//
// Bounded LRU: 5_000 entries is enough to cover a typical chat session
// without growing unbounded if the LLM keeps issuing fresh searches.

import { randomUUID } from "node:crypto";
import { isUnderGrant } from "./folders.js";

const MAX_ENTRIES = 5_000;
const cache = new Map<string, string>();

export function rememberPath(absolute: string): string {
  for (const [id, path] of cache) {
    if (path === absolute) {
      cache.delete(id);
      cache.set(id, absolute);
      return id;
    }
  }
  const id = "doc_" + randomUUID().replace(/-/g, "").slice(0, 24);
  cache.set(id, absolute);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return id;
}

export function lookupPath(documentId: string): string | null {
  const path = cache.get(documentId);
  if (!path) return null;
  if (!isUnderGrant(path)) {
    cache.delete(documentId);
    return null;
  }
  cache.delete(documentId);
  cache.set(documentId, path);
  return path;
}
