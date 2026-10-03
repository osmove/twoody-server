import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../db.js";
import { McpClient, type McpToolInfo, type McpTransportConfig } from "./mcpClient.js";

// « Connecteurs » in Capacités (Jimmy, 03/10/2026): the person's services
// — Notion, GitHub, a database, a home tool… — through MCP servers, whose
// tools the chat may use, each call asked first in the chat
// (`waitForApproval`, answered by POST /queries/approval).
//
// Added only from this computer's app: a connector is a command this
// computer runs, or an address it calls with the person's token. Kept
// apart from the preferences, in DATA_DIR/connectors.json (0600): the
// values of its environment and headers (tokens) never come back to a
// screen, only their names.

export interface StoredTool { name: string; description: string; inputSchema: Record<string, unknown> }

export interface Connector {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  /// The tools the person turned off.
  disabled_tools: string[];
  /// Its tools when it last started, offered to the chat without starting it.
  tools: StoredTool[];
  error: string | null;
  created_at: string;
}

export class ConnectorError extends Error {
  constructor(public code: string, public status = 422) {
    super(code);
  }
}

const FILE = () => join(DATA_DIR, "connectors.json");
/// Tools offered to a chat in all: each costs tokens in every message.
export const MAX_CHAT_TOOLS = 40;
const DESCRIPTION_CHARS = 500;

function readAll(): Record<string, Connector[]> {
  try {
    const parsed = JSON.parse(readFileSync(FILE(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Connector[]>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Connector[]>) {
  writeFileSync(FILE(), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function listConnectors(userId: string): Connector[] {
  return (readAll()[userId] ?? []).filter((connector) => connector && typeof connector.id === "string");
}

function saveConnectors(userId: string, connectors: Connector[]) {
  const all = readAll();
  all[userId] = connectors;
  writeAll(all);
}

function update(userId: string, id: string, change: (connector: Connector) => Connector): Connector {
  const connectors = listConnectors(userId);
  const index = connectors.findIndex((connector) => connector.id === id);
  if (index < 0) throw new ConnectorError("not_found", 404);
  connectors[index] = change(connectors[index]!);
  saveConnectors(userId, connectors);
  return connectors[index]!;
}

const stringMap = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/^[A-Za-z_][A-Za-z0-9_-]{0,100}$/.test(key) && typeof raw === "string") out[key] = raw.slice(0, 4_000);
  }
  return Object.keys(out).length ? out : undefined;
};

/// A connector as asked: a name, and a command (with its arguments and
/// environment) or an https address (with its headers).
export function readConnectorInput(body: unknown, existing?: Connector): Pick<Connector, "name" | "command" | "args" | "env" | "url" | "headers"> {
  const input = (body && typeof body === "object" ? (body as { connector?: unknown }).connector ?? body : {}) as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : existing?.name ?? "";
  if (!name) throw new ConnectorError("name_required");
  const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : undefined;
  const command = typeof input.command === "string" && input.command.trim() ? input.command.trim() : undefined;
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConnectorError("invalid_url");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) throw new ConnectorError("https_required");
    // Headers left out keep theirs (the token is never sent back to show).
    return { name, url, headers: input.headers === undefined ? existing?.headers : stringMap(input.headers) };
  }
  if (!command) throw new ConnectorError("command_or_url_required");
  const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string").map((arg) => arg.slice(0, 2_000)).slice(0, 50) : [];
  return { name, command: command.slice(0, 500), args, env: input.env === undefined ? existing?.env : stringMap(input.env) };
}

export function addConnector(userId: string, body: unknown): Connector {
  const connectors = listConnectors(userId);
  if (connectors.length >= 20) throw new ConnectorError("too_many");
  const connector: Connector = { id: randomUUID(), ...readConnectorInput(body), enabled: true, disabled_tools: [], tools: [], error: null, created_at: new Date().toISOString() };
  saveConnectors(userId, [...connectors, connector]);
  return connector;
}

export function changeConnector(userId: string, id: string, body: unknown): Connector {
  const input = (body && typeof body === "object" ? (body as { connector?: unknown }).connector ?? body : {}) as Record<string, unknown>;
  const changed = update(userId, id, (connector) => {
    let next = connector;
    if (typeof input.name === "string" || input.command !== undefined || input.url !== undefined) {
      // A new command or address replaces the old one; a new name alone keeps it.
      const base = input.command !== undefined || input.url !== undefined ? { name: connector.name } : { name: connector.name, command: connector.command, args: connector.args, url: connector.url };
      const how = readConnectorInput({ ...base, ...input }, connector);
      next = { ...next, command: undefined, args: undefined, env: undefined, url: undefined, headers: undefined, ...how, tools: [], error: null };
    }
    if (typeof input.enabled === "boolean") next = { ...next, enabled: input.enabled };
    if (Array.isArray(input.disabled_tools)) next = { ...next, disabled_tools: input.disabled_tools.filter((tool): tool is string => typeof tool === "string").slice(0, 500) };
    return next;
  });
  stopConnector(userId, id);
  return changed;
}

export function removeConnector(userId: string, id: string) {
  const connectors = listConnectors(userId);
  if (!connectors.some((connector) => connector.id === id)) throw new ConnectorError("not_found", 404);
  stopConnector(userId, id);
  saveConnectors(userId, connectors.filter((connector) => connector.id !== id));
}

/// What a screen shows: never a value of its environment or headers.
export function connectorView(userId: string, connector: Connector) {
  return {
    id: connector.id,
    name: connector.name,
    kind: connector.url ? "http" : "command",
    command: connector.command ?? null,
    args: connector.args ?? [],
    url: connector.url ?? null,
    env_keys: Object.keys(connector.env ?? {}),
    header_keys: Object.keys(connector.headers ?? {}),
    enabled: connector.enabled,
    running: clients.get(runningKey(userId, connector.id))?.client.running === true,
    error: connector.error,
    tools: connector.tools.map((tool) => ({ name: tool.name, description: tool.description, enabled: !connector.disabled_tools.includes(tool.name) })),
  };
}

// ── Running ────────────────────────────────────────────────────────────
const clients = new Map<string, { client: McpClient; userId: string }>();
let makeClient = (config: McpTransportConfig) => new McpClient(config);

/// For the tests: a client that does not start a process.
export function useClientForTests(factory: (config: McpTransportConfig) => McpClient) {
  makeClient = factory;
}

function runningKey(userId: string, id: string) {
  return `${userId}:${id}`;
}

export function stopConnector(userId: string, id: string) {
  const running = clients.get(runningKey(userId, id));
  running?.client.stop();
  clients.delete(runningKey(userId, id));
}

/// Started (once), its tools read again and kept.
export async function startConnector(userId: string, id: string): Promise<{ client: McpClient; connector: Connector }> {
  const connector = listConnectors(userId).find((one) => one.id === id);
  if (!connector) throw new ConnectorError("not_found", 404);
  const running = clients.get(runningKey(userId, id));
  if (running?.client.running) return { client: running.client, connector };
  const client = makeClient({ command: connector.command, args: connector.args, env: connector.env, url: connector.url, headers: connector.headers });
  try {
    await client.start();
    const listed = await client.listTools();
    clients.set(runningKey(userId, id), { client, userId });
    const tools = listed.slice(0, 200).map((tool: McpToolInfo) => ({
      name: tool.name,
      description: (tool.description ?? "").slice(0, 2_000),
      inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
    }));
    const updated = update(userId, id, (stored) => ({ ...stored, tools, error: null }));
    return { client, connector: updated };
  } catch (err) {
    client.stop();
    const message = err instanceof Error ? err.message : String(err);
    update(userId, id, (stored) => ({ ...stored, error: message.slice(0, 300) }));
    throw new ConnectorError(`start_failed: ${message.slice(0, 200)}`, 502);
  }
}

// ── In the chat ────────────────────────────────────────────────────────

/// A name the model can call: letters, digits, _ and -, 64 at most.
export function chatToolName(connector: Pick<Connector, "name">, tool: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${clean(connector.name).slice(0, 20)}__${clean(tool)}`.slice(0, 64);
}

export interface ConnectorChatTool {
  definition: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
  connectorId: string;
  connectorName: string;
  tool: string;
}

/// The tools of the connectors switched on, as the chat offers them: the
/// same from one message to the next (the runtime's cache), MAX_CHAT_TOOLS
/// at most.
export function connectorChatTools(userId: string): ConnectorChatTool[] {
  const out: ConnectorChatTool[] = [];
  for (const connector of listConnectors(userId)) {
    if (!connector.enabled) continue;
    for (const tool of connector.tools) {
      if (connector.disabled_tools.includes(tool.name) || out.length >= MAX_CHAT_TOOLS) continue;
      out.push({
        definition: {
          type: "function",
          function: {
            name: chatToolName(connector, tool.name),
            description: `[${connector.name}] ${tool.description || tool.name}`.slice(0, DESCRIPTION_CHARS),
            parameters: tool.inputSchema,
          },
        },
        connectorId: connector.id,
        connectorName: connector.name,
        tool: tool.name,
      });
    }
  }
  return out;
}

/// Calls a connector's tool (started if it is not).
export async function callConnectorTool(userId: string, connectorId: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const { client } = await startConnector(userId, connectorId);
  try {
    return await client.callTool(tool, args);
  } catch (err) {
    // A server that stopped is started again at the next call.
    if (!client.running) stopConnector(userId, connectorId);
    throw err;
  }
}

// ── The person's say, asked in the chat ────────────────────────────────
const APPROVAL_TIMEOUT_MS = 120_000;
const approvals = new Map<string, { userId: string; resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }>();

/// Waits for the person to allow or refuse this call (or for the chat to
/// close, or two minutes): refused unless allowed.
export function waitForApproval(userId: string, id: string, signal?: AbortSignal, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (allowed: boolean) => {
      const entry = approvals.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      approvals.delete(id);
      resolve(allowed);
    };
    approvals.set(id, { userId, resolve: done, timer: setTimeout(() => done(false), timeoutMs) });
    signal?.addEventListener("abort", () => done(false), { once: true });
  });
}

/// The calls waiting for this person's answer (their ids).
export function waitingApprovals(userId: string): string[] {
  return [...approvals].filter(([, entry]) => entry.userId === userId).map(([id]) => id);
}

/// The person's answer; false when nothing waits for it (too late, or not theirs).
export function answerApproval(userId: string, id: string, allowed: boolean): boolean {
  const entry = approvals.get(id);
  if (!entry || entry.userId !== userId) return false;
  entry.resolve(allowed);
  return true;
}
