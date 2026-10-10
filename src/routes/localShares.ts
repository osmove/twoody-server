import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { dirname, join } from "node:path";
import { requireAuth } from "../auth.js";
import { safetyNumber } from "../compute/computeSeal.js";
import { DATA_DIR } from "../db.js";
import { shareHostIdentity, type HostIdentity } from "../shares/hostIdentity.js";
import { folderName, listFolders } from "../documents/library.js";
import { capabilityOn } from "../localCapabilities.js";
import { meshRequester } from "../sessionTrust.js";
import { folderUnshareable } from "../shares/policy.js";
import { serveShareRequest } from "../shares/serve.js";
import {
  accountId,
  cleanText,
  decideGuestDevice,
  FINGERPRINT,
  guestDevices,
  insertShare,
  LABEL_MAX,
  readAccountShares,
  revokeShare,
  SHARE_UUID,
  shareAudit,
  shareById,
  sharesOf,
  syncShares,
  updateShare,
  type GuestDeviceRow,
  type ShareKind,
  type ShareRight,
  type ShareRow,
} from "../shares/store.js";
import { meshRoster } from "../vault/roster.js";
import { isThisComputersApp } from "./usage.js";

// The folders this computer shares (docs/sharing-contracts.md §3):
//
//   GET    /local_shares                      {shares: [Local], devices: [Device]}
//   POST   /local_shares                      {folder_id, kind, grantee_user_id?, grantee_name?, organization_id?,
//                                              organization_name?, label?, right, expires_at?} → 201 {share: Local}
//   PATCH  /local_shares/:id                  {right?, expires_at?, label?, published?: true} → {share: Local}
//   DELETE /local_shares/:id                  revoked here, the row kept (revoked_by « owner ») → {share: Local}
//   POST   /local_shares/sync                 {account: [Given]} → {republish: [Local], revoked: [id]}
//   POST   /local_shares/devices/approve      {grantee_user_id, fingerprint} → {device: Device}
//   POST   /local_shares/devices/refuse       the same
//   POST   /local_shares/devices/verify       the same (safety numbers compared: approved too)
//   GET    /local_shares/audit?share_id=&before=&limit=   {audit: [{id, at, share_id, guest_user_id, guest_fingerprint, op, outcome}]}
//   POST   /local_shares/serve                {share_uuid, grantee_user_id, guest: {enc_public, sign_public}, op}
//                                              → the answer of §2; `op` {op: "check"}: the check made before opening
//
// For the owner only: this computer's app, or one of the person's own
// devices (sessionTrust.ts meshRequester) — never a household member's
// phone, a device paired by code, or another computer's `peer:` session.
// Serving is for this computer's app alone: the Desktop's main process asks
// it for its bridge worker, which opened the sealed request.
//
// `Local` = {id, folder_id, folder_name, kind, grantee_user_id, grantee_name,
// organization_id, organization_name, label, right, expires_at, created_at,
// updated_at, revision, revoked_at, revoked_by, published_at, status:
// active | revoked | expired | stopped, stopped_reason: null | folder_gone |
// folder_isolated | folder_refused | documents_off}; times in ISO 8601. No
// path: the person's phone shows it too.

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function localShare(userId: string, share: ShareRow, folders: ReturnType<typeof listFolders>, now = Date.now()) {
  const folder = folders.find((candidate) => candidate.id === share.folder_id);
  const unshareable = share.revoked_at === null ? folderUnshareable(userId, share.folder_id) : null;
  const stopped = unshareable ? (unshareable === "folder_gone" ? "folder_gone" : `folder_${unshareable}`) : capabilityOn(userId, "documents") ? null : "documents_off";
  const status = share.revoked_at !== null ? "revoked" : share.expires_at !== null && share.expires_at <= now ? "expired" : stopped ? "stopped" : "active";
  return {
    id: share.id,
    folder_id: share.folder_id,
    folder_name: folder ? folderName(folder.path) : null,
    kind: share.kind,
    grantee_user_id: share.grantee_user_id,
    grantee_name: share.grantee_name,
    organization_id: share.organization_id,
    organization_name: share.organization_name,
    label: share.label,
    right: share.right,
    expires_at: iso(share.expires_at),
    created_at: iso(share.created_at),
    updated_at: iso(share.updated_at),
    revision: share.revision,
    revoked_at: iso(share.revoked_at),
    revoked_by: share.revoked_by,
    published_at: iso(share.published_at),
    status,
    stopped_reason: status === "stopped" ? stopped : null,
  };
}

/// Where the Desktop's bridge worker keeps this computer's keys: next to its
/// bridge device id, in the app's data folder, which holds this server's.
const desktopKeyFile = (process as unknown as { parentPort?: unknown }).parentPort ? join(dirname(DATA_DIR), "compute-keys.json") : null;

function localDevice(device: GuestDeviceRow, host: HostIdentity | null) {
  let safety: string | null = null;
  try {
    safety = host ? safetyNumber(host, { encPublic: device.enc_public, signPublic: device.sign_public }) : null;
  } catch {
    safety = null;
  }
  return {
    grantee_user_id: device.grantee_user_id,
    fingerprint: device.fingerprint,
    enc_public: device.enc_public,
    sign_public: device.sign_public,
    state: device.state,
    first_seen_at: iso(device.first_seen_at),
    last_seen_at: iso(device.last_seen_at),
    approved_at: iso(device.approved_at),
    verified_at: iso(device.verified_at),
    // The number both people compare (« Comparer les numéros de sécurité »);
    // null while this computer's identity cannot be read here.
    safety_number: safety,
    // A name the grantee's device gave itself: none is relayed yet.
    name_hint: null,
  };
}

/// The owner, from this computer's app or one of their own devices.
async function owner(req: FastifyRequest, reply: FastifyReply): Promise<{ userId: string } | null> {
  const auth = await requireAuth(req, reply);
  if (!auth) return null;
  if (isThisComputersApp(auth) || (await meshRequester(req, auth, () => meshRoster().get())) !== null) return auth;
  reply.code(403).send({ error: "owner_only" });
  return null;
}

const RIGHTS: readonly ShareRight[] = ["ask", "read"];
const KINDS: readonly ShareKind[] = ["person", "organization"];

/// An expiry the owner chose: null (never) or a moment to come, as ISO 8601
/// or milliseconds. Undefined when it is not one.
function readExpiry(value: unknown, now = Date.now()): number | null | undefined {
  if (value === null) return null;
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms <= now || ms > now + 100 * 365 * 24 * 3600 * 1000) return undefined;
  return Math.floor(ms);
}

const invalid = (reply: FastifyReply, error = "invalid_share") => reply.code(422).send({ error });

export async function localShareRoutes(app: FastifyInstance) {
  app.get("/local_shares", {
    schema: { tags: ["documents"], summary: "The folders this computer shares, and the grantees' devices that reached it (the owner only)" },
    handler: async (req, reply) => {
      const auth = await owner(req, reply);
      if (!auth) return;
      const folders = listFolders(auth.userId);
      const host = shareHostIdentity(desktopKeyFile);
      return reply.send({ shares: sharesOf(auth.userId).map((share) => localShare(auth.userId, share, folders)), devices: guestDevices(auth.userId).map((device) => localDevice(device, host)) });
    },
  });

  app.post<{ Body: Record<string, unknown> }>("/local_shares", {
    schema: { tags: ["documents"], summary: "Share a Documents folder with a household member, an organization co-member or a whole organization (the owner only)" },
    handler: async (req, reply) => {
      const auth = await owner(req, reply);
      if (!auth) return;
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const folderId = typeof body.folder_id === "string" ? body.folder_id : null;
      const kind = KINDS.find((candidate) => candidate === body.kind);
      const right = RIGHTS.find((candidate) => candidate === body.right);
      if (!folderId || !kind || !right) return invalid(reply);
      const granteeUserId = body.grantee_user_id === undefined || body.grantee_user_id === null ? null : accountId(body.grantee_user_id);
      const organizationId = body.organization_id === undefined || body.organization_id === null ? null : accountId(body.organization_id);
      if ((body.grantee_user_id != null && !granteeUserId) || (body.organization_id != null && !organizationId)) return invalid(reply);
      // A person share names its grantee (through an organization or not);
      // an organization share names the organization and no one in it.
      if (kind === "person" ? !granteeUserId : !organizationId || granteeUserId) return invalid(reply);
      const expiresAt = body.expires_at === undefined ? null : readExpiry(body.expires_at);
      if (expiresAt === undefined) return invalid(reply, "invalid_expiry");
      if (body.label !== undefined && body.label !== null && !cleanText(body.label, LABEL_MAX)) return invalid(reply, "invalid_label");
      const folder = listFolders(auth.userId).find((candidate) => candidate.id === folderId);
      if (!folder) return invalid(reply, "folder_unknown");
      // Never a folder of an isolated project (or inside one), never one
      // folderRisk refuses on this machine now.
      const unshareable = folderUnshareable(auth.userId, folderId);
      if (unshareable === "isolated") return invalid(reply, "folder_isolated");
      if (unshareable) return invalid(reply, unshareable === "refused" ? "folder_refused" : "folder_unknown");
      const share = insertShare(auth.userId, {
        folderId,
        kind,
        granteeUserId,
        granteeName: kind === "person" ? cleanText(body.grantee_name) : null,
        organizationId,
        organizationName: organizationId ? cleanText(body.organization_name) : null,
        label: cleanText(body.label, LABEL_MAX) ?? folderName(folder.path).slice(0, LABEL_MAX),
        right,
        expiresAt,
      });
      return reply.code(201).send({ share: localShare(auth.userId, share, listFolders(auth.userId)) });
    },
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/local_shares/:id", {
    schema: { tags: ["documents"], summary: "Change a share's right, expiry or label, or mark it published to the account (the owner only)" },
    handler: async (req, reply) => {
      const auth = await owner(req, reply);
      if (!auth) return;
      const share = shareById(auth.userId, req.params.id);
      if (!share) return reply.code(404).send({ error: "not_found" });
      if (share.revoked_at !== null) return reply.code(409).send({ error: "revoked" });
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const known = new Set(["right", "expires_at", "label", "published"]);
      if (Object.keys(body).some((key) => !known.has(key)) || Object.keys(body).length === 0) return invalid(reply);
      const right = body.right === undefined ? undefined : RIGHTS.find((candidate) => candidate === body.right);
      if (body.right !== undefined && !right) return invalid(reply);
      const expiresAt = body.expires_at === undefined ? undefined : readExpiry(body.expires_at);
      if (body.expires_at !== undefined && expiresAt === undefined) return invalid(reply, "invalid_expiry");
      const label = body.label === undefined ? undefined : cleanText(body.label, LABEL_MAX);
      if (body.label !== undefined && !label) return invalid(reply, "invalid_label");
      if (body.published !== undefined && body.published !== true) return invalid(reply);
      const updated = updateShare(auth.userId, share.id, { right, expiresAt, label: label ?? undefined, published: body.published === true });
      return reply.send({ share: localShare(auth.userId, updated!, listFolders(auth.userId)) });
    },
  });

  app.delete<{ Params: { id: string } }>("/local_shares/:id", {
    schema: { tags: ["documents"], summary: "Stop a share at once (the row is kept, revoked by the owner)" },
    handler: async (req, reply) => {
      const auth = await owner(req, reply);
      if (!auth) return;
      const revoked = shareById(auth.userId, req.params.id) ? revokeShare(auth.userId, req.params.id, "owner") : null;
      if (!revoked) return reply.code(404).send({ error: "not_found" });
      return reply.send({ share: localShare(auth.userId, revoked, listFolders(auth.userId)) });
    },
  });

  app.post<{ Body: { account?: unknown } }>("/local_shares/sync", {
    schema: { tags: ["documents"], summary: "Reconcile with the account's list: revoked there is revoked here; absent there is to publish again; nothing there extends a share" },
    handler: async (req, reply) => {
      const auth = await owner(req, reply);
      if (!auth) return;
      const account = readAccountShares(req.body?.account);
      if (!account) return invalid(reply, "invalid_account_list");
      const { republish, revoked } = syncShares(auth.userId, account);
      const folders = listFolders(auth.userId);
      return reply.send({ republish: republish.map((share) => localShare(auth.userId, share, folders)), revoked });
    },
  });

  for (const decision of ["approve", "refuse", "verify"] as const) {
    app.post<{ Body: { grantee_user_id?: unknown; fingerprint?: unknown } }>(`/local_shares/devices/${decision}`, {
      schema: { tags: ["documents"], summary: `${decision[0]!.toUpperCase()}${decision.slice(1)} a grantee's device for every share of this computer to that person (the owner only)` },
      handler: async (req, reply) => {
        const auth = await owner(req, reply);
        if (!auth) return;
        const granteeUserId = accountId(req.body?.grantee_user_id);
        const fingerprint = typeof req.body?.fingerprint === "string" && FINGERPRINT.test(req.body.fingerprint) ? req.body.fingerprint : null;
        if (!granteeUserId || !fingerprint) return invalid(reply, "invalid_device");
        const device = decideGuestDevice(auth.userId, granteeUserId, fingerprint, decision);
        if (!device) return reply.code(404).send({ error: "not_found" });
        return reply.send({ device: localDevice(device, shareHostIdentity(desktopKeyFile)) });
      },
    });
  }

  app.get<{ Querystring: { share_id?: string; before?: string; limit?: string } }>("/local_shares/audit", {
    schema: { tags: ["documents"], summary: "Who asked what of the shared folders, and what came of it: never a question, never a path (the owner only)" },
    handler: async (req, reply) => {
      const auth = await owner(req, reply);
      if (!auth) return;
      const shareId = req.query.share_id;
      if (shareId !== undefined && !SHARE_UUID.test(shareId)) return invalid(reply, "invalid_share_id");
      const before = req.query.before === undefined ? undefined : Number(req.query.before);
      const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
      if ((before !== undefined && !(Number.isInteger(before) && before > 0)) || (limit !== undefined && !(Number.isInteger(limit) && limit > 0))) return invalid(reply, "invalid_page");
      return reply.send({ audit: shareAudit(auth.userId, { shareId, before, limit }) });
    },
  });

  app.post<{ Body: unknown }>("/local_shares/serve", {
    schema: { tags: ["documents"], summary: "Serve a grantee's request on a shared folder, opened by this computer's bridge worker (this computer's app only)" },
    bodyLimit: 64 * 1024,
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      return reply.send(await serveShareRequest(auth.userId, req.body));
    },
  });
}
