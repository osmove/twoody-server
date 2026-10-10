# Sharing Documents folders with household and organization members

Status: design, 10/10/2026. Jimmy: « il faudrait enlever tout ça [Twoody Pro, les Dossiers] et simplement utiliser
les Documents pour les dossiers et pouvoir les partager, et réfléchir au fait qu'ils puissent éventuellement être
partagés au sein d'une même entreprise (modèle Organization déjà existant), il faudrait pouvoir gérer les membres des
organisations ainsi que leurs droits par dossier / projet etc. »
Read with: root `AGENTS.md` §3, §4 (rules 6–12), §9; `docs/mesh-design.md`.

## 0. What exists today (reused)

- **Client files retired** (migration 7, `src/migrations/0007_retire_client_files.ts`). Isolated folders keep their
  walls (`document_folders.project_id`, `library.ts folderProjects()`, `retrieval.ts`). Rule: an isolated project's
  folder, or a folder inside one, is never shared.
- **Organizations (backend).** `Organization#manageable_by?`; `OrganizationMembership` roles owner/admin/member, seat
  states active/invited/suspended; `OrganizationAuditEvent.record!`; `OrganizationInvitation`; Desktop
  `OrganizationsPanel.tsx` (members, invite, role, suspend, remove). Households: `Household`, `HouseholdInvitation`,
  `HouseholdPanel.tsx` — membership makes people eligible, shares nothing by itself.
- **Compute sharing, the template.** `ComputeGrant` (`shared_audience`: same household, or active seats in the same
  organization; `unusable_reason` checked at creation and at each turn; `revoke!`), `ComputeKey` (guest device
  X25519 + Ed25519), `ComputeHostKey` (host identity + signed prekeys, X25519 + ML-KEM-768), `SealedComputeTurn`
  (bridge task with `principal {kind:"shared", grant_id, revision}`). Host: `bridgeClient.ts`
  `isSharedTask`/`assertSealedSharedTask`, `compute/computeHost.ts runSealedTurn`, `computeSeal.ts
  openComputeRequest` (context bound to grant id, both identities and prekey; guest signature; 5-min skew; replay
  memory). Guest: Desktop `src/shared/computeGuest.ts`, app `utils/computeGuest.js` (host key pinned, change or
  downgrade refused); safety numbers `computeSeal.safetyNumber`, `SafetyNumbers.tsx`.
- **Not to copy for documents:** the host trusts the account for the grant itself and pins the first guest key it
  sees for a grant id; « verified » is a renderer localStorage flag nothing enforces. Acceptable for bare compute,
  not for someone's documents.
- **Mesh document search (one person).** `routes/peerDocuments.ts` (search/folders/list/browse/files/raw, `peer:`
  sessions, `peerDocuments/trust.ts`, rate limits, `absolutePaths:false`, scope intersected with local grants,
  `folderRisk`), `peerDocuments/audit.ts` (no question, no path), `documents/remote.ts` (fan-out 1.5 s/3 s, RRF,
  missing notes, `twoody://doc/<computer>/<doc>`), `sessionTrust.ts meshRequester`, raw caps 25 MB relay / 32 MB LAN.
- **The chat.** `document_access` (off | all | selected | only, folder ids `<computer>:<folder>`); documents read up
  front when the message asks, else `search_documents`; Desktop « Outils » → Documents (`DocumentAccess.tsx`).
- **Desktop processes.** The embedded server reaches the account only through main (`account/desktopRelay.ts` ↔
  `shared/serverAccountCalls.ts`, allowlist). Bridge tasks run in a utility process (`bridgeWorker.ts`, started by
  `main/localBridge.ts`), without the database, only while « Répondre aux autres appareils » is on.
- **iPhone.** Reaches its own computer through the same-account tunnel; it cannot carry another person's request.
  The cross-account path is the sealed bridge task.

## 1. Model

A **share** is (owner's computer, one Documents folder, grantee, right, expiry). Grantee:
- `person`: a household member, or an active co-member of an organization (exactly `ComputeGrant.shared_audience`);
- `organization`: « Tout le monde chez <organisation> », every active seat.

No one outside these circles in v1: no link, no e-mail sharing.

| Right | Label | What the owner's computer does |
|---|---|---|
| `ask` | « Poser des questions » | Searches the folder, returns ≤ 8 excerpts (≤ 10 000 chars) with file name, path inside the shared folder and page; folder names and counts. No full text, no file, no browsing. |
| `read` | « Lire les fichiers » | All of `ask`, plus browse, indexed text and originals (Range, 25 MB). |

Read-only: nothing writes to the owner's disk. No re-sharing (it would need the owner's computer to accept grants
signed by someone else). Organization admins manage policy and revocation, never content.

**Expiry**: never / 1 d / 7 d / 30 d / a date, enforced by the owner's clock.
**Revocation**: by the owner (immediate, local), by the grantee (gives up), by an organization admin (account stops
relaying, owner marks it at the next sync), by loss of eligibility (left the household, seat suspended or removed,
account deleted). **Implicit stops**: Documents off, folder removed, folder refused by `folderRisk`, folder inside an
isolated project.

**Guest devices.** A share is to a person, through devices the owner approved: the grantee's existing `ComputeKey`,
`pending` until the owner taps « Autoriser » on their computer, `verified` once safety numbers are compared. Approval
is per (owner computer, grantee, fingerprint) and covers every share from that computer to that person.

## 2. Where each truth lives

**The owner's computer is authoritative** (migration 8):
- `folder_shares`: id (uuid made there), user_id, folder_id, kind, grantee_user_id, organization_id, label, right,
  expires_at, created_at, updated_at, revision, revoked_at, revoked_by (owner|grantee|organization|eligibility),
  published_at;
- `share_guest_devices`: grantee_user_id, fingerprint, enc_public, sign_public, state (pending|approved|refused),
  approved_at, verified_at, first_seen_at, last_seen_at, name_hint (untrusted);
- `peer_document_audit` gains share_id, guest_user_id, guest_fingerprint, outcome — never a question or a path.

A request is served only if all hold, checked there: the share exists locally and is not revoked; not expired by its
clock; the folder still granted, not isolated, passing `folderRisk`; Documents on; the guest fingerprint approved for
the grantee; the operation allowed by the local right; the request opened by `computeSeal` with grant id
`share:<uuid>`, a valid guest signature, skew ≤ 5 min, unseen request id.

**The account (Rails) routes and displays**: `FolderShare` (share_uuid, host_device_id, owner_id, kind, grantee_id,
organization_id, folder_label, right, expires_at, status, revoked_at, revoked_by_id, revoked_reason, revision);
`FolderShare#unusable_reason` mirrors ComputeGrant's plus the organization's policy, checked at creation and at each
request.

**Principle: the account can only restrict.** A share it lists that the owner's computer does not hold, a right it
inflates, a device key it adds, a looser policy: ignored. A revocation, a suspension, a stricter policy: obeyed. A
malicious account can deny service, never grant access.

**Sync**: at start, every 15 min and after each local change, the owner's computer reconciles with
`GET /folder_shares?side=given&host=<self>` (missing there → published again; unknown here → ignored and deletion
asked; revoked there → revoked here).

**What the account learns** (to be written in the privacy policy before shipping, rule 11): that a share exists;
owner, computer, grantee; the folder label as typed (the folder's name by default, editable, the dialog says the
account sees it); right, expiry, times and who changed them; per request: time, grantee, device fingerprint,
computer, sealed sizes, duration, outcome. Never questions, excerpts, file names, paths, contents.

**Organization membership is the account's word**: harmless for a person share (devices approved one by one), not
for an organization share — a new member's devices also need the owner's « Autoriser », unless « Autoriser
automatiquement les appareils des membres » is on (off by default; its text says it trusts the account). Lot L8
removes that trust with a roster signed by admins' devices.

## 3. Request path

```
Grantee's iPhone ──tunnel (same account)──► Grantee's computer (chat, fan-out, its own model)
                                    │ server → Desktop main: {type:"share-call", share, op}
                                    ▼
                 Desktop main: computeGuest.prepareShare (sealed, grant id "share:<uuid>")
                                    │ POST /api/v1/folder_shares/:id/requests {sealed_request, guest_key}
                                    ▼
   Account: share usable? key is the grantee's? owner's computer online? → bridge task "share_request",
            principal {kind:"folder_share", share_uuid, revision}, sealed args
                                    ▼
Owner's computer: bridge worker (holds the sealed-turn identity) → pre-check with the embedded server
                  → openComputeRequest → server runs the op → answer sealed → streamed back → grantee opens it
```

1. **Grantee**: `computeGuest.prepareShare({shared, shareId, op})`, ops `folders | search | browse | text | raw`,
   JSON answers; host pinning unchanged; main exposes it to the server next to `account-call`. Only the search query
   leaves the grantee's computer, never the conversation.
2. **Account**: `SealedShareRequest` modelled on `SealedComputeTurn`; owner offline → `share.host_offline` at once;
   per (share, device) limits 30 searches/min, 120 browses/min; nothing kept beyond the task stub.
3. **Owner's computer**: `bridgeClient.ts` refuses a `folder_share` principal on anything but a sealed
   `share_request`; the worker opens with the computer's identity (one safety number for compute and documents);
   the server re-checks §2 and runs `retrieveDocuments` scoped to the shared folder (`absolutePaths:false`, ≤ 8),
   or browse/text/raw for `read`; every request audited.
4. **Fan-out on the grantee's computer**: `documents/remote.ts` asks `share:<uuid>` sources in parallel (4 s), fused
   by RRF, passages labelled « Contrats · de Jimmy », citations `twoody://share/<uuid>/<document>` (opened with
   `read` only); late or offline: « Le dossier « Contrats » de Jimmy n'est pas joignable : son ordinateur est éteint
   ou hors ligne. »
5. **Answering**: the grantee's own model. A phone-only grantee needs a compute grant too (L7).
6. **Domain separation**: grant ids `share:<uuid>` vs integers for compute, each handler refusing the other's; better,
   a purpose label in `computeSeal` context (`twoody/share/v1`) with new shared vectors (L0).

## 4. Organizations: members, policy, oversight

- **Members** stay in `OrganizationsPanel.tsx`; suspending or removing a member stops their shares (account at once,
  owner's computer at the next sync); each member row shows « N dossiers partagés avec lui ».
- **Policy** `organizations.sharing_policy` (owner/admin): `members_can_share`, `org_wide_shares`, `rights_allowed`,
  `require_verified_devices`, `max_expiry_days`; enforced by the account at creation and per request; the owner's
  computer applies the stricter of its own and the organization's.
- An organization cannot stop a member from sharing their own computer's folder with their household (it does not
  own that computer). Later: a folder marked « Dossier de travail (Osmove) » on the owner's computer can only be
  shared inside that organization.
- **Oversight**: `GET /api/v1/organizations/:id/folder_shares` (admin, metadata only), admin revocation, audit kinds
  `folder_share.created`, `.revoked`, `.revoked_by_admin`, `.expired`, `sharing_policy.updated`.

## 5. Interface (French, « vous »)

- **Documents**: « Partager » on each folder → « Avec » (« Foyer », members of each organization, « Tout le monde
  chez … »), « Ce qu'ils peuvent faire » (« Poser des questions » / « Lire les fichiers »), « Jusqu'au », « Nom
  affiché », and the note: « Cet ordinateur doit être allumé et répondre aux autres appareils. Le compte Twoody voit
  le nom affiché, la personne et le droit, jamais vos fichiers ni les questions. Ce qu'une personne a déjà reçu reste
  dans ses conversations. » « Gérer le partage »: grantees (right, expiry, « Retirer »), « Appareils en attente »
  (« Autoriser » / « Refuser », safety number, stored by the server), « Consultations ».
- **« Partagés avec moi »**: a card per share (owner, computer, right, expiry, « En ligne » / « Hors ligne » / « En
  attente : … doit autoriser cet appareil », safety number), « Poser une question sur ce dossier », « Parcourir »
  (`read`), « Ne plus recevoir ».
- **« Outils » → Documents**: group « Partagés avec moi », one switch per share, off by default, never part of « Tous
  les dossiers autorisés »; hint « Vos questions sur ces dossiers sont lues par l'ordinateur de leur propriétaire. »
- **Settings › Organisations**: for admins « Dossiers partagés » (list, « Retirer ») and « Règles de partage »; for
  members « Ce que je partage dans … ».
- **iPhone** (OTA): « Partagés avec moi » and the « Outils » group, through its own computer.

## 6. Projects (later)

A shared project = its card, read-only (title, status, due date, brief, open tasks) and the folders behind it, one
share per folder with the same right. Writing (« Contribuer ») would be a third right with signed, sealed writes, much
later. The account never becomes a project's authority. Isolated projects are never shared.

## 7. Lots

- **L0** contracts (op/answer schemas, shared fixtures), `computeSeal` purpose label and vectors, security review
  note, privacy-policy draft.
- **L1** backend: `FolderShare`, controller (given/received, candidates, create, update, destroy),
  `SealedShareRequest`, bridge kind `share_request`, `sharing_policy`, admin endpoints, audit kinds.
- **L2** server (owner side): migration 8, `src/shares/{store,policy,serve}.ts`, `/local_shares` routes (owner or
  person-device sessions), device approval, op handler, limits, audit.
- **L3** Desktop (owner side): worker branch, worker ↔ main ↔ server channel, allowlist, « Partager », « Gérer le
  partage », approvals, « Consultations ».
- **L4** grantee, `ask`: `prepareShare`, `share-call`, shared fan-out and citations, « Partagés avec moi »,
  « Outils » group.
- **L5** `read`: browse, text, raw over the relay (chunked, 25 MB, Range).
- **L6** organizations (admin lists, revocation, policy) and iPhone.
- **L7** phone-only grantee. **L8** signed organization roster. **L9** shared projects.

Acceptance: a share « Poser des questions » on « Contrats » answers on the grantee's computer citing a PDF, without
« Ouvrir »; owner asleep → « n'est pas joignable » within 4 s; revoked on the owner's computer → refused even if the
account relays; seat suspended → refused, shown stopped on both sides; real 9B model cites shared excerpts correctly.

## 8. Attack tests (rule 12)

1. Forged share (unknown uuid) → `unknown_share`, nothing opened, audited.
2. Account adds its own key to the grantee → `pending`, `device_not_approved`, safety number differs.
3. Account inflates `ask` to `read` → browse, text, raw refused.
4. Task user changed → fingerprint not approved for that share → refused.
5. Replay → refused (seen ids), stale after 5 min; decide whether seen ids survive a restart, test either way.
6. Revoked or expired locally while relayed → refused by the owner's clock.
7. Outsider or suspended member → refused by the account; with a malicious account, by device approval.
8. Scope escape: other folder ids, nested isolated folder, `..`, absolute path, symlink, hidden or Library path →
   only the shared folder, no absolute path in any answer.
9. Cross-protocol: compute request as share and back; unsealed `share_request`; share principal on `llm_infer` →
   refused.
10. Owner's key changed → grantee refuses (`key_changed`) until verified again.
11. Looser policy from the account ignored, stricter applied.
12. Oversized or too many requests → refused before opening / `rate_limited`.
13. Admin can list metadata and revoke, cannot create a share or read content.
14. Prompt injection in a shared excerpt → no action or connector call without the grantee's confirmation.

## 9. Risks

- Organization membership is the account's word until L8: auto-approve off by default, said so.
- The owner's computer sees grantees' search queries: the hint says so; only the query is sent.
- Delivered excerpts and files cannot be recalled: the dialog says so.
- The grantee's learner must not memorize facts from someone else's documents: check `memory/learner.ts` (not
  verified).
- Relay capacity (Heroku Redis Mini, Postgres essential-0): cap, rate-limit, prefer excerpts; bridge per-delta limits
  not verified.
- The owner's computer must be awake with « Répondre aux autres appareils » on.
- To check apart from sharing: on the Pi, `TWOODY_SELF_BRIDGE=1` with `TWOODY_BRIDGE_FOLDERS` lets bridgeClient run
  unsealed `search`/`read` tasks from the account (`executors/index.ts` SELF_BRIDGE_KINDS) — a path where the
  account token alone reads documents. Shares never use these kinds.
- Never: let the account create, extend or retarget a share; serve an unapproved device; put shared folders in « Tous
  les dossiers autorisés »; share an isolated folder; send absolute paths or questions to the account; write rights in
  v1; extend the same-account tunnel across accounts.
