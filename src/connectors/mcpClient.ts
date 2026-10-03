import { spawn, type ChildProcess } from "node:child_process";
import { outboundFetch } from "../outbound.js";

// A Model Context Protocol client for « Connecteurs » (Capacités, Jimmy,
// 03/10/2026): a server started on this computer (a command, over stdio,
// newline-delimited JSON-RPC 2.0, as Claude Desktop starts them) or one on
// the Web (Streamable HTTP: each message POSTed, the answer as JSON or as
// an event stream). Tools only: listed, then called on the person's say.
// Ported from Twoody Code's client (twoody-desktop src/main/code/mcp.ts).

const PROTOCOL_VERSION = "2025-06-18";
const INIT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
export const MAX_RESULT_CHARS = 12_000;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface RpcMessage { jsonrpc?: string; id?: number | string; method?: string; result?: unknown; error?: { message?: string } }

export interface McpTransportConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /// The access token of a signed-in connector (connectors/oauth.ts), and a
  /// fresh one when the server refused it (null: none).
  bearer?: () => Promise<string | null>;
  renewBearer?: () => Promise<string | null>;
}

/// The server wants a sign-in (HTTP 401), and says where in `wwwAuthenticate`.
export class McpAuthRequiredError extends Error {
  constructor(public wwwAuthenticate: string | null) {
    super("the service asks you to sign in");
  }
}

/// One connection to an MCP server.
export interface McpConnection {
  start(): Promise<void>;
  request(method: string, params: object, timeoutMs?: number): Promise<unknown>;
  stop(): void;
  readonly running: boolean;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

class StdioConnection implements McpConnection {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private stderr = "";

  constructor(private readonly config: McpTransportConfig) {}

  get running() {
    return this.child !== null;
  }

  async start() {
    // The person's PATH, so that npx, uvx or docker are found as in a terminal.
    const env = { ...process.env, PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":"), ...(this.config.env ?? {}) };
    const child = spawn(this.config.command!, this.config.args ?? [], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.receive(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2_000);
    });
    const failAll = (message: string) => {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(message));
        this.pending.delete(id);
      }
    };
    child.on("error", (err) => {
      this.child = null;
      failAll(`the server could not start: ${err.message}`);
    });
    child.on("exit", (code) => {
      this.child = null;
      failAll(`the server stopped (exit ${code})${this.stderr ? `: ${this.stderr.trim().split("\n").pop()}` : ""}`);
    });
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        continue;
      }
      if (message.method && message.id !== undefined) {
        // A request from the server: a ping is answered, the rest declined.
        this.write(message.method === "ping" ? { jsonrpc: "2.0", id: message.id, result: {} } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported by Twoody" } });
        continue;
      }
      if (typeof message.id !== "number") continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message ?? "MCP error"));
      else entry.resolve(message.result);
    }
  }

  private write(message: object) {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: object, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error("the server is not running"));
    if (method.startsWith("notifications/")) {
      this.write({ jsonrpc: "2.0", method, params });
      return Promise.resolve(null);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer from the server after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  stop() {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.child?.kill("SIGTERM");
    this.child = null;
  }
}

/// The JSON-RPC answer to `id` in an event stream's text.
export function answerFromEventStream(text: string, id: number): RpcMessage | null {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try {
      const message = JSON.parse(data) as RpcMessage | RpcMessage[];
      for (const one of Array.isArray(message) ? message : [message]) if (one?.id === id) return one;
    } catch {
      // not JSON: skipped
    }
  }
  return null;
}

class HttpConnection implements McpConnection {
  private nextId = 1;
  private session: string | null = null;
  private started = false;

  constructor(private readonly config: McpTransportConfig, private readonly fetchImpl: typeof outboundFetch = outboundFetch) {}

  get running() {
    return this.started;
  }

  async start() {
    this.started = true;
  }

  async request(method: string, params: object, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const notification = method.startsWith("notifications/");
    const id = notification ? undefined : this.nextId++;
    const send = (bearer: string | null) => this.fetchImpl(this.config.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
        ...(this.config.headers ?? {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let response = await send((await this.config.bearer?.()) ?? null);
    // Refused: the token is renewed once, then a sign-in is asked for.
    if (response.status === 401 && this.config.renewBearer) {
      const renewed = await this.config.renewBearer().catch(() => null);
      if (renewed) response = await send(renewed);
    }
    const session = response.headers.get("mcp-session-id");
    if (session) this.session = session;
    if (response.status === 401) throw new McpAuthRequiredError(response.headers.get("www-authenticate"));
    if (response.status === 403) throw new Error("the server refused the connection (HTTP 403): check its token or its rights");
    if (!response.ok && response.status !== 202) throw new Error(`the server answered HTTP ${response.status}`);
    if (notification || response.status === 202) return null;
    const type = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const message = type.includes("text/event-stream") ? answerFromEventStream(text, id!) : (JSON.parse(text) as RpcMessage);
    if (!message) throw new Error("the server sent no answer");
    if (message.error) throw new Error(message.error.message ?? "MCP error");
    return message.result;
  }

  stop() {
    this.started = false;
    this.session = null;
  }
}

/// A server, started and ready for tools/list and tools/call.
export class McpClient {
  private readonly connection: McpConnection;

  constructor(config: McpTransportConfig, options: { fetchImpl?: typeof outboundFetch } = {}) {
    this.connection = config.url ? new HttpConnection(config, options.fetchImpl) : new StdioConnection(config);
  }

  get running() {
    return this.connection.running;
  }

  async start(): Promise<void> {
    await this.connection.start();
    await this.connection.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "Twoody", version: "1" } }, INIT_TIMEOUT_MS);
    await this.connection.request("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = (await this.connection.request("tools/list", cursor ? { cursor } : {})) as { tools?: McpToolInfo[]; nextCursor?: string } | null;
      tools.push(...(result?.tools ?? []).filter((tool) => tool && typeof tool.name === "string"));
      if (!result?.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = (await this.connection.request("tools/call", { name: tool, arguments: args })) as {
      content?: Array<{ type?: string; text?: string; resource?: { text?: string; uri?: string } }>;
      isError?: boolean;
      structuredContent?: unknown;
    } | null;
    const parts = (result?.content ?? []).map((part) =>
      part.type === "text"
        ? (part.text ?? "")
        : part.type === "resource"
          ? (part.resource?.text ?? `[resource ${part.resource?.uri ?? ""}]`)
          : `[${part.type ?? "content"} not shown: text only]`,
    );
    let text = parts.join("\n").trim();
    if (!text && result?.structuredContent !== undefined) text = JSON.stringify(result.structuredContent, null, 2);
    if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n… [cut]`;
    return { text: text || "(empty result)", isError: result?.isError === true };
  }

  stop() {
    this.connection.stop();
  }
}
