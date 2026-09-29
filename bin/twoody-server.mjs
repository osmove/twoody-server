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

Twoody Server has no model of its own: run Ollama, llama.cpp's llama-server
or LM Studio next to it and point --llm at it.

On first start it prints a setup token; the Twoody app asks for it to create
the account. Other settings (TWOODY_PAIRING_CODE, TWOODY_ADMIN_TOKEN, …) are
environment variables, listed in the README.`;

function fail(message) {
  console.error(`twoody-server: ${message}\nRun twoody-server --help for the options.`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const ACCOUNT_COMMANDS = new Set(["login", "approve", "logout"]);
const command = ACCOUNT_COMMANDS.has(argv[0]) ? argv[0] : null;
const args = command ? argv.slice(1) : argv;
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

if (command) {
  const { runAccountCommand } = await import(pathToFileURL(join(root, "dist", "cli", "account.js")).href);
  process.exit(await runAccountCommand(command, rest));
}

// The environment is set: the server reads it as its modules load.
await import(pathToFileURL(join(root, "dist", "index.js")).href);
