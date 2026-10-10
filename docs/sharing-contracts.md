# Folder sharing — contracts for lots L1–L4 (10/10/2026)

The interfaces between the account (twoody-backend), the owner's computer (twoody-server + Desktop) and the
grantee's computer, fixed before the three parts are written. Design and reasons: `sharing-design.md`. v1 ships the
`ask` right (folders, search) and `read` without originals (browse, text); `raw` is lot L5.

Words: **owner** shares a Documents folder of one of their computers (the **host**); the **grantee** is a person
(household, or active co-member of an organization) or every active member of one organization.

## 1. Account (Rails), JSON, the person's session (`authenticate_user_from_token_or_devise!`)

Model `FolderShare`: `share_uuid` (uuid made by the host, unique), `host_device` (Device, client_kind
`mac_bridge`, the owner's), `owner`, `kind` (`person` | `organization`), `grantee` (User, person only),
`organization` (person shares through an organization keep it, nil for household; organization shares require it),
`folder_label` (≤ 120), `right` (`ask` | `read`), `expires_at`, `status` (`active` | `revoked`), `revoked_at`,
`revoked_by` (User), `revoked_reason` (`owner` | `grantee` | `organization` | `eligibility` | `host`), `revision`.
`unusable_reason`: revoked, expired, computer removed, account deleted, no longer shared (same household or active
seats — `ComputeGrant.shared_audience`; organization shares: the grantee's active seat in that organization), the
organization's policy forbids it.

```
GET    /api/v1/folder_shares                     {given: [Given], received: [Received]}   (?host_id= filters given)
GET    /api/v1/folder_shares/candidates          {computers: [...as compute_grants], people: [{id, first_name,
                                                   audience, organization_id?, organization?}],
                                                   organizations: [{id, name, policy}]}
POST   /api/v1/folder_shares                     {uuid, host_id, kind, grantee_id?, organization_id?, folder_label,
                                                   right, expires_at?} → 201 {share: Given}
                                                   errors: unknown_computer 404, not_shareable 422,
                                                   policy_forbids 422, invalid_share 422, duplicate uuid 409
PATCH  /api/v1/folder_shares/:uuid               owner: {right?, expires_at?, folder_label?} → {share: Given}
DELETE /api/v1/folder_shares/:uuid               owner → reason owner; grantee of a person share → grantee;
                                                   admin of its organization → organization. 204
POST   /api/v1/folder_shares/:uuid/requests      {sealed_request, guest_key: <fingerprint>, stream: true}
                                                   → text/event-stream: `sealed` events (the host's lines, as is),
                                                   `ping`, then `final` {status: "responded"|"failed", error?}
                                                   errors (in final): share_unavailable, host_offline, busy,
                                                   timeout, rate_limited, too_large, unknown_key
GET    /api/v1/organizations/:id/folder_shares   owner/admin of the organization: [Given without devices]
PATCH  /api/v1/organizations/:id                 also accepts sharing_policy (owner/admin)
```

`Given` = {uuid, host_id, computer: {id, name}, kind, grantee: {id, first_name}|null, organization: {id, name}|null,
folder_label, right, expires_at, status, revoked_reason, created_at, updated_at, revision}.
`Received` = {uuid, kind, owner: {first_name}, organization: {id, name}|null, folder_label, right, expires_at,
computer: {host_id, name, online, compute_key}} — usable ones only.

`organizations.sharing_policy` (jsonb, default `{}` meaning the defaults): `members_can_share` (true),
`org_wide_shares` (true), `rights_allowed` (["ask","read"]), `max_expiry_days` (null). Audit kinds
`folder_share.created`, `folder_share.revoked`, `folder_share.revoked_by_admin`, `sharing_policy.updated`.

**Request relay** (`SealedShareRequest`, modelled on `SealedComputeTurn`): ≤ 300 000 bytes; the guest key must be one
of the requester's `ComputeKey`s; the share usable for the requester (person: grantee; organization: active seat);
host offline (`BridgePresence.online?`) → `host_offline` at once, no task; ≤ 30 requests/min per (share, key) →
`rate_limited`; one task at a time per (share, key) → `busy`. Bridge task kind **`share_request`**, to the host's
device, args `{principal: {kind: "folder_share", share_uuid, revision, grantee_id}, sealed_request, guest_key:
{enc_public, sign_public}}` (the principal kept beside the sealed args, like compute's). Nothing stored beyond the
task stub (who, which computer, when, sizes). Revoking a share fails its queued and running tasks.

## 2. Sealing (shared code, unchanged)

`sealComputeRequest` / `openComputeRequest` with **grantId `share:<uuid>`** (compute grants are integers: a request
sealed for one can never be opened as the other). Request body (JSON, sealed):

```
{op: "folders"}
{op: "search", query: string ≤ 2000, limit?: 1..8}
{op: "browse", path?: string (inside the shared folder, "" = its root), offset?: number}     right read
{op: "text", document_id: string}                                                           right read
```

Answer: the host streams `{"h": header}` then `{"c": piece}` lines (`startComputeResponse`), the pieces joined
forming one JSON value:

```
{ok: true, folder: {label, documents}}                                                     folders
{ok: true, folder: {label, documents}, passages: [{document_id, name, path, page|null, text, score}]}   search
{ok: true, entries: [{name, path, kind: "folder"|"file", size|null, modified_at|null, document_id|null}],
  next_offset|null}                                                                         browse
{ok: true, document: {document_id, name, path, text, truncated}}                            text
{ok: false, error: "unknown_share"|"revoked"|"expired"|"device_not_approved"|"right"|"folder_gone"|
  "documents_off"|"rate_limited"|"bad_request"}
```

`path` is always relative to the shared folder (« Contrats/2026/bail.pdf »), never absolute. Passages ≤ 8,
≤ 10 000 characters in all.

## 3. Owner's computer — twoody-server

Migration 8 (`0008_folder_shares.ts`): `folder_shares` (id uuid, user_id, folder_id → document_folders.id, kind,
grantee_user_id, grantee_name, organization_id, organization_name, label, right, expires_at, created_at, updated_at,
revision, revoked_at, revoked_by, published_at), `share_guest_devices` (grantee_user_id, fingerprint, enc_public,
sign_public, state pending|approved|refused, first_seen_at, last_seen_at, approved_at, verified_at; unique
(grantee_user_id, fingerprint)), `peer_document_audit` + share_id, guest_user_id, guest_fingerprint, outcome.

Routes, the owner's sessions only (this computer's app, or the person's own devices — `meshRequester`; never a
household member's or a peer's):

```
GET    /local_shares                         {shares: [Local], devices: [Device]}
POST   /local_shares                         {folder_id, kind, grantee_user_id?, grantee_name?, organization_id?,
                                               organization_name?, label?, right, expires_at?} → 201 {share: Local}
                                               refused: folder unknown, isolated, refused by folderRisk → 422
PATCH  /local_shares/:id                     {right?, expires_at?, label?, published?: true}
DELETE /local_shares/:id                     revoked here (row kept, revoked_by "owner")
POST   /local_shares/sync                    {account: [Given]} → {republish: [Local], revoked: [id]}
                                               restrict only: revoked/absent there… see below
POST   /local_shares/devices/approve         {grantee_user_id, fingerprint} (also refuse, verify)
GET    /local_shares/audit?share_id=         [{at, share_id, guest_user_id, guest_fingerprint, op, outcome}]
POST   /local_shares/serve                   this computer's app only: {share_uuid, grantee_user_id, guest:
                                               {enc_public, sign_public}, op} → the answer JSON of §2
```

Sync: a share revoked on the account → revoked here (`revoked_by` from its reason); one published here but absent
there → in `republish`; one there unknown here → ignored. Nothing the account says ever extends a share.

`serve` checks, in order, and audits every outcome: share exists and not revoked; not expired (this clock); folder
still in Documents, not in an isolated project, passes `folderRisk`; Documents on; guest fingerprint approved for
`grantee_user_id` (organization share: approved for any grantee under it); grantee is the share's (person share);
op allowed by the right; rate ≤ 30 searches/min and 120 browses/min per (share, fingerprint). An unknown device is
recorded `pending` (then `device_not_approved`). Search: `retrieveDocuments` scoped to the shared folder only
(`absolutePaths: false`, ≤ 8 passages).

Bridge (`bridgeClient.ts`): a task whose principal kind is `folder_share` must be kind `share_request` with a sealed
request, else `shared_task_refused`; `computeHost.runSealedShare({args, serve, send})` opens it with grantId
`share:<uuid>`, calls `serve` (the option `serveShare` of `startBridgeClient`: in-process on the Pi, through the
parent process in the Desktop's worker), streams the sealed JSON. A compute task naming a `share:` grant id is
refused.

Grantee side: `document_access.folderIds` may hold `share:<uuid>` (never part of `mode: "all"`). The fan-out
(`documents/remote.ts`) asks each through the Desktop: message `{type: "share-call", id, share_uuid, op}` →
`{type: "share-call-result", id, result}` or `{…, error: {code}}` (same port and shape as `account-call`), 4 s
budget; passages labelled with the share's label and owner (`result.share: {label, owner_name}` added by the
Desktop), citations `twoody://share/<uuid>/<document_id>`; unreachable → « Le dossier « X » de Y n'est pas
joignable : son ordinateur est éteint ou hors ligne. »

## 4. Desktop

- **Owner**: the worker's `serveShare` posts `{type: "share-serve", id, payload}` to main; main calls the embedded
  server's `POST /local_shares/serve` with this computer's app session and answers `{type: "share-serve-result", id,
  result}`.
- **Grantee**: main answers `share-call` from its server: finds the share in the account's `received` list (cached
  60 s), seals with `computeGuest` (host key pinned as for compute, refused if changed), posts
  `/api/v1/folder_shares/:uuid/requests`, opens the lines, parses the JSON, adds `share: {label, owner_name}`.
- **Renderer**: Documents › each folder « Partager » (dialog), « Gérer le partage » (grantees, « Appareils en
  attente » with safety numbers, « Consultations »); section « Partagés avec moi »; « Outils » › Documents group
  « Partagés avec moi » (off by default); Settings › Organisations, for admins « Dossiers partagés » and « Règles de
  partage ». Publishing to the account is done by the renderer after the server made the share (POST, then PATCH
  `published`), and the sync runs when Documents opens and every 15 minutes.

## 5. As built in twoody-server (L2 and the server half of L4, 10/10/2026)

What the code fixed where this contract left it open; the Desktop follows it.

- **Pre-check.** The worker calls `serve` twice: first with `op: {op: "check"}` (null is accepted too), before the
  sealed request is opened (checks
  1–6 of `src/shares/policy.ts`: share, expiry, folder, Documents, grantee, device), then with the opened body. A
  refusal at the first call fails the task with `share_refused:<error>` (nothing can be sealed to an unopened
  request); nothing is decrypted and the request id is not spent. Main forwards both payloads to
  `POST /api/v1/local_shares/serve` unchanged; the answer to the check is `{ok: true}` or `{ok: false, error}`.
- **Serve payload**: `{share_uuid, grantee_user_id, guest: {enc_public, sign_public}, op}`; `grantee_user_id` is the
  principal's `grantee_id` (for an organization share, the requesting member). Always HTTP 200 with the §2 JSON for
  this computer's app; 403 `desktop_app_only` for any other session; body ≤ 64 KB.
- **Checks' order**: the grantee of a person share is checked before the device is recorded (an account naming
  someone the share is not to records nothing in « Appareils en attente »); a wrong grantee answers `unknown_share`
  (audited `wrong_grantee`). Isolated, refused or removed folder → `folder_gone` (audited `folder_isolated`,
  `folder_refused`, `folder_gone`). Rate buckets: `search` 30/min; `folders`, `browse`, `text` 120/min.
- **Ops**: `text` ≤ 100 000 characters (`truncated`); `browse` 100 entries a page, sorted by name; an unknown field,
  an unknown op (`raw` included until L5), a path outside the folder → `bad_request`.
- **Replay**: request ids are remembered in memory only; after a restart a copy relayed again within its five
  minutes is served again — read-only, and sealed to keys only the guest's device holds.
- **Bridge**: the worker declares `folder-share-provider` only when it has a `serveShare` hook; extra task args
  (`sealed`, `guest_fingerprint`, `request_bytes`) are ignored. Tasks of kind `share_request` without a
  `folder_share` principal, and `folder_share` principals on any other kind, fail with `shared_task_refused`; a
  compute task whose grant id contains « : » too.
- **Routes' shapes**: `Local` = {id, folder_id, folder_name, kind, grantee_user_id, grantee_name, organization_id,
  organization_name, label, right, expires_at, created_at, updated_at, revision, revoked_at, revoked_by, published_at,
  status: active|revoked|expired|stopped, stopped_reason}, times ISO 8601, no path. `Device` = {grantee_user_id,
  fingerprint, enc_public, sign_public, state, first_seen_at, last_seen_at, approved_at, verified_at, safety_number,
  name_hint} — `safety_number` from this computer's sealed-turn identity (the in-process bridge's, or the Desktop
  worker's key file next to the server's data folder, `TWOODY_COMPUTE_KEYS_PATH` otherwise), null when it cannot be
  read; `name_hint` null until a name is relayed. The audit answers `{audit: [...]}`. Every route is served at the
  root and under `/api/v1`. DELETE answers 200 {share}. The approve/refuse/verify routes answer {device}. `sync`
  puts in `republish` every active, unexpired share absent from the account, published before or not.
  `share_guest_devices` carries `user_id` (unique on user, grantee, fingerprint).
- **Grantee side**: `share-call` results may carry `share: {label, owner_name}` in the result or beside an error;
  codes `device_not_approved` read as « … doit d'abord l'autoriser », `unknown_share`, `revoked`, `expired`, `right`,
  `folder_gone`, `documents_off`, `share_unavailable`, `unknown_key`, `key_changed` as « n'est plus accessible »,
  anything else (`host_offline`, `timeout`, `host_error`, `bad_request`…) as « n'est pas joignable ».
