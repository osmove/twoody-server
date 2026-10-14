# Walled-off projects on the person's iPhone — security review

Status: review of 14/10/2026, written with the change it covers (phase 2 of « Cloisonner ce projet »,
docs/projects-design.md §8). Root AGENTS.md rule 12: any change to trust between devices is reviewed, with attack
tests, the account server taken as possibly malicious.

## 1. What changes

Until now a walled-off project (an isolated project, `projects.isolated`) existed for this computer's app only
(`isThisComputersApp`). The person's paired iPhone may now **list, open and continue** the person's walled-off
projects: the list and a project's page (its conversations, notes, tasks and reminders; a note added), its
conversations read, a new one started in it, one continued. Not from the phone: making one, its folder, its export,
renaming, archiving or deleting it (`desktop_app_only`), switching on what reaches outside it for a message.

One question decides it everywhere — `src/projects/walledAccess.ts reachesWalledProjects(req, auth)`:

- this computer's app (`isThisComputersApp`: the owner's session, from this machine, no tunnel, no proxy); or
- **the person's own device**, exactly as `meshRequester` says it (src/sessionTrust.ts): a device session (never a
  `peer:` one, never a firmware device's token, never one `requesterComputerId` names) whose request came **through
  the tunnel from the very key the session was paired with** (`sealedFromSessionKey`), holding a device-access/v2
  **signed by a person device of the verified vault roster** for that key and this computer, **not expired**
  (`keptStatement`, 24 h at most); or the owner's session where `ownerHere` holds (this machine, or the tunnel of
  its own key — a headless server set up from a phone).

Every route that hid walled-off projects now asks it: `/projects` (list, detail, notes — a device never gets the
computer's paths: the folder keeps its name and counts, the sources of an answer lose their `path`), `/discussions`
(list, `/:id`, `PATCH`, `DELETE`, `memory_notices`, `/:id/compact` — which had no wall before this review and now has
one), `/queries` (a turn in a walled-off conversation or starting one), `/tasks`, `/reminders`, `/ws`,
`/diagnostics/turns` and `/diagnostics/messages/:id`. The project's documents themselves stay on the computer:
`/local_documents/*` still serves a walled-off folder's files to this computer's app only (the iPhone shows a cited
source's name, never opens it). What the account may receive does not change: the diagnostics
shared (`/diagnostics/telemetry`, `/diagnostics/full`) never carry them, whoever asks.

What the walls were stays as it was for the phone's turns: the project's documents and notes only, the person's own
words of their memory only, nothing that reaches outside it unless switched on for the message (the iPhone switches
nothing on), a model of this computer or of a trusted computer only (`project_local_model_only`), nothing learned,
nothing sealed into the encrypted history (`vault_ref`, `vault_conversation_id` and `prior_turns` are ignored for
them — `vaultMember` is false), no read-ahead seed kept, no other computer asked for documents or listings, no web
search from the phone's path.

On the iPhone (twoody-app `utils/walledProjects.js`, `screens/WalledProjectScreen.js`, `WalledChatScreen.js`): every
request is `routeFetch(…, {requireSealed: true})` to the paired computer — the tunnel straight to it on the local
network or through the account's relay, sealed end to end with the keys exchanged at pairing; never in clear, never
another computer, never the account. Its own chat screen, apart from the main chat, so that none of the main chat's
ways (encrypted history, mesh coordinator, Apple Intelligence, cloud models, a computer someone shares, the drawer's
cache) can carry it; nothing written to the phone's storage.

## 2. Threats and answers

| # | Threat | Answer | Attack test (test/walledProjectsPhone.test.ts) |
|---|---|---|---|
| 1 | **A malicious account server** relays a request of its own, or replays one of the phone's, to read a project | The relay carries the tunnel's sealed frames only; it cannot open them nor make a session's key. A request it makes in clear has no tunnel of a session's key: not the person. A device-access it forges is not signed by a person device of the verified roster (the account cannot sign for the person's devices); one it replays past its `exp` no longer counts. The account's bridge carries sealed requests only, and never one about a project (`bridgeClient` refuses everything in clear). | the phone's token with no tunnel, through another key's tunnel, with a device-access signed by a key that is no member of the history, with one expired; the account's bridge in clear (bridgePlaintext.test.ts) |
| 2 | **Another computer of the person's network** (a trusted peer) asks for a project, or coordinates the phone's turn | A `peer:` session reaches `/api/v1/peer/*` only (auth.ts `peerMayReach`) and is never the person (`personStanding` « not_your_device »); its documents' search, listing and browse walk around a walled-off folder (`walledAt`). A turn coordinated by another computer arrives with that computer's session, not the phone's: refused. | a trusted peer's session on `/projects`, `/discussions/:id`, `/queries` with `project_id`; its document routes (walledProjects.test.ts) |
| 3 | **A household member's device** (a phone of the household, endorsed by a pinned approver or approved in « Appareils », or using a computer shared with them) | Its session is no person device of the roster (« not_in_history », or « no_device_access » for one paired by code): not the person. A sealed turn under a compute grant runs without the host's documents, notes or conversations. | a household member's phone (endorsed, its own key); one paired by code without a device-access |
| 4 | **An expired device-access** (the person's phone not renewed for a day) | `keptStatement` ignores it past `exp`: the projects disappear for that phone (`device_access_expired` in « Outils », the app signs a new one) | the person's phone whose statement expired a second ago |
| 5 | **A stolen phone** (unlocked) | It is the person's device until the person removes it: the same as their other conversations and memories through it. Removing it from the encrypted history (or the roster revoking its device) ends it at once on every computer (`not_in_history`); its device-access lasts 24 h at most and is only renewed by that device's own vault key. Nothing of a walled-off project is kept on the phone itself (no cache, no history), so a locked or wiped phone holds none of it. | a removed device (no longer in the roster) refused at once |
| 6 | The person's own phone **without** the tunnel (its token over the local network in clear, a proxy) | Not sealed from the session's key: not the person (`not_sealed`). The app refuses to send it otherwise (`requireSealed`). | the person's token on the LAN in clear |
| 7 | The phone asks for what stays on the computer: the folder, the export, archiving, deleting, making one | `desktop_app_only` / 404 | the person's phone on those routes |
| 8 | The phone's turn tries to widen the walls: `capabilities_on`, `web`, a cloud model, `vault_ref`, `vault_conversation_id`, a share's folder | `capabilities_on` from a device is ignored in a walled-off conversation (only this computer's app may switch on what reaches outside); the model plan keeps local and trusted models only; no `vault_ref` or catch-up is taken; the documents are the project's folders whatever the access says | the person's phone with `capabilities_on`, `web`, `vault_ref` and `vault_conversation_id` (contacts never given, nothing kept for the history); the model plan: test/isolatedProjects.test.ts |

## 3. What is not covered

- Switching on e-mails, the agenda, contacts, the web or connectors for a walled-off conversation from the phone:
  refused (threat 8); only this computer's app may.
- The project's folder, export, archiving and deletion from the phone: refused; on the computer only.
- The household member's own walled-off projects on a computer shared with the person: never reachable (they are
  that member's, on their computer).

## 4. Conclusion

Every attack test of §2 passes (`npm test`: test/walledProjectsPhone.test.ts, with walledProjects.test.ts,
isolatedProjects.test.ts, personStanding.test.ts and bridgePlaintext.test.ts). The phone reaches a walled-off
project only as the person's own device — the same standing that already reaches their memories, history and
connectors — through its own sealed tunnel; nothing new is trusted, nothing of a project reaches the account,
another computer or a household member's device.
