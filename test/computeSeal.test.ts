import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as lib from "../src/compute/computeSeal.js";

// This computer seals and opens exactly as twoody-desktop and twoody-app
// do: the same scenario, the same seeded randomness, the same bytes
// (test/fixtures/compute-v1-vectors.json comes from twoody-desktop).
const vectors = JSON.parse(readFileSync(new URL("./fixtures/compute-v1-vectors.json", import.meta.url), "utf8"));

function seeded(seed: number) {
  let n = seed;
  return (length: number) => Uint8Array.from({ length }, () => {
    n = (n * 1103515245 + 12345) % 2147483648;
    return n & 255;
  });
}

const NOW = 1790600000000;
const BODY = { model: "qwen3-14b", max_tokens: 256, messages: [
  { role: "system", content: "Tu es Twoody." },
  { role: "user", content: "Bonjour" },
  { role: "assistant", content: "Salut Claire" },
  { role: "user", content: "Et la suite ?" },
] };

test("produces exactly the desktop's vectors", () => {
  const random = seeded(11);
  const host = lib.createComputeIdentity(random);
  const guest = lib.createComputeIdentity(random);
  const { bundle, secret } = lib.createHostPrekey({ host, id: "spk-1", now: NOW, random });
  const { request } = lib.sealComputeRequest({ guest, host: lib.publicIdentity(host), prekey: bundle, grantId: "5", requestId: "r-1", now: NOW + 1000, body: BODY, random });
  const opened = lib.openComputeRequest({ host, prekeys: [secret], guest: lib.publicIdentity(guest), request, grantId: "5", now: NOW + 2000, markSeen: () => true });
  assert.deepEqual(opened.body, BODY);
  const answer = lib.startComputeResponse(opened.turn, random);
  const chunks = [answer.piece("Bon"), answer.piece("jour"), answer.finish("", { model: "qwen3-14b" })];
  assert.deepEqual(
    JSON.parse(JSON.stringify({
      host: lib.publicIdentity(host), guest: lib.publicIdentity(guest), prekey: bundle, request,
      response: { header: answer.header, chunks }, safety: lib.safetyNumber(lib.publicIdentity(host), lib.publicIdentity(guest)),
    })),
    vectors,
  );
});
