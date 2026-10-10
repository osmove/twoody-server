import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { app, cleanUp, noAbsolutePath, otherHeaders, ownerHeaders, root, share, user } from "./helpers/shareFixtures.js";

// The owner's computer of a folder share (docs/sharing-contracts.md §3, lot
// L2): its routes, the order of its checks on every request, the audit, and
// the attack tests of docs/sharing-design.md §8 that fall to it — a forged
// share, a device the account adds, a right it inflates, another grantee, a
// share revoked or expired here while the account relays, every way out of
// the shared folder, the rate limits, the sync that can only restrict.

const { serveShareRequest } = await import("../src/shares/serve.js");
const { resetShareLimits, SHARE_SEARCHES_PER_MINUTE, SHARE_BROWSES_PER_MINUTE } = await import("../src/shares/policy.js");
const { insertShare } = await import("../src/shares/store.js");
const { createComputeIdentity, identityFingerprint, publicIdentity } = await import("../src/compute/computeSeal.js");
const { setLocalCapability } = await import("../src/localCapabilities.js");
const { sqlite } = await import("../src/db.js");

test.after(cleanUp);

/// A grantee's device: its public keys as a bridge task carries them.
function device() {
  const keys = publicIdentity(createComputeIdentity());
  return { guest: { enc_public: keys.encPublic, sign_public: keys.signPublic }, fingerprint: identityFingerprint(keys) };
}

async function approve(granteeUserId: string, fingerprint: string, decision = "approve") {
  const response = await app.inject({ method: "POST", url: `/local_shares/devices/${decision}`, headers: ownerHeaders, payload: { grantee_user_id: granteeUserId, fingerprint } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().device;
}

/// Serves one request as the Desktop's main process would (POST
/// /local_shares/serve), or in-process.
async function serve(payload: Record<string, unknown>) {
  const response = await app.inject({ method: "POST", url: "/local_shares/serve", headers: ownerHeaders, payload });
  assert.equal(response.statusCode, 200, response.body);
  const answer = response.json();
  assert.ok(noAbsolutePath(answer), `no absolute path: ${response.body}`);
  return answer;
}

/// A share to Claire (account user 42) of « Contrats », her device approved.
async function sharedWithClaire(right: "ask" | "read" = "read", extra: Record<string, unknown> = {}) {
  const made = await share({ folder_id: "f-contracts", kind: "person", grantee_user_id: 42, grantee_name: "Claire", right, ...extra });
  const claire = device();
  await serve({ share_uuid: made.id, grantee_user_id: "42", guest: claire.guest, op: { op: "check" } });
  await approve("42", claire.fingerprint);
  return { made, claire, ask: (op: unknown, granteeUserId = "42") => serve({ share_uuid: made.id, grantee_user_id: granteeUserId, guest: claire.guest, op }) };
}

const auditOf = (shareId: string) => sqlite.prepare("SELECT action, outcome, guest_user_id, guest_fingerprint, document_id, name FROM peer_document_audit WHERE share_id = ? ORDER BY id").all(shareId) as Array<{ action: string; outcome: string; guest_user_id: string; guest_fingerprint: string; document_id: string | null; name: string | null }>;

// ── routes ──────────────────────────────────────────────────────────────────

test("the routes are the owner's: a household member's phone is refused, and serving is this computer's app only", async () => {
  for (const [method, url] of [["GET", "/local_shares"], ["POST", "/local_shares"], ["GET", "/local_shares/audit"], ["POST", "/local_shares/sync"], ["POST", "/local_shares/devices/approve"]] as const) {
    const response = await app.inject({ method, url, headers: otherHeaders, payload: method === "POST" ? {} : undefined });
    assert.equal(response.statusCode, 403, `${method} ${url}`);
  }
  const serving = await app.inject({ method: "POST", url: "/local_shares/serve", headers: otherHeaders, payload: { share_uuid: randomUUID(), op: null } });
  assert.equal(serving.statusCode, 403);
  assert.equal(serving.json().error, "desktop_app_only");
  assert.equal((await app.inject({ method: "GET", url: "/local_shares" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/local_shares", headers: ownerHeaders })).statusCode, 200, "under /api/v1 too");
});

test("a share is made here, its uuid by this computer, its label the folder's name by default; never an isolated folder nor one folderRisk refuses", async () => {
  const made = await share({ folder_id: "f-contracts", kind: "person", grantee_user_id: "77", grantee_name: "Léa", right: "ask" });
  assert.match(made.id, /^[0-9a-f-]{36}$/);
  assert.equal(made.label, "Contrats");
  assert.equal(made.folder_name, "Contrats");
  assert.equal(made.status, "active");
  assert.equal(made.revision, 1);
  assert.equal(made.expires_at, null);
  assert.ok(noAbsolutePath(made));

  const refused = async (payload: Record<string, unknown>, error: string) => {
    const response = await app.inject({ method: "POST", url: "/local_shares", headers: ownerHeaders, payload });
    assert.equal(response.statusCode, 422, JSON.stringify(payload));
    assert.equal(response.json().error, error);
  };
  await refused({ folder_id: "nope", kind: "person", grantee_user_id: "77", right: "ask" }, "folder_unknown");
  await refused({ folder_id: "f-secret", kind: "person", grantee_user_id: "77", right: "ask" }, "folder_isolated");
  await refused({ folder_id: "f-risky", kind: "person", grantee_user_id: "77", right: "ask" }, "folder_refused");
  await refused({ folder_id: "f-contracts", kind: "person", right: "ask" }, "invalid_share");
  await refused({ folder_id: "f-contracts", kind: "organization", grantee_user_id: "77", organization_id: "5", right: "ask" }, "invalid_share");
  await refused({ folder_id: "f-contracts", kind: "person", grantee_user_id: "77", right: "raw" }, "invalid_share");
  await refused({ folder_id: "f-contracts", kind: "person", grantee_user_id: "77", right: "ask", expires_at: "2020-01-01T00:00:00Z" }, "invalid_expiry");

  const org = await share({ folder_id: "f-invoices", kind: "organization", organization_id: 5, organization_name: "Osmove", right: "read", label: "Factures Osmove", expires_at: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(org.organization_id, "5");
  assert.equal(org.grantee_user_id, null);
  assert.equal(org.label, "Factures Osmove");
});

test("the owner changes a share (a new revision), marks it published, stops it: the row is kept, revoked by the owner", async () => {
  const made = await share({ folder_id: "f-contracts", kind: "person", grantee_user_id: "78", right: "ask" });
  let response = await app.inject({ method: "PATCH", url: `/local_shares/${made.id}`, headers: ownerHeaders, payload: { right: "read", label: "Baux" } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().share.right, "read");
  assert.equal(response.json().share.revision, 2);
  response = await app.inject({ method: "PATCH", url: `/local_shares/${made.id}`, headers: ownerHeaders, payload: { published: true } });
  assert.ok(response.json().share.published_at);
  assert.equal(response.json().share.revision, 2, "telling the account is no change of the share");
  assert.equal((await app.inject({ method: "PATCH", url: `/local_shares/${made.id}`, headers: ownerHeaders, payload: { grantee_user_id: "99" } })).statusCode, 422, "never retargeted");

  response = await app.inject({ method: "DELETE", url: `/local_shares/${made.id}`, headers: ownerHeaders });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().share.status, "revoked");
  assert.equal(response.json().share.revoked_by, "owner");
  assert.equal((await app.inject({ method: "PATCH", url: `/local_shares/${made.id}`, headers: ownerHeaders, payload: { right: "ask" } })).statusCode, 409);
  const listed = (await app.inject({ method: "GET", url: "/local_shares", headers: ownerHeaders })).json();
  assert.equal(listed.shares.find((s: { id: string }) => s.id === made.id).status, "revoked", "kept");
  assert.equal((await app.inject({ method: "DELETE", url: `/local_shares/${randomUUID()}`, headers: ownerHeaders })).statusCode, 404);
});

// ── a request, checked in order ─────────────────────────────────────────────

test("a request from an approved device of the grantee is answered: folders and search, paths inside the shared folder only", async () => {
  const { made, ask } = await sharedWithClaire("ask");
  const folders = await ask({ op: "folders" });
  assert.deepEqual(folders, { ok: true, folder: { label: "Contrats", documents: 2 } }, "the shared folder and the one granted inside it, not the isolated one");

  const found = await ask({ op: "search", query: "loyer", limit: 8 });
  assert.equal(found.ok, true);
  const paths = new Set(found.passages.map((p: { path: string }) => p.path));
  assert.deepEqual([...paths].sort(), ["Clients/contrat-client-dupont.txt", "bail-appartement.txt"]);
  assert.ok(found.passages.every((p: { document_id: string }) => ["bail", "client"].includes(p.document_id)), "never Factures, never the isolated folder, never the refused one");
  assert.ok(found.passages.length <= 8);
  assert.ok(found.passages.reduce((sum: number, p: { text: string }) => sum + p.text.length, 0) <= 10_000);
  for (const passage of found.passages) assert.deepEqual(Object.keys(passage).sort(), ["document_id", "name", "page", "path", "score", "text"]);

  const audit = auditOf(made.id);
  assert.deepEqual(audit.slice(-2).map((row) => [row.action, row.outcome]), [["folders", "ok"], ["search", "ok"]]);
  assert.ok(audit.every((row) => row.document_id === null && row.name === null), "no document named in the audit");
  assert.ok(!JSON.stringify(sqlite.prepare("SELECT * FROM peer_document_audit").all()).includes("loyer"), "never the question");
});

test("attack 1: a forged share (unknown uuid) is refused and audited; a malformed request is a bad request", async () => {
  const claire = device();
  const forged = randomUUID();
  assert.deepEqual(await serve({ share_uuid: forged, grantee_user_id: "42", guest: claire.guest, op: { op: "search", query: "loyer" } }), { ok: false, error: "unknown_share" });
  assert.deepEqual(await serve({ share_uuid: forged, grantee_user_id: "42", guest: claire.guest, op: { op: "check" } }), { ok: false, error: "unknown_share" });
  assert.deepEqual(auditOf(forged).map((row) => row.outcome), ["unknown_share", "unknown_share"]);
  assert.deepEqual(await serve({ share_uuid: "../../etc", grantee_user_id: "42", guest: claire.guest, op: null }), { ok: false, error: "unknown_share" });
  assert.deepEqual(await serve({ share_uuid: forged, grantee_user_id: "42", guest: { enc_public: "zz", sign_public: "00" }, op: null }), { ok: false, error: "bad_request" });
  assert.deepEqual(await serve({}), { ok: false, error: "bad_request" });
  const devices = (await app.inject({ method: "GET", url: "/local_shares", headers: ownerHeaders })).json().devices;
  assert.ok(!devices.some((d: { fingerprint: string }) => d.fingerprint === claire.fingerprint), "no device recorded for a share that does not exist");
});

test("attack 2: a key the account adds to the grantee is pending, refused until the owner approves it; refused stays refused", async () => {
  const { made } = await sharedWithClaire("ask");
  const added = device();
  const asked = { share_uuid: made.id, grantee_user_id: "42", guest: added.guest, op: { op: "search", query: "loyer" } };
  assert.deepEqual(await serve(asked), { ok: false, error: "device_not_approved" });
  const devices = (await app.inject({ method: "GET", url: "/local_shares", headers: ownerHeaders })).json().devices;
  const pending = devices.find((d: { fingerprint: string }) => d.fingerprint === added.fingerprint);
  assert.equal(pending.state, "pending");
  assert.equal(pending.safety_number, null, "this computer's identity is not known in this process");
  assert.equal(pending.name_hint, null);
  assert.equal(pending.grantee_user_id, "42");
  assert.equal(auditOf(made.id).at(-1)!.outcome, "device_pending");

  await approve("42", added.fingerprint, "refuse");
  assert.deepEqual(await serve(asked), { ok: false, error: "device_not_approved" });
  assert.equal(auditOf(made.id).at(-1)!.outcome, "device_refused");
  const verified = await approve("42", added.fingerprint, "verify");
  assert.equal(verified.state, "approved");
  assert.ok(verified.verified_at);
  assert.equal((await serve(asked)).ok, true);
  assert.equal((await app.inject({ method: "POST", url: "/local_shares/devices/approve", headers: ownerHeaders, payload: { grantee_user_id: "42", fingerprint: "0000-0000-0000-0000-0000" } })).statusCode, 404);
});

test("attack 3: the account inflates « Poser des questions » to « Lire les fichiers »: browse and text refused by the right held here", async () => {
  const { made, ask } = await sharedWithClaire("ask");
  assert.deepEqual(await ask({ op: "browse", path: "" }), { ok: false, error: "right" });
  assert.deepEqual(await ask({ op: "text", document_id: "bail" }), { ok: false, error: "right" });
  assert.deepEqual(auditOf(made.id).slice(-2).map((row) => [row.action, row.outcome]), [["browse", "right"], ["text", "right"]]);
});

test("attack 4: another grantee named by the account — the share is not theirs, and an approved device is approved for one person only", async () => {
  const { made, claire } = await sharedWithClaire("ask");
  // Bob (43) has a device approved, for a share of his own.
  const bobShare = await share({ folder_id: "f-contracts", kind: "person", grantee_user_id: "43", right: "ask" });
  const bob = device();
  await serve({ share_uuid: bobShare.id, grantee_user_id: "43", guest: bob.guest, op: { op: "check" } });
  await approve("43", bob.fingerprint);

  // Claire's share asked as Bob, with Bob's approved device: not his.
  assert.deepEqual(await serve({ share_uuid: made.id, grantee_user_id: "43", guest: bob.guest, op: { op: "folders" } }), { ok: false, error: "unknown_share" });
  assert.equal(auditOf(made.id).at(-1)!.outcome, "wrong_grantee");
  // Claire's share asked as Claire with Bob's device: not approved for her.
  assert.deepEqual(await serve({ share_uuid: made.id, grantee_user_id: "42", guest: bob.guest, op: { op: "folders" } }), { ok: false, error: "device_not_approved" });

  // An organization share: whoever the account names, through a device the
  // owner approved for that very person.
  const org = await share({ folder_id: "f-contracts", kind: "organization", organization_id: "5", right: "ask" });
  assert.equal((await serve({ share_uuid: org.id, grantee_user_id: "42", guest: claire.guest, op: { op: "folders" } })).ok, true);
  assert.deepEqual(await serve({ share_uuid: org.id, grantee_user_id: "44", guest: claire.guest, op: { op: "folders" } }), { ok: false, error: "device_not_approved" });
  const devices = (await app.inject({ method: "GET", url: "/local_shares", headers: ownerHeaders })).json().devices;
  assert.ok(!devices.some((d: { grantee_user_id: string; fingerprint: string }) => d.grantee_user_id === "43" && d.fingerprint === claire.fingerprint), "nothing recorded for a person the share is not to");
});

test("attack 6: revoked or expired here while the account still relays — refused by this computer's clock", async () => {
  const { made, ask } = await sharedWithClaire("ask");
  await app.inject({ method: "DELETE", url: `/local_shares/${made.id}`, headers: ownerHeaders });
  assert.deepEqual(await ask({ op: "search", query: "loyer" }), { ok: false, error: "revoked" });

  const soon = await sharedWithClaire("ask", { expires_at: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await soon.ask({ op: "folders" })).ok, true);
  const later = Date.now() + 120_000;
  const claire = soon.claire;
  assert.deepEqual(await serveShareRequest(user.id, { share_uuid: soon.made.id, grantee_user_id: "42", guest: claire.guest, op: { op: "folders" } }, later), { ok: false, error: "expired" });
  assert.deepEqual(await serveShareRequest(user.id, { share_uuid: soon.made.id, grantee_user_id: "42", guest: claire.guest, op: null }, later), { ok: false, error: "expired" });
  const listed = (await app.inject({ method: "GET", url: "/local_shares", headers: ownerHeaders })).json().shares;
  assert.equal(listed.find((s: { id: string }) => s.id === made.id).status, "revoked");
});

test("implicit stops: Documents off, the folder removed, made isolated, or refused by folderRisk", async () => {
  const { made, ask } = await sharedWithClaire("ask");
  setLocalCapability(user.id, "documents", false);
  try {
    assert.deepEqual(await ask({ op: "folders" }), { ok: false, error: "documents_off" });
    const listed = (await app.inject({ method: "GET", url: "/local_shares", headers: ownerHeaders })).json().shares;
    assert.equal(listed.find((s: { id: string }) => s.id === made.id).stopped_reason, "documents_off");
  } finally {
    setLocalCapability(user.id, "documents", true);
  }
  // A folder folderRisk refuses now, though granted before: never served.
  const risky = insertShare(user.id, { folderId: "f-risky", kind: "person", granteeUserId: "42", granteeName: null, organizationId: null, organizationName: null, label: "Système", right: "read", expiresAt: null });
  assert.deepEqual(await serve({ share_uuid: risky.id, grantee_user_id: "42", guest: (await sharedWithClaire()).claire.guest, op: { op: "folders" } }), { ok: false, error: "folder_gone" });
  assert.equal(auditOf(risky.id).at(-1)!.outcome, "folder_refused");
  // A folder inside an isolated project's: never, whatever was stored.
  const isolated = insertShare(user.id, { folderId: "f-secret", kind: "person", granteeUserId: "42", granteeName: null, organizationId: null, organizationName: null, label: "Secret", right: "read", expiresAt: null });
  const { claire } = await sharedWithClaire();
  assert.deepEqual(await serve({ share_uuid: isolated.id, grantee_user_id: "42", guest: claire.guest, op: { op: "folders" } }), { ok: false, error: "folder_gone" });
  assert.equal(auditOf(isolated.id).at(-1)!.outcome, "folder_isolated");
  // A folder no longer in Documents.
  const gone = insertShare(user.id, { folderId: "f-removed", kind: "person", granteeUserId: "42", granteeName: null, organizationId: null, organizationName: null, label: "Parti", right: "read", expiresAt: null });
  assert.deepEqual(await serve({ share_uuid: gone.id, grantee_user_id: "42", guest: claire.guest, op: { op: "folders" } }), { ok: false, error: "folder_gone" });
});

test("attack 8: nothing outside the shared folder — another folder's document, the isolated one inside, .., an absolute path, a link, a hidden or skipped folder", async () => {
  const { ask } = await sharedWithClaire("read");
  // text: only a document of the shared folder (or one granted inside it).
  const bail = await ask({ op: "text", document_id: "bail" });
  assert.equal(bail.ok, true);
  assert.equal(bail.document.path, "bail-appartement.txt");
  assert.match(bail.document.text, /900 euros[\s\S]*premier du mois/);
  assert.equal(bail.document.truncated, false);
  assert.equal((await ask({ op: "text", document_id: "client" })).document.path, "Clients/contrat-client-dupont.txt");
  for (const id of ["facture", "isole", "risky", "nope"]) assert.deepEqual(await ask({ op: "text", document_id: id }), { ok: false, error: "bad_request" }, id);
  assert.deepEqual(await ask({ op: "text", document_id: "../bail" }), { ok: false, error: "bad_request" });

  // browse: the shared folder as the file system has it, nothing else.
  const top = await ask({ op: "browse", path: "" });
  assert.equal(top.ok, true);
  assert.deepEqual(top.entries.map((e: { name: string; kind: string }) => `${e.kind}:${e.name}`).sort(), ["file:bail-appartement.txt", "folder:Clients"]);
  const bailEntry = top.entries.find((e: { name: string }) => e.name === "bail-appartement.txt");
  assert.equal(bailEntry.document_id, "bail");
  assert.equal(typeof bailEntry.size, "number");
  assert.equal(top.next_offset, null);
  const inside = await ask({ op: "browse", path: "Clients" });
  assert.deepEqual(inside.entries.map((e: { path: string; document_id: string | null }) => [e.path, e.document_id]), [["Clients/contrat-client-dupont.txt", "client"]]);
  for (const path of ["Secret", "Secret/dossier-isole.txt", "..", "../Factures", "Clients/../..", root, "/etc", "Lien", ".cache", "Library", "C:\\Windows"]) {
    assert.deepEqual(await ask({ op: "browse", path }), { ok: false, error: "bad_request" }, path);
  }
  // The body itself: only the contract's fields.
  assert.deepEqual(await ask({ op: "browse", path: "", root: "f-invoices" }), { ok: false, error: "bad_request" });
  assert.deepEqual(await ask({ op: "search", query: "loyer", folder_ids: ["f-invoices"] }), { ok: false, error: "bad_request" });
  assert.deepEqual(await ask({ op: "raw", document_id: "bail" }), { ok: false, error: "bad_request" }, "no originals in v1");
  assert.deepEqual(await ask({ op: "search", query: "x".repeat(2_001) }), { ok: false, error: "bad_request" });
  assert.deepEqual(await ask({ op: "search", query: "loyer", limit: 9 }), { ok: false, error: "bad_request" });
});

test("attack 12: 30 searches and 120 browses a minute per share and device, then rate_limited", async () => {
  resetShareLimits();
  const { made, ask, claire } = await sharedWithClaire("read");
  for (let i = 0; i < SHARE_SEARCHES_PER_MINUTE; i++) assert.equal((await ask({ op: "search", query: "loyer" })).ok, true, `search ${i}`);
  assert.deepEqual(await ask({ op: "search", query: "loyer" }), { ok: false, error: "rate_limited" });
  assert.equal(auditOf(made.id).at(-1)!.outcome, "rate_limited");
  // Browsing has its own budget.
  for (let i = 0; i < SHARE_BROWSES_PER_MINUTE; i++) assert.equal((await ask({ op: "browse", path: "" })).ok, true, `browse ${i}`);
  assert.deepEqual(await ask({ op: "browse", path: "" }), { ok: false, error: "rate_limited" });
  // Another share of the same device has its own.
  const other = await share({ folder_id: "f-contracts", kind: "person", grantee_user_id: "42", right: "ask" });
  assert.equal((await serve({ share_uuid: other.id, grantee_user_id: "42", guest: claire.guest, op: { op: "search", query: "loyer" } })).ok, true);
  resetShareLimits();
  // A request too big is refused before it reaches the handler.
  const huge = await app.inject({ method: "POST", url: "/local_shares/serve", headers: ownerHeaders, payload: { share_uuid: made.id, grantee_user_id: "42", guest: claire.guest, op: { op: "search", query: "x".repeat(70_000) } } });
  assert.equal(huge.statusCode, 413);
});

// ── sync with the account ───────────────────────────────────────────────────

test("sync: revoked there is revoked here, absent there is published again, unknown here is ignored — and nothing there extends a share", async () => {
  const kept = await share({ folder_id: "f-contracts", kind: "person", grantee_user_id: "50", right: "ask", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  const dropped = await share({ folder_id: "f-contracts", kind: "person", grantee_user_id: "51", right: "ask" });
  const missing = await share({ folder_id: "f-contracts", kind: "person", grantee_user_id: "52", right: "ask" });
  const ownRevoked = await share({ folder_id: "f-contracts", kind: "person", grantee_user_id: "53", right: "ask" });
  await app.inject({ method: "DELETE", url: `/local_shares/${ownRevoked.id}`, headers: ownerHeaders });
  const everything = (await app.inject({ method: "GET", url: "/local_shares", headers: ownerHeaders })).json().shares as Array<{ id: string }>;
  const others = everything.filter((s) => ![kept.id, dropped.id, missing.id, ownRevoked.id].includes(s.id)).map((s) => ({ uuid: s.id, status: "active" }));
  const stranger = randomUUID();
  const account = [
    ...others,
    // The account widens and extends this one, and adds a grantee: ignored.
    { uuid: kept.id, status: "active", right: "read", expires_at: null, grantee: { id: 99 }, revision: 9 },
    { uuid: dropped.id, status: "revoked", revoked_reason: "organization" },
    // The owner's revoked share listed active again: never brought back.
    { uuid: ownRevoked.id, status: "active" },
    // A share this computer never made.
    { uuid: stranger, status: "active", right: "read" },
  ];
  const response = await app.inject({ method: "POST", url: "/local_shares/sync", headers: ownerHeaders, payload: { account } });
  assert.equal(response.statusCode, 200, response.body);
  const { republish, revoked } = response.json();
  assert.deepEqual(revoked, [dropped.id]);
  assert.deepEqual(republish.map((s: { id: string }) => s.id), [missing.id]);
  const after = (await app.inject({ method: "GET", url: "/local_shares", headers: ownerHeaders })).json().shares as Array<{ id: string; status: string; right: string; expires_at: string | null; revoked_by: string | null; grantee_user_id: string | null }>;
  const byId = new Map(after.map((s) => [s.id, s]));
  assert.equal(byId.get(dropped.id)!.revoked_by, "organization");
  assert.equal(byId.get(kept.id)!.right, "ask");
  assert.equal(byId.get(kept.id)!.expires_at, kept.expires_at);
  assert.equal(byId.get(kept.id)!.grantee_user_id, "50");
  assert.equal(byId.get(ownRevoked.id)!.status, "revoked");
  assert.ok(!byId.has(stranger), "nothing created from the account's word");
  assert.equal(after.length, everything.length);
  assert.equal((await app.inject({ method: "POST", url: "/local_shares/sync", headers: ownerHeaders, payload: { account: [{ uuid: "not-a-uuid" }] } })).statusCode, 422);
});

test("the audit says who asked what and how it went, newest first, by share — never the question", async () => {
  const { made, ask } = await sharedWithClaire("ask");
  await ask({ op: "search", query: "préavis du bail" });
  await ask({ op: "browse", path: "" });
  const response = await app.inject({ method: "GET", url: `/local_shares/audit?share_id=${made.id}`, headers: ownerHeaders });
  assert.equal(response.statusCode, 200);
  const entries = response.json().audit as Array<{ op: string; outcome: string; share_id: string; guest_user_id: string; guest_fingerprint: string; at: string }>;
  assert.deepEqual(entries.slice(0, 2).map((e) => [e.op, e.outcome]), [["browse", "right"], ["search", "ok"]]);
  assert.ok(Array.isArray(entries));
  assert.ok(entries.every((e) => e.share_id === made.id && e.guest_user_id === "42" && /^[0-9a-f-]{24}$/.test(e.guest_fingerprint) && !Number.isNaN(Date.parse(e.at))));
  assert.ok(!response.body.includes("préavis"));
  assert.equal((await app.inject({ method: "GET", url: "/local_shares/audit?share_id=../x", headers: ownerHeaders })).statusCode, 422);
});
