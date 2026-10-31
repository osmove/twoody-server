import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// `twoody-server api-key create [name] | list | revoke <id>`
// (bin/twoody-server.mjs): the local API keys of the server running on this
// machine, asked on loopback as its console (or with TWOODY_ADMIN_TOKEN).
// Made for a server without the app — in Docker, `docker exec <container>
// twoody-server api-key create "my script"` — where nobody may have set
// the server up yet: `create` then gives the setup token from the data
// directory, and the server makes its owner (routes/developerApi.ts).

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.TWOODY_DATA_DIR ?? join(homedir(), ".twoody", "data");

type Answer = { status: number; body: any };

function setupToken(): string | null {
  try {
    return readFileSync(join(DATA_DIR, "setup-token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function ask(path: string, init: { method?: string; body?: unknown; setupToken?: string | null } = {}): Promise<Answer | null> {
  const admin = process.env.TWOODY_ADMIN_TOKEN?.trim();
  try {
    const response = await globalThis.fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(admin ? { Authorization: `Bearer ${admin}` } : {}),
        ...(init.setupToken ? { "X-Twoody-Setup-Token": init.setupToken } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  }
}

function refused(what: string, answer: Answer | null): number {
  if (!answer) {
    console.error(`${what}: Twoody Server does not answer on port ${PORT}. Start it first (or give its port with -p).`);
    return 1;
  }
  console.error(`${what}: ${answer.body?.message ?? answer.body?.error ?? `HTTP ${answer.status}`}`);
  return 1;
}

async function create(name: string | undefined): Promise<number> {
  const body = { name: name?.trim() || "API key" };
  let made = await ask("/api/v1/api_keys", { method: "POST", body });
  if (made?.status === 409 && made.body?.error === "setup_required") {
    const token = setupToken();
    if (!token) {
      console.error(`This server has no owner yet, and no setup token in ${DATA_DIR}: run this command where the server keeps its data (-d).`);
      return 1;
    }
    made = await ask("/api/v1/api_keys", { method: "POST", body, setupToken: token });
    if (made?.status === 201) console.error("This server had no owner yet: made with its setup token, as the Twoody app does at first launch.");
  }
  if (!made || made.status !== 201) return refused("Could not make the key", made);
  console.log(made.body.token);
  console.error(`Shown once: keep it now. API: http://127.0.0.1:${PORT}/v1 — revoke with \`twoody-server api-key revoke ${made.body.api_key?.id}\`.`);
  return 0;
}

async function list(): Promise<number> {
  const answer = await ask("/api/v1/api_keys");
  if (!answer || answer.status !== 200) return refused("Could not list the keys", answer);
  const keys = (answer.body?.api_keys ?? []) as Array<{ id: string; name: string; prefix: string; last_used_at: number | null; revoked_at: number | null }>;
  if (keys.length === 0) {
    console.log("No API key yet: twoody-server api-key create <name>.");
    return 0;
  }
  for (const key of keys) {
    const state = key.revoked_at ? "revoked" : key.last_used_at ? `used ${new Date(key.last_used_at).toISOString()}` : "never used";
    console.log(`  ${key.id}  ${key.prefix}…  ${key.name.padEnd(28)} ${state}`);
  }
  return 0;
}

async function revoke(id: string | undefined): Promise<number> {
  if (!id) {
    console.error("Which key? twoody-server api-key revoke <id> (see twoody-server api-key list).");
    return 2;
  }
  const answer = await ask(`/api/v1/api_keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (answer?.status === 404) {
    console.error(`No API key ${id} here.`);
    return 1;
  }
  if (!answer || answer.status !== 204) return refused("Could not revoke the key", answer);
  console.log(`Revoked ${id}.`);
  return 0;
}

export async function runApiKeyCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "create") return create(rest.join(" "));
  if (sub === "list") return list();
  if (sub === "revoke") return revoke(rest[0]);
  console.error("Usage: twoody-server api-key create [name] | list | revoke <id>");
  return 2;
}
