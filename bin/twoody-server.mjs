#!/usr/bin/env node
// The `twoody-server` command installed by `npm install -g twoody-server`
// (and run by the `twoody` npm and PyPI packages).
//
// It only turns a few command-line options into the environment variables
// the server already reads, then starts it. Everything else is configured
// through the environment, as documented in the README.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function version() {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const HELP = `twoody-server ${version()} — the Twoody server, without the desktop app

Usage: twoody-server [options]
       twoody-server login     add this server to your Twoody account (a code
                               to enter on a signed-in device)
       twoody-server approve [id] [--deny]
                               allow (or refuse) a device waiting for access
       twoody-server logout [--force]
                               take this server out of the account (--force:
                               here too when the account does not confirm)
       twoody-server config get [key] | config set runtime=<engine> [key=value…]
                               this computer's engine (« Moteur »): builtin,
                               ollama, lmstudio, mlx, auto or an http(s) address;
                               also default_model, idle_minutes, ctx, threads
       twoody-server runtime install [--force] | runtime status
                               the built-in llama.cpp runtime (pinned, checked
                               against its SHA-256), and what runs now
       twoody-server models list | add <id> [--force] | rm <id>
                               the models of the built-in runtime
       twoody-server api-key create [name] | list | revoke <id>
                               keys for the OpenAI-compatible API at
                               http://127.0.0.1:<port>/v1 (create makes the
                               server's owner first if nobody has set it up)

Options:
  -p, --port <port>         port to listen on (default 3000, or $PORT)
      --host <address>      address to bind (default 0.0.0.0, or $HOST)
  -d, --data-dir <path>     where the database and the setup token live
                            (default ~/.twoody/data, or $TWOODY_DATA_DIR)
      --llm <url>           OpenAI-compatible /v1 address of a model runtime,
                            e.g. http://127.0.0.1:11434/v1 for Ollama
                            (or $BRIDGE_LOCAL_LLM_ENDPOINT)
      --pairing-code <code> 8 letters/digits a second phone pairs with once
                            the account exists (or $TWOODY_PAIRING_CODE)
      --local-only          refuse every call outside this machine and the
                            private network (TWOODY_LOCAL_ONLY=1)
      --no-bonjour          do not advertise the server on the network
  -v, --version             print the version
  -h, --help                print this help

Models: \`twoody-server runtime install\`, then \`twoody-server models add
Qwen3.5-4B-Q4_K_M\` runs llama.cpp here, started on the first question (a
Raspberry Pi 5 included). Or run Ollama, LM Studio or another OpenAI-compatible
runtime next to it: the engine « auto » finds it, or point --llm at it.

On first start it prints a setup token; the Twoody app asks for it to create
the account. Other settings (TWOODY_PAIRING_CODE, TWOODY_ADMIN_TOKEN, …) are
environment variables, listed in the README.`;

function fail(message) {
  console.error(`twoody-server: ${message}\nRun twoody-server --help for the options.`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const ACCOUNT_COMMANDS = new Set(["login", "approve", "logout"]);
// Engine commands take their own options (--archive, --force, key=value):
// only -p/--port and -d/--data-dir are read here, the rest is theirs.
const RUNTIME_COMMANDS = new Set(["config", "runtime", "models"]);
// `api-key create "my script"`: its words are the key's name.
const KEY_COMMANDS = new Set(["api-key"]);
// The command is the first word, or follows -p/-d given before it
// (twoody-server -d /srv/twoody models list).
let at = 0;
while (at < argv.length && /^(-p|--port|-d|--data-dir)$/.test(argv[at])) at += 2;
while (at < argv.length && /^(--port|--data-dir)=/.test(argv[at])) at += 1;
const command = ACCOUNT_COMMANDS.has(argv[at]) || RUNTIME_COMMANDS.has(argv[at]) || KEY_COMMANDS.has(argv[at]) ? argv[at] : null;
const args = command ? [...argv.slice(0, at), ...argv.slice(at + 1)] : argv;
const rest = [];
for (let i = 0; i < args.length; i++) {
  let arg = args[i];
  let inline = null;
  const eq = arg.indexOf("=");
  if (arg.startsWith("--") && eq > 0) {
    inline = arg.slice(eq + 1);
    arg = arg.slice(0, eq);
  }
  const value = () => {
    if (inline !== null) return inline;
    const next = args[i + 1];
    if (next === undefined || next.startsWith("-")) fail(`${arg} needs a value`);
    i++;
    return next;
  };
  switch (arg) {
    case "-h":
    case "--help":
      console.log(HELP);
      process.exit(0);
    case "-v":
    case "--version":
      console.log(version());
      process.exit(0);
    case "-p":
    case "--port": {
      const port = value();
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) fail(`invalid port: ${port}`);
      process.env.PORT = port;
      break;
    }
    case "--host":
      process.env.HOST = value();
      break;
    case "-d":
    case "--data-dir":
      process.env.TWOODY_DATA_DIR = resolve(value());
      break;
    case "--llm":
      process.env.BRIDGE_LOCAL_LLM_ENDPOINT = value();
      break;
    case "--pairing-code":
      process.env.TWOODY_PAIRING_CODE = value();
      break;
    case "--local-only":
      process.env.TWOODY_LOCAL_ONLY = "1";
      break;
    case "--no-bonjour":
      process.env.TWOODY_BONJOUR_DISABLED = "1";
      break;
    default:
      if (RUNTIME_COMMANDS.has(command) || KEY_COMMANDS.has(command)) {
        rest.push(args[i]);
        break;
      }
      if (command && !args[i].startsWith("-") || command && args[i] === "--deny") {
        rest.push(args[i]);
        break;
      }
      fail(`unknown option: ${args[i]}`);
  }
}

const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  console.error(`twoody-server needs Node.js 22 or later (this is ${process.versions.node}).`);
  process.exit(1);
}

if (command && RUNTIME_COMMANDS.has(command)) {
  const { runRuntimeCommand } = await import(pathToFileURL(join(root, "dist", "cli", "runtime.js")).href);
  process.exit(await runRuntimeCommand(command, rest));
}

if (command && KEY_COMMANDS.has(command)) {
  const { runApiKeyCommand } = await import(pathToFileURL(join(root, "dist", "cli", "apiKeys.js")).href);
  process.exit(await runApiKeyCommand(rest));
}

if (command) {
  const { runAccountCommand } = await import(pathToFileURL(join(root, "dist", "cli", "account.js")).href);
  process.exit(await runAccountCommand(command, rest));
}

// The environment is set: the server reads it as its modules load.
await import(pathToFileURL(join(root, "dist", "index.js")).href);
