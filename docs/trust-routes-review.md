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

1. **`meshRequester` takes the owner's session from anywhere** (`sessionTrust.ts`). Gated by it: the synchronised
   history, the memories, the other computers' documents, connector tools in the chat, `/diagnostics/full` (whole
   prompts). An owner token from the local network (password on a headless server, sniffed in clear) reads them.
   Recommended: the same `ownerHere` as for shares (this machine, or the tunnel from the session's own key). What
   breaks: the CLI signed in from another machine loses memories, history and full diagnostics there; the Desktop's
   hidden « self-hosted » sign-in. A mesh change: its own tests (`deviceTools`, `meshDocuments`, `vaultMemories`).
2. **`/auth/signin` off this machine**: a password sent in clear on the local network gives an owner session (now
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
