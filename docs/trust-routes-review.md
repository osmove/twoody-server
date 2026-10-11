# Security review: the routes that change the mesh's trust

10 October 2026. Follows `docs/connectors-security-review.md` (« Residual 5 » and its borderline list) and
commit 67d3984, which made « this computer's app » (`routes/usage.ts isThisComputersApp`) mean the owner's session
**on this very machine** (`auth.ts fromThisMachine`: loopback, not served by the tunnel, not forwarded by a proxy).
AGENTS.md rule 12: any change to the trust between devices gets a review with attack tests; the account server is
taken as potentially malicious. Attack tests: `test/trustRoutes.test.ts` (each attack passed on the code before,
checked by running the file on an export of 67d3984), and `test/vaultAnchors.test.ts`.

In scope: `POST`/`DELETE /api/v1/peers`, `GET /peers/:id/vault/identity`, `POST /peers/:id/vault/anchor`,
`PATCH /peers/:id` `checked_tunnel_key`, `mayPin` on `POST /api/v1/peer/vault/anchor`, the `/local_shares` writes
(`meshRequester`), then the borderline routes of the previous review.

## Threat model

Who may hold a token this server accepts, besides the Desktop on loopback:

- **the owner's session from elsewhere**: `/auth/signin` with the password from another machine (a headless server
  that has one; the Desktop's embedded server has none: it pairs with its setup token), in clear on the local network
  when the server is open to it; the same token forwarded by a reverse proxy; or carried inside the tunnel of another
  device's key (a device paired by code that also learnt the password);
- **a phone given a headless server's setup token**: an owner session with its own tunnel key;
- **a device paired by the code on the screen** (the CLI through `/session/cli`); and every device the Desktop lets
  in from « Appareils » (`twoody-desktop main.ts grantOnLocalServer`: it pairs them with that code), **a household
  member's phone included**: all are « code » sessions on the Mac;
- **a session the account brought in** (`account/approvals.ts`): rule 1 (the device that typed the computer's code),
  rule 2 (a **household member's phone** endorsed by an approver), rule 3 (approved at the console), rule 5 (a phone
  of the person's, by its device-access);
- **another computer's `peer:` session** (only `/api/v1/peer/*`), a firmware device's token;
- **the account and the relay** themselves: they cannot read the sealed tunnel, but they answer `request_access`,
  list the computers, relay shares — whatever a stolen owner token sets up, they can complete.

What an attacker wants here: have this computer send the person's turns to a computer of theirs, trust a key or a
vault device of theirs, share a folder with an account of theirs, or steer the model.

## Who legitimately calls each route

| Route | Callers found | Not a caller |
|---|---|---|
| `POST/DELETE /peers`, `/peers/:id/vault/identity`, `/peers/:id/vault/anchor`, `PATCH /peers/:id checked_tunnel_key` | the Desktop on loopback (`main/meshLinks.ts`, `main/accountComputers.ts`, `main/vault.ts`, `renderer/ComputersPanel.tsx`); a headless server's console or admin token (`ownerRequest`) | the iPhone (only `GET /peers/:id/audit` and, through its own tunnel, `/peer/vault/*`); the CLI; other computers (peer auth) |
| `POST /peer/vault/anchor` | the iPhone naming itself (`utils/peerTrust.js`, its own tunnel); a Desktop's embedded server through its peer link; the console | — |
| `/local_shares` writes | the Desktop's renderer (`folderSharing.ts`, `SharedFolders.tsx`) and main process (`shareServe.ts`) | the iPhone (not in `COMPUTER_PATHS`; « Partagés avec moi » is the grantee's side), the CLI |
| `PUT /runtime custom_url` | the console (`twoody-server runtime`); the Desktop sets its engine in its own file (`main/enginePref.ts`) | the iPhone sends `{engine}` only (`utils/computerRuntime.js`) |
| providers writes | the Desktop; the CLI (`twoody server provider …`, signed in or paired with a code, maybe from another machine) | the iPhone (reads `/providers`, `POST /providers/load`) |
| `POST /devices/pair/register` | `twoody pair` (CLI) | — |
| `PATCH /me system_prompt` | the Desktop's settings | the iPhone (its `/me` goes to the account) |

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | **A household member's phone could send every conversation to a machine of theirs.** `POST /providers/local`, `PATCH /providers/:id`, `POST /providers/:id/default` took any token: a household member's phone (rule 2 on a headless server; a « code » session on the Mac, which pairs every device it approves with its code), a session the console approved, a firmware device's token. The turns carry the person's memory profile and conversation; local-only mode keeps addresses private, which a laptop on the same Wi-Fi is. `PUT /runtime custom_url` the same. | Providers writes: `sessionTrust.ts choosesForThePerson` — the owner's session (Desktop, CLI signed in), the CLI paired with a code (`/session/cli`, kind `cli`), or one of the person's own devices (`meshRequester`'s person branch: a member of the history, through its own tunnel); or the console (`ownerRequest`). Refused: `not_the_person`. `custom_url`: this computer's app or the console only (`desktop_app_only`); switching engines stays open to the iPhone. |
| 2 | High (needs the owner's token from elsewhere) | **Adding a peer of the attacker's, « checked ».** `requireDesktop` took any owner session from anywhere. With the password typed on another machine (or the token sniffed on the LAN in clear, or forwarded by a proxy), `POST /peers {computer_id, checked_tunnel_key: <attacker's key>}` asks the account, which (malicious) lists that computer and answers with a sealed reply carrying that key: the link is « checked » and `peerRoutable` sends it turns. `PATCH /peers/:id {checked_tunnel_key}` did the same on a link the account alone made. | `requireDesktop` and `checked_tunnel_key`: `isThisComputersApp` (owner session on this machine) or `ownerRequest` (console, admin token). The same for `DELETE /peers/:id` (forgetting a link: denial of service), `GET /peers/:id/vault/identity` and `POST /peers/:id/vault/anchor`. |
| 3 | High (headless computer, before its approval) | **Naming the vault's trust root with the owner's token inside another device's tunnel.** `mayPin` took `isOwnerSession` whatever the tunnel key: a device paired by code that also holds an owner token (password) pins its own vault device as the computer's anchor; the roster then starts from the attacker. | `mayPin`: the console / admin token, or `ownerHere` — the owner's session from this machine or through the tunnel from the very key it was paired with (the phone given the setup token). Never inside another key's tunnel, never the relay's stamp alone. |
| 4 | Medium | **Sharing a folder with an attacker's account.** `/local_shares` writes took `isThisComputersApp` or `meshRequester`, whose owner branch takes the owner's session from anywhere, and whose person branch takes any person device. `POST /local_shares {grantee_user_id: <attacker>, right: "read"}` then `devices/approve` of the attacker's fingerprint: with the relay's help, the folder's files are read. | What **widens** a share — `POST /local_shares`, `PATCH` (right, expiry, label, published), `devices/approve`, `devices/verify` — is this computer's app alone (`desktop_app_only`): the owner's computer decides on its own screen. Looking (`GET`, `audit`) and narrowing (`DELETE`, `devices/refuse`, `sync`) stay with the person's devices, the owner's session only where `ownerHere` holds. |
| 5 | Medium | **Steering the model**: `PATCH /me {system_prompt, system_prompt_replace_base}` took any token: a household member's phone writes what every conversation's model is told first, a lasting prompt injection with the person's tools. | Those two keys: `choosesForThePerson` or the console (`not_the_person`); the other preferences unchanged. |
| 6 | Medium | **Minting a CLI session**: `POST /devices/pair/register` took any token; the code becomes a CLI session through `/session/cli`, i.e. more than a household phone or a firmware token was given (and, with fix 1, the right to choose the models). | `choosesForThePerson` or the console. |
| 7 | Low | `GET /peers/:id/vault/identity` (public keys) and `DELETE /peers/:id` from elsewhere | covered by fix 2 |

Attack tests (`test/trustRoutes.test.ts`), each passing on the code before and refused now, by its own error code so
that no other refusal hides the gap: the owner's token from the local network, through the relay, inside another
device's tunnel, through a proxy; the iPhone, a device paired by code, a household member's phone, the owner's phone
through its own tunnel — against the five mesh routes (and nothing changed: the link still there, not checked, no
turns, no link asked); the anchor; the five widening share writes and the share reads; `custom_url`; the providers
writes, `pair/register` and `system_prompt` by a household member's phone (rule 2) and by a device paired by code that
is no member of the history. Legitimate paths tested in the same file: the Desktop checks the security
code and the link takes turns, asks for and forgets links; the console; the iPhone lists peers and switches one off,
pins through its own tunnel, looks at shares and stops one, switches engines; the CLI adds a provider from another
machine (signed in, or paired with a code) and sets the default; the person's iPhone adds one; `twoody pair`; the Desktop writes the system prompt.
`test/vaultAnchors.test.ts`: the owner now pins from this machine; its token inside a random key's tunnel is refused.

## Residual risks — Jimmy's decision

1. ~~**`meshRequester` takes the owner's session from anywhere**~~ — fixed 11/10/2026 (follow-up below). (`sessionTrust.ts`). Gated by it: the synchronised
   history, the memories, the other computers' documents, connector tools in the chat, `/diagnostics/full` (whole
   prompts). An owner token from the local network (password on a headless server, sniffed in clear) reads them.
   Recommended: the same `ownerHere` as for shares (this machine, or the tunnel from the session's own key). What
   breaks: the CLI signed in from another machine loses memories, history and full diagnostics there; the Desktop's
   hidden « self-hosted » sign-in. A mesh change: its own tests (`deviceTools`, `meshDocuments`, `vaultMemories`).
2. ~~**`/auth/signin` off this machine**~~ — fixed 11/10/2026 (follow-up below): a password sent in clear on the local network gives an owner session (now
   refused by every route above, but not by `meshRequester` or the rest). Recommended: refuse sign-in that is neither
   loopback nor through the tunnel, unless the server is published with `TWOODY_ADMIN_TOKEN`; the CLI on another
   machine then pairs with a code (`twoody pair`).
3. **Whoever reads the computer's code may still get a CLI session** (`/session/cli` with the code the Desktop or
   the console shows), which may choose the models: someone in front of the screen. And a person's device whose
   device-access has expired is refused until the app renews it (it does, before). Option: CLI sessions only from
   `twoody pair` codes, not the screen's.
4. **`PATCH /peers/:id {enabled, trusted}`** stays with `requirePairedPerson`: a household member's phone may switch
   a peer off for the automatic choice (`trusted` no longer decides anything, the roster does). Option: the person's
   devices only (`meshRequester` person branch).
5. **Sessions without an origin** (made before `auth_sessions.origin` existed) are neither owner nor code: such an old
   CLI session must pair again to manage providers or make a pairing code.
6. **Shares from the iPhone** (lot L6): when the phone manages shares, widening must stay a confirmation on the
   computer (the phone asks, the Desktop shows and decides), not a route the phone calls.
7. Unchanged from the previous review and still open: `GET /local_documents/folders` full paths to other devices,
   `GET /email/status`, `/built_in_capabilities`, `/members/*`, `/bridge/*`.

## Follow-up, 11 October 2026: residuals 1 and 2 (approved by Jimmy)

Attack tests: `test/ownerHere.test.ts` (each attack passed on the code before, checked on an export of
`fa23518`).

### Residual 1 — `meshRequester`'s owner branch: this machine or its own tunnel

`meshRequester` (`sessionTrust.ts`) now takes the owner's session only where `ownerHere` holds — as
the share writes and `mayPin` already did: a request from this very machine (`auth.thisMachine`:
loopback, not served by the tunnel, not forwarded by a proxy), or through the tunnel from the very
key that session was paired with (a phone given a headless server's setup token). Not over the local
network, not through a proxy, not with the relay's stamp alone, not inside another device's tunnel.
Everything behind it at once: the memories and the entities (`requirePerson`), the synchronised
history (`mayReachHistory`), the traces (`/diagnostics/turns`, `/messages/:id`, `/full`,
`/telemetry`, `/installation`), the person's tools (`POST /tool_calls` `memory_search`…), the
connectors in a chat (`from_devices`), the other computers' documents, sealing a turn into the
history. The console (`ownerRequest`: this machine, or the admin token) is unchanged; so is the
person branch (a device-access through its own key), which is what the iPhone paired with the Mac is.

Tested: the owner's token from the local network, the relay without a key, another device's tunnel,
a proxy — refused (`person_device_required`, no memory written, `from_devices: false`); the Desktop
on loopback, the CLI's owner session on this machine, the iPhone and a setup-token phone through their
own tunnel — still served. The whole suite (1 140 tests) passes unchanged.

**What breaks, for whom.** The CLI signed in with the password from another machine loses the
memories, the history, the traces and the person's tools there (it pairs instead, and gets what a
paired CLI gets); the Desktop's hidden « self-hosted » sign-in against a remote server the same; a
phone paired with a headless server's setup token **without** a tunnel key (an old pairing). Nothing
changes for the Desktop on its own machine, the iPhone paired with the Mac (a person, through its own
tunnel), nor a Pi adopted through the account.

### Residual 2 — the password only on this machine

`routes/session.ts mayTakePassword`: `/auth/signin` and `/auth/signup` (and their `/api/v1` twins)
take the password only from this very machine, sealed through the tunnel (`tunnelPeerKey`: the
tunnel's own stamp, from loopback, no proxy — a forged stamp from the network is not one), or with the
admin token in the request (`x-admin-token` or `Bearer`) on a server published with
`TWOODY_ADMIN_TOKEN` (the operator's own https in front). Otherwise `403 signin_local_only`, whose
message points to `twoody pair`; checked before the rate limiter and the password. `twoody-cli`
(`src/signinHere.ts`, `login.ts`, `setup.ts`) reads that code and says to pair this machine instead
(`twoody setup` → `pair`, with the code `twoody serve` shows or one `twoody pair` makes there);
smoke test `scripts/smoke-signin-here.mjs`.

Tested: the password from the local network, through a proxy, with the relay's stamp alone, with a
forged tunnel stamp from the network, with a wrong or missing admin token — refused, no token;
sign-up the same. Legitimate: on this machine (the admin token set or not), sealed through the
tunnel, with the published server's admin token from elsewhere; a wrong password is still 401.

### Residual risks — still open

1. **Sessions already given**: an owner session a remote CLI obtained before today stays valid where
   the owner's origin alone counts (`choosesForThePerson`: providers, `pair/register`,
   `system_prompt`). It can no longer read the person's data (residual 1), but can still choose the
   models. Option: expire owner sessions made by `/auth/signin` from elsewhere (their address is not
   kept today), or ask `ownerHere` in `choosesForThePerson` too (the CLI paired with a code keeps it).
2. **A sign-in through the tunnel** (a device paired by code that knows the password) gets an owner
   session; that session holds no tunnel key, so `ownerHere` refuses it everywhere but on this
   machine: it may choose the models (as above), not read the person's data.
3. **The admin token** travels with the request: over plain http on a network, it is as exposed as the
   password was. Publishing with `TWOODY_ADMIN_TOKEN` assumes https in front (README).
4. **Pairing secrets on the network**: `/auth/pair` (setup token, or the code on the screen) and
   `/session/cli` (the code) still travel in clear on the local network at pairing — the trust
   boundary by design (a one-time token read off the screen), unchanged here.
5. Items 3 to 7 of the list above are unchanged.


## 11/10/2026 — « Outils » on Jimmy's iPhone: why it was not the person, and E-mails from the phone

**What happened.** On Jimmy's iPhone (OTA 0.2.61, Desktop 0.13.95), « Outils » greyed the connectors
with the generic « Pour l'instant… », showed no « Recherche Internet » and no E-mails. In a read-only
copy of his Mac's `local.db`, the iPhone's session (`pair:iPhone`, paired by QR code: no origin, no
rule) held a device-access/v2 whose `exp` was 10/10/2026 07:10 UTC; the iPhone asked the Mac three
times on 11/10 (06:58–07:13 UTC, `message_traces`) and no fresh statement came. A replay of that copy
(`buildApp()`, `TWOODY_LOCAL_ONLY=1`, a fake roster listing the iPhone's real vault device id with a
key of ours, a request stamped by the tunnel from the iPhone's real tunnel key) showed: before,
`devices.web` false and `/memories` 403; one `POST /session/device-access` signed for that key and
this computer, 200; after, `devices.web` true and `/memories` 200. So the server takes a renewal for
that very session; the statement simply was not renewed, and nothing said so — `/connectors` and
`/local_capabilities` answer 200 with `from_devices: false` / `web: false`, which never made the
phone sign again (only a 403 did). 67d3984, 795a568 and ce2a5b0 did not cause it: the statement had
run out (10/10 09:10 in Paris) before any of them was written, and none changed the person branch of
`meshRequester`, `renewDeviceAccess` or the tunnel's stamp (the replay ran on them).

**What changed.**

- `sessionTrust.ts personStanding`: for the device asking about itself, whether it is the person
  here and if not why — `not_your_device`, `owner_elsewhere`, `not_sealed`, `no_device_access`,
  `device_access_expired`, `history_unreadable`, `not_in_history` — and when its statement runs out.
  It decides nothing: every route still asks `meshRequester`, which it mirrors
  (`test/personStanding.test.ts` checks both on every kind of session).
- `GET /local_capabilities` `devices` carries `person`, `reason`, `until` and `email`; `GET /connectors`
  carries `person: {person, reason}`. The iPhone signs a fresh device-access when told
  `no_device_access` or `device_access_expired`, and says the reason in « Outils » meanwhile.
- E-mails (`routes/queries.ts offersEmail`) is offered to the person's own devices exactly as the
  connectors: `isThisComputersApp(auth) || meshRequester(...) !== null`, a model of this very computer
  only, a draft asked on the device that sent the message and answered only by its session or this
  computer's app (`answerApproval`), never « Toujours autoriser », nothing sent. Linking a mailbox and
  `/email/*` stay for this computer's app. What leaves the computer: the answer and the draft's
  preview (recipients, subject, start of the text) go to the person's own iPhone, sealed by the
  tunnel — as a connector's answer already does; the privacy policy's E-mails paragraph should say it
  (as its Connecteurs paragraph does for the iPhone) before this ships.

Attack tests (`test/personStanding.test.ts`): a household member's phone (rule 2), a device paired by
code that is no member, the iPhone's token without its tunnel key or through another key, the owner's
token from the network, another computer's peer session — none is the person, none is offered the
e-mail tools, none can answer the iPhone's draft question; a statement signed by a key the history
does not list for that device is `not_in_history`.
