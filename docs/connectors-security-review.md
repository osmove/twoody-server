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

1. **Windows**: without a shell, `npx`/`npm` (which are `.cmd` files) do not start (`ENOENT`, or
   `EINVAL` since Node refuses `.cmd`/`.bat` without a shell). Safe, but connectors through `npx`
   do not work on Windows today. Enabling them through `cmd.exe` brings its quoting flaws
   (« BatBadBut »); the sound way is to resolve `npx` to `node <npm>/bin/npx-cli.js`. Group kill
   on Windows (`taskkill /T`) is written but not run on a Windows machine (tests skip there).
2. **Unpinned packages**: `npx -y pkg` fetches whatever is published at each start. Fix 2 re-asks
   when tools change, not when behaviour does. Option: warn in the Desktop when a package has no
   `@version`, or pin at add time.
3. **No sandbox**: the program has the person's rights (files, network, `local.db`). A sandbox
   (macOS `sandbox-exec` is deprecated; containers) is a product decision.
4. **« Toujours autoriser » and prompt injection**: an always-allowed tool runs without asking when
   a document, an e-mail, a web page or another tool's result talks the model into it. By design;
   options: offer it only for read-only tools, or for the session only.
5. **Other routes still trust `isThisComputersApp` alone** (e-mail, usage, documents…). The owner's
   password typed on another device of the local network (server open to it) gives such a session.
   Generalising the loopback check of fix 4 is worth a separate pass.
6. **Abrupt end**: if the server is killed without its `exit` handler (SIGKILL, Windows
   `TerminateProcess` from the Desktop), programs only see their input close; most MCP servers end
   then, not all.
7. **Twoody Code's MCP servers** (`twoody-desktop/src/main/code/mcp.ts`) are a separate path: a
   project's `.mcp.json` is fingerprint-approved (good), `~/.twoody/mcp.json` is trusted as is, and
   fixes 6 to 8 are not applied there yet.
8. **Tokens in `connectors.json`** are plain text (0600), not in the system keychain.
