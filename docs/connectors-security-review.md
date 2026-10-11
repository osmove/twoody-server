# Security review: connectors that launch a program (MCP over stdio)

10 October 2026. Scope: `src/connectors/` (connectors.ts, mcpClient.ts), `src/routes/connectors.ts`, the
connector part of `src/routes/queries.ts`, the diagnostics shared with the account, Twoody Desktop's
`ConnectorsPage.tsx` / `connectorInput.ts` / `connectorCatalog.ts`, and the iPhone's « Outils »
(`twoody-app/utils/connectors.js`, `utils/chatApprovals.js`). Attack tests:
`test/connectorsSecurity.test.ts` (fixture `test/fixtures/hostile-mcp.mjs`) and, in the Desktop,
`test/connectorInput.test.mjs`.

## Threat model

A stdio connector is a program this computer runs with the person's rights. Whoever decides its
command, arguments or environment owns the computer. Attackers considered:

- the account server and the relay (rule 12: possibly malicious) — they carry the tunnel's traffic;
- a paired iPhone, a device paired by code, a household member's phone, another computer of the
  account (`peer:` session), anything on the local network when the server is open to it;
- the model, steered by a prompt injection in a document, an e-mail, a web page or another
  connector's tool result;
- the connector's program itself (an npm/PyPI package updated or taken over): it may lie about its
  tools, flood, refuse to end, read what it is given;
- a pasted configuration (« JSON » tab) from a web page.

Out of scope: malware already running as the person (it can read `connectors.json` and `local.db`).

## What was found and fixed

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | « Toujours autoriser » survived a change of command, arguments or environment: an allowed tool name kept running without asking under another program. | `changeConnector` empties `auto_tools` when command, args, env, url or headers change; a new name alone keeps it. |
| 2 | Medium | A tool allowed once and for all kept its pass when its server changed its description or parameters (an updated `npx -y` package, a server that rewrites itself: « rug pull »). | `startConnector` keeps in `auto_tools` only the tools whose description and schema are unchanged since they were allowed. |
| 3 | Medium | The program inherited this server's whole environment: `TWOODY_RUNTIME_KEYS`, `TWOODY_PAIRING_CODE`, the web bridge's key, Google's client secret, `TWOODY_DATA_DIR`… | `connectorEnvironment`: an allow-list (HOME, PATH, USER, LANG, LC_*, TMPDIR, proxies, CA files; the Windows equivalents), then the connector's own env. PATH joined with the platform's delimiter (it was `:` on Windows too). |
| 4 | Medium | Configuration gated by `isThisComputersApp` alone (an owner session without tunnel key). An owner session obtained elsewhere — `/auth/signin` with the password from another device on the local network, or the token carried through the tunnel or a proxy — could add or change a program. | `fromThisComputersApp`: the owner session **and** a loopback request not served by the tunnel (`x-twoody-via-tunnel`) nor forwarded by a proxy. Applies to add, change, remove, start, OAuth start/sign-out, and to the full listing. |
| 5 | Medium | `GET /connectors` gave any device of the account — a household member's phone, a device paired by code — each connector's command, arguments (which may hold a database password or a token), address, environment and header names, and its error text (the end of its stderr). | Only this computer's app gets them; other devices get name, tools, state, and `error: "unavailable"` when something is wrong (what the iPhone and the Desktop's « Outils » use). |
| 6 | Medium | Stopping a connector sent SIGTERM to the direct child only: what `npx` started, or a program ignoring SIGTERM, kept running; nothing stopped them when the server closed. | Started in its own process group (POSIX) and stopped as a group: SIGTERM, then SIGKILL after 2 s; `taskkill /T /F` on Windows; every connector stopped on `app.close()` and killed at process exit. |
| 7 | Medium | A server writing to a closed input threw `EPIPE` at this process (uncaught: the server ended). | `stdin` errors fail the pending calls and stop that connector only. |
| 8 | Low | No limit on a line from the program: a flood without a line break filled this server's memory; the call waited 120 s. | 8 MB per line, past which the program is stopped and its calls fail at once. |
| 9 | Low | The program started in whatever folder the server ran in (a relative command resolved there; on Windows the current folder is searched first). | `cwd` is the person's home folder; `shell: false`, `windowsHide: true` stated. |
| 10 | Low | Shared diagnostics (`telemetryOf`) carried `mcp__<connector name>__<tool>`: a name the person typed. | Shared as `mcp`. |
| 11 | Low | The Desktop started a command as soon as it was added, a pasted configuration included, without showing it. A line break, a right-to-left mark or an invisible character in an argument could hide what runs. | Before adding: a confirmation showing each command line exactly (`commandsToRun`, hidden characters written as `\u{…}`) and its environment's names, never values; in the ten languages. |

Checked and found sound (tests that attack, passing before and after):

- **No shell**: `spawn(command, args)` without a shell; `$(…)`, backticks, `;`, `|`, `&&`, `%PATH%`,
  `${HOME}`, line breaks reach the program as plain arguments (test « no shell »).
- **The model cannot add or change a connector**: no chat tool writes connectors or files; a call
  to an unknown tool does nothing. A connector's result asking for another tool gets that call asked
  in the chat, not made (test « the model can add nor change nothing »). Results are wrapped as
  « data, not instructions ».
- **The catalog cannot be swapped for a command**: its 63 entries are https addresses compiled into
  the Desktop; nothing is fetched from the account. Only the « Commande » and « JSON » tabs make a
  stdio connector.
- **Approvals** (already tested in `deviceTools.test.ts` and `connectors.test.ts`): answered only by
  the session that asked or this computer's app; never another device, a household phone, a device
  paired by code, a guessed id. Connector tools are offered only to this computer's app and the
  person's own devices (`meshRequester`); peer sessions reach `/api/v1/peer/*` only.
- **Secrets at rest and in traces**: env and header values live in `connectors.json` (0600) and are
  never sent back; traces keep a tool's arguments and result preview locally only; `telemetryOf`
  shares counts and names, no content.
- **Output size**: a tool result is cut at 12 000 characters, stderr kept to its last 2 000.
  Timeouts: 30 s to initialise, 120 s per call, 2 min for the person's answer.

## Residual risks — Jimmy's decision

1. ~~**Windows**: `npx`/`npm` connectors do not start without a shell~~ — done in the follow-up
   below (`npx` resolved to `node.exe <npm>\bin\npx-cli.js`, other `.cmd`/`.bat` refused). Group
   kill on Windows (`taskkill /T`) is still written but not run on a Windows machine.
2. ~~**Unpinned packages**: `npx -y pkg` fetches whatever is published at each start~~ — pinned at
   add time since 11/10/2026 (follow-up below); transitive dependencies still float.
3. **No sandbox**: the program has the person's rights (files, network, `local.db`). A sandbox
   (macOS `sandbox-exec` is deprecated; containers) is a product decision.
4. ~~**« Toujours autoriser » and prompt injection**~~ — read-only tools only since 11/10/2026
   (follow-up below); a read-only tool can still be talked into a call, and its server's word is
   taken.
5. ~~**Other routes still trust `isThisComputersApp` alone**~~ — done in the follow-up below;
   the borderline routes are listed there for Jimmy.
6. **Abrupt end**: if the server is killed without its `exit` handler (SIGKILL, Windows
   `TerminateProcess` from the Desktop), programs only see their input close; most MCP servers end
   then, not all.
7. ~~**Twoody Code's MCP servers**~~ — done in the follow-up below.
8. **Tokens in `connectors.json`** are plain text (0600), not in the system keychain.

## Follow-up, 10 October 2026 (late): residuals 1, 5 and 7

### Residual 1 — Windows: `npx` without cmd.exe

`src/connectors/windowsLaunch.ts` (the same file in `twoody-desktop/src/main/code/windowsLaunch.ts`
for Twoody Code), used by `launchFor` before `spawn`, on Windows only:

- the command is looked for on PATH ourselves (PATHEXT's extensions, `Path` in any case), never in
  the current folder (Windows searches it first) nor in a relative PATH entry; a command found
  nowhere is not started (« the program was not found »);
- an `.exe`/`.com` found starts as it is, by its full path (`node`, `uvx`, `docker`, Volta's
  `npx.exe`);
- `npx`/`npm` (`.cmd`) become `node.exe <npm>\node_modules\npm\bin\npx-cli.js …` (or
  `npm-cli.js`): the script their `.cmd` runs, from the installation it belongs to — next to the
  `.cmd` (Node's installer, nvm-windows, scoop), else next to the `node.exe` on PATH (npm updated
  into `%APPDATA%\npm`); no Node found: `windows_node_not_found`;
- any other `.cmd`/`.bat` (pnpm, yarn, a script) is refused: `windows_script_refused`. Never
  through cmd.exe, arguments always an array.

The Desktop says both refusals in the ten languages (`connectors.windowsScriptRefused`,
`connectors.windowsNodeMissing`, `connectorInput.ts startErrorKey`), under the connector and in
Twoody Code's « MCP » panel. Twoody ships no Node that could run npm (Electron has no npm), so the
person's own Node is used.

Tests: `test/connectorsWindowsLaunch.test.ts` (simulated Windows folders, attacks: `&`, `|`, `%…%`,
`"` stay arguments of node; a planted `node.exe`/`npx.exe`/`evil.exe` in the current folder does
not run; `.cmd`/`.bat` refused) and `twoody-desktop/test/codeMcp.test.mjs`.

**Not run on a real Windows machine**: the resolution against a real Node install, a connector
actually started that way, `taskkill /T /F` stopping the tree, and what npm itself does next —
`npx -y pkg` runs the package's own bin, which npm on Windows starts through its `.cmd` shim with
npm's own escaping (outside Twoody's hands).

### Residual 7 — Twoody Code's MCP servers (`twoody-desktop/src/main/code/mcp.ts`)

- **`~/.twoody/mcp.json` runs nothing until allowed**, like a project's `.mcp.json`: its exact
  command line is shown (each argument, hidden characters written as `\u{…}`, the environment's
  names) and confirmed once for every folder; a change of command, arguments, environment or
  address asks again (fingerprint).
- **Allowed as shown**: `mcpAllow(workspace, name, fingerprint)` — the fingerprint of what the
  panel showed; a file rewritten between the showing and the click is not allowed.
- Environment allow-listed (`mcpEnvironment`: the login shell's PATH, HOME, language, proxies…;
  never `TWOODY_*`, `ELECTRON_*`, `NODE_OPTIONS`), its own `env` on top.
- Its own process group (POSIX), stopped as a group (SIGTERM, then SIGKILL after 2 s; `taskkill /T`
  on Windows), every server killed when the app ends (`exit` hook) — after `stopCode()` at quit.
- `stdin` errors (EPIPE) fail that server's calls and stop it; 8 MB at most without a line break;
  `shell: false`, `windowsHide`, `cwd` the folder it serves; Windows launch as in residual 1.

Tests (`test/codeMcp.test.mjs`, all failing on the code before): planted `~/.twoody/mcp.json`,
rewritten after approval, swapped between showing and click, environment, no shell, group kill,
app ending, flood, closed input, Windows launch.

### Residual 5 — the other routes that trust an owner session

**Fix (general).** `isThisComputersApp(auth)` (`routes/usage.ts`) now also requires the request to
come from this very machine: `authenticate()` records `thisMachine` (`auth.ts fromThisMachine`:
loopback address, not served by the tunnel, not forwarded by a proxy). Every route and decision that
used it gets the check at once: e-mail (`/email/recent`, `/test`, `/account`, `/sync`, kept
copies), Google data links, Microsoft Graph, Home Assistant settings, bank, capability switches,
order and usage, `local_sync`, usage reports, `local_shares/serve`, isolated projects and their
folders, and the e-mail/bank tools offered to a chat. Before, an owner session from the local
network (`/auth/signin` or `/auth/signup` on a server open to it) or the app's token carried
through the tunnel or a proxy passed.

**Clear cases fixed too** (any token passed before; only the Desktop calls them, on loopback):

| Route | Was | Now |
|---|---|---|
| `POST /local_documents/folders`, `POST /local_documents/personal`, `DELETE /local_documents/folders/:id` | any session, a device paired by code included, could make this server read a folder | this computer's app |
| `DELETE /paired_devices/:id` | any token (a firmware device's too) could revoke any device, the Desktop's own session included | this computer's app |
| `GET /devices/llm_keys` | any token got the server's OpenAI/Anthropic/Gemini keys (null in local-only mode, real on a server outside it); nothing calls it | this computer's app |
| `PUT /home/config` | an empty token kept the stored one even for a new address, and the check sent it there | a new address needs its token again |

Attack tests: `test/thisComputersApp.test.ts` (a device paired by code; the owner's token through
the relay, the local tunnel, a proxy; an owner session from the local network) — failing on the code
before. What the iPhone reads through the tunnel (`/local_capabilities`, `/home`,
`/local_documents/folders`, `/connectors`, `/usage`, `/providers`) is checked to still answer.

**Who is affected.** The Desktop's own session on loopback: nothing changes. The iPhone does not
call any of these (it writes only `POST /home/control`, `PUT /runtime {engine}`, model jobs,
`PATCH /me` preferred computer, approvals, `/peer/vault/anchor`, `/session/device-access`). A Pi
adopted through the account never passed `isThisComputersApp` (its sessions are account or mesh
sessions). What stops working: the Desktop's old « self-hosted » sign-in against a remote server
(hidden since 12/05/2026) for e-mail, Maison, bank, capabilities and shares; a phone paired with a
Pi's setup token without a tunnel key; the Desktop's fallback session from `/session/cli` (already
refused before, `origin = code`).

**Borderline — Jimmy's decision** (left as they are here; since reviewed in `docs/trust-routes-review.md`: the
peers routes, `mayPin`, the share writes, providers writes, `custom_url`, `pair/register` and `system_prompt` are
fixed there with attack tests; `meshRequester`, `/auth/signin` and the rest are listed there for a decision):

| Route | Today | Why not fixed here |
|---|---|---|
| `POST /providers/local`, `PATCH /providers/:id`, `POST /providers/:id/default`, `DELETE /providers/:id` | any token: changes where every chat is sent (local-only mode keeps it to private addresses) | the CLI (`twoody server provider …`) manages them with its own session, possibly on another machine: restricting breaks it. Option: this machine only, or owner session only |
| `PUT /runtime` with `engine: custom` + `custom_url` | any person session (code-paired included) | the iPhone sends `{engine}`; only `custom_url` could be limited to this machine |
| `POST /devices/pair/register` | any token: makes a pairing code that `/session/cli` turns into a session | `twoody pair` (CLI) uses it |
| `POST /peers`, `DELETE /peers/:id`, `GET /peers/:id/vault/identity`, `POST /peers/:id/vault/anchor`; `PATCH /peers/:id` `checked_tunnel_key` (`requireDesktop`: any owner session from anywhere) | pins the vault's trust anchor and mesh links | trust between devices: rule 12, its own review with attack tests. Recommended: `isThisComputersApp` (or this machine) |
| `POST /peer/vault/anchor` `mayPin` | any owner session | same (rule 12) |
| `/local_shares` writes and device approvals (`owner()`: `isThisComputersApp` or `meshRequester`, which takes any owner session from anywhere) | shares folders with other people | the person's own devices are meant to reach it; tighten `meshRequester`'s owner-session branch to this machine — a mesh change (rule 12) |
| `GET /local_documents/folders` | full paths of the granted folders to any device of the person | the iPhone shows them (`LocalDocuments.js`); option: names only for other devices |
| `GET /email/status` | address, IMAP host and user name (no password) to any token | Desktop only today; harmless to restrict, but not a secret |
| `PATCH /me` (`system_prompt`, default provider/model, memory) | any token | the iPhone sets `preferred_computer` there; `system_prompt` could be this machine only |
| `PATCH /built_in_capabilities/:id`, tools | any token | no caller found; decide whether it still lives |
| `/members/*` (voice profiles, face embeddings) | any token | no caller of this server's route found (the iPhone's `/members` goes to the account); restrict or remove |
| `/diagnostics/full`, `/diagnostics/installation` | any person session (tunnel included) | full prompts; the Desktop reads them locally — could be this machine only |
| `/bridge/tasks`, `/bridge/folders*` | any token | CLI and workers |
| `/auth/signin`, `/auth/signup` | password → owner session | such a session from the local network is no longer « this computer's app »; whether sign-in should exist outside loopback at all is a product choice |

## Follow-up, 11 October 2026: residuals 2 and 4 (approved by Jimmy)

### Residual 4 — « Toujours autoriser » for read-only tools only

`src/connectors/connectors.ts mayAlwaysAllow`: a tool may be allowed once and for all only when its
server's MCP annotations say `readOnlyHint: true` and not `destructiveHint: true`. Every other tool —
one that writes, sends, deletes, or whose server says nothing — is asked at every call, whatever was
allowed before.

- The two hints are kept with the listed tools (`StoredTool.annotations`, booleans only: `"true"`
  counts for nothing) and compared at each start like the description and the parameters: a server
  that stops saying a tool only reads loses that tool's grant (`startConnector`).
- `GET /connectors`: each tool says `may_always` and `read_only`; `always` is true only when given
  **and** counting. `PATCH auto_tools` takes only eligible tools, as last listed (a connector not yet
  started has none).
- The chat's `event: approval` says `may_always`; `POST /queries/approval {always: true}` on another
  tool allows that call alone and answers `{ ok: true, always: false }`.
- **No data deleted**: a grant given before to a tool that is not read-only stays in
  `connectors.json`, ignored; one given to a tool listed before the hints were kept (no
  `annotations` yet) is not dropped by the comparison, and counts again once the tool is read again
  and says it only reads. Saving the list from the screen keeps the ignored ones too.
- Desktop (`Chat.tsx`, `ConnectorsPage.tsx`, `connectorInput.ts offerAlways`) and iPhone
  (`ApprovalCard.js`, `utils/chatApprovals.js`): « Toujours autoriser » only where `may_always` is
  true (missing: an older server, hidden); otherwise « Cet outil peut modifier des choses : il demande
  à chaque fois. » (chat) or « Demande à chaque fois : il peut modifier des choses » (« Choisir les
  outils »), in the ten languages.

Attack tests (`test/connectorsSecurity.test.ts`, failing on the code before): a tool that says
nothing, then « always » answered from the chat anyway; a tool that says both read-only and
destructive, hints that are strings; a server that stops saying its tool only reads; a grant stored
before on a tool that is not read-only. Legitimate: `test/connectors.test.ts` (`lookup`, read-only,
always allowed from the list and from the chat).

**Residual risks.**
- The hints are the server's own word: a hostile or taken-over program may call a tool that writes
  « read-only ». Pinning (below) and the comparison at each start narrow it to what the person
  installed.
- A read-only tool can still be talked into a call by a prompt injection, and what it is given goes
  to its service (a search sent to a remote API may carry what the model read).
- Servers that annotate nothing (many today) lose « Toujours autoriser » altogether: every call is
  asked. Which of the 63 catalog services annotate their tools was not checked.

### Residual 2 — `npx`/`uvx` packages pinned at add time (Twoody Desktop)

`twoody-desktop/src/shared/packagePin.ts` (parsing, validation, rewriting) and
`src/main/packageVersion.ts` (IPC `connectors:packageVersion`):

- a command `npx [-y|--yes] pkg`, `npx -p pkg cmd`, `uvx pkg`, `uvx --from pkg cmd` (`npx.cmd`,
  `npx.exe`, a full path too) whose package has no exact version — a name alone or a dist-tag such as
  `@latest` — is pinned before the confirmation: the main process asks npm's registry
  (`https://registry.npmjs.org/<pkg>/<tag>`, scoped names encoded) or PyPI (`info.version`) once, 5 s
  at most, no redirect followed; name and tag are checked there again whatever the page sends; only an
  exact version (semver, PEP 440) is written as `pkg@<version>`. A range, a git or https spec, an
  unknown option, a name with spaces or shell characters is never sent anywhere: said not pinned;
- the confirmation (`commandsToRun`) shows the pinned line exactly; what could not be pinned
  (offline, 404, a bad answer) is said there and left as written, and the connector shows « Version
  non fixée : le paquet téléchargé peut changer à chaque démarrage. » with « Fixer la version »;
- an update is an explicit action: « Mettre à jour » asks for the latest version, says when it is the
  same, otherwise shows « pkg : 1.2.3 → 1.4.0 » and the new exact line to approve, then writes
  `{command, args}` — the server empties « Toujours autoriser » when the arguments change — and
  starts the connector again. Catalog entries (https) are unaffected.

Tests: `twoody-desktop/test/packagePin.test.mjs`, `test/packageVersion.test.mjs` (`npx -y "pkg; rm -rf
~"`, spaces, `..`, URL-like names, a registry answering `1.0.0 && evil` or `../x`, another package's
manifest, offline, 404, timeout).

**Residual risks.** Only the package named is pinned: its own dependencies are resolved by npm or uv
when it is fetched. The version is asked of the public registries, not of a registry the person set
in `~/.npmrc` or `uv.toml` (the pinned version may not exist there: the start fails and says so).
**New data sent**: the Desktop now sends a package's name to registry.npmjs.org or pypi.org when a
connector is added or updated — to be described in the privacy policy before it ships (rule 11,
Jimmy's validation). Twoody Code's MCP servers (`main/code/mcp.ts`) are not pinned. Not run on
Windows nor in the packaged app.

