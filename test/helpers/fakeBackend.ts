import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A small stand-in for twoody-backend's account endpoints (Lot 1 of
// docs/multi-computer-design.md, as twoody-backend 7e6d25f9 implements
// them): device-code logins, the account's computers, heartbeat, pending
// requests with role and endorsements, decide / result / consume, endorse.
// One account; the user token is `userToken`.

export interface FakeComputer {
  id: number;
  name: string;
  public_key: string;
  kind: "desktop" | "server";
  platform: string | null;
  credential: string;
  approver_keys: string[];
  status: unknown;
  last_seen_at: string | null;
  heartbeats: number;
}

export interface FakeAuthorization {
  id: number;
  computer_id: number;
  name: string;
  public_key: string;
  role: "device" | "peer";
  state: "pending" | "approved" | "denied" | "consumed";
  sealed_response: string | null;
  expires_at: string;
  endorsements: Array<{ approver_key: string; endorsement: string }>;
}

export interface FakeLogin {
  device_code: string;
  user_code: string;
  name: string;
  platform: string | null;
  public_key: string;
  device_token: string;
  state: "pending" | "approved" | "denied" | "delivered";
  expires_at: number;
  approver: { kind: string | null; public_key: string | null; name: string } | null;
  computer_id: number | null;
  polls: number;
  /// Answer slow_down to the next poll (then pending as usual).
  slowDownNext?: boolean;
}

export interface FakeBackend {
  url: string;
  userToken: string;
  computers: FakeComputer[];
  authorizations: FakeAuthorization[];
  logins: FakeLogin[];
  calls: string[];
  /// The X-Device-Token each call carried ("" when none), in step with `calls`.
  deviceTokens: string[];
  /// Added to an approved login's poll answer (e.g. {account: {email}}).
  pollExtras: Record<string, unknown>;
  /// Adds a computer as if created by the Desktop (POST /account_computers).
  addComputer(args: { name: string; public_key: string; kind?: "desktop" | "server"; approver_keys?: string[] }): FakeComputer;
  approveLogin(userCode: string, approver?: { kind: "computer" | "phone"; public_key: string; name?: string } | null): void;
  denyLogin(userCode: string): void;
  fetch: typeof fetch;
  close(): Promise<void>;
}

const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

function userCode(): string {
  const pick = () => ALPHABET[randomBytes(1)[0]! % ALPHABET.length];
  return `${Array.from({ length: 4 }, pick).join("")}-${Array.from({ length: 4 }, pick).join("")}`;
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

export async function startFakeBackend(options: { userToken?: string; loginLifetimeMs?: number; minPollGapMs?: number } = {}): Promise<FakeBackend> {
  const userToken = options.userToken ?? "user-token-of-the-account";
  const computers: FakeComputer[] = [];
  const authorizations: FakeAuthorization[] = [];
  const logins: FakeLogin[] = [];
  const calls: string[] = [];
  const deviceTokens: string[] = [];
  const pollExtras: Record<string, unknown> = {};
  let nextId = 40;
  let nextRid = 300;

  const publicComputer = (c: FakeComputer) => ({
    id: c.id,
    name: c.name,
    public_key: c.public_key,
    online: c.last_seen_at !== null && Date.now() - Date.parse(c.last_seen_at) < 90_000,
    kind: c.kind,
    platform: c.platform,
    host_id: null,
    last_seen_at: c.last_seen_at,
    approval: c.kind === "server" ? "delegated" : "host",
    approver_keys: c.approver_keys,
    status: c.status ?? null,
  });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    calls.push(`${req.method} ${path}`);
    deviceTokens.push(String(req.headers["x-device-token"] ?? ""));
    const json = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const user = req.headers["x-user-token"] === userToken;
    const credential = String(req.headers["x-computer-credential"] ?? "");
    const body = req.method === "POST" || req.method === "PATCH" ? await readBody(req) : {};

    if (req.method === "POST" && path === "/computer_logins") {
      if (!/^[0-9a-f]{64}$/.test(String(body.public_key)) || !body.device_token) return json(422, { error: "invalid_request" });
      const login: FakeLogin = {
        device_code: randomBytes(16).toString("hex"),
        user_code: userCode(),
        name: String(body.name ?? ""),
        platform: body.platform ?? null,
        public_key: body.public_key,
        device_token: body.device_token,
        state: "pending",
        expires_at: Date.now() + (options.loginLifetimeMs ?? 600_000),
        approver: null,
        computer_id: null,
        polls: 0,
      };
      logins.push(login);
      return json(201, {
        device_code: login.device_code,
        user_code: login.user_code,
        verification_uri: "https://twoody.com/appareil",
        verification_uri_complete: `https://twoody.com/appareil?code=${login.user_code}`,
        expires_in: Math.ceil((login.expires_at - Date.now()) / 1000),
        interval: 5,
      });
    }
    if (req.method === "POST" && path === "/computer_logins/poll") {
      const login = logins.find((l) => l.device_code === body.device_code);
      if (!login || login.state === "delivered") return json(410, { error: "expired" });
      login.polls += 1;
      if (login.state === "denied") return json(403, { error: "denied" });
      if (login.expires_at <= Date.now()) return json(410, { error: "expired" });
      if (login.slowDownNext) {
        login.slowDownNext = false;
        return json(429, { error: "slow_down" });
      }
      if (login.state === "pending") return json(200, { state: "pending" });
      const computer = computers.find((c) => c.id === login.computer_id)!;
      computer.credential = randomBytes(16).toString("hex");
      login.state = "delivered";
      return json(200, {
        state: "approved",
        account_id: 7,
        user_token: userToken,
        computer: { id: computer.id, name: computer.name, public_key: computer.public_key },
        credential: computer.credential,
        approver: login.approver ?? { kind: null, public_key: null, name: "twoody.com" },
        ...pollExtras,
      });
    }
    if (!user) return json(401, { error: "unauthorized" });

    if (req.method === "GET" && path === "/account_computers") {
      return json(200, { account_id: 7, computers: computers.map(publicComputer) });
    }
    const match = /^\/account_computers\/(\d+)(\/.*)?$/.exec(path);
    const computer = match ? computers.find((c) => c.id === Number(match[1])) : undefined;
    if (!match || !computer) return json(404, { error: "not_found" });
    const sub = match[2] ?? "";
    const host = credential === computer.credential;

    if (req.method === "DELETE" && sub === "") {
      computers.splice(computers.indexOf(computer), 1);
      return json(204);
    }
    if (req.method === "POST" && sub === "/heartbeat") {
      if (!host) return json(403);
      computer.last_seen_at = new Date().toISOString();
      computer.heartbeats += 1;
      if (body.status) computer.status = body.status;
      if (body.platform) computer.platform = body.platform;
      return json(204);
    }
    if (req.method === "GET" && sub === "/pending") {
      if (!host) return json(403);
      const live = authorizations.filter((a) => a.computer_id === computer.id && a.state === "pending" && Date.parse(a.expires_at) > Date.now());
      return json(200, {
        requests: live.map((a) => ({ id: a.id, name: a.name, public_key: a.public_key, expires_at: a.expires_at, role: a.role, endorsements: a.endorsements })),
      });
    }
    if (req.method === "POST" && sub === "/request_access") {
      const a: FakeAuthorization = {
        id: nextRid++,
        computer_id: computer.id,
        name: String(body.name ?? "").trim(),
        public_key: String(body.public_key ?? ""),
        role: body.role === "peer" ? "peer" : "device",
        state: "pending",
        sealed_response: null,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        endorsements: [],
      };
      if (!/^[0-9a-f]{64}$/.test(a.public_key) || !a.name) return json(422, { error: "invalid_request" });
      authorizations.push(a);
      return json(201, { id: a.id, expires_at: a.expires_at, role: a.role, computer: publicComputer(computer) });
    }
    const auth = /^\/authorizations\/(\d+)(\/\w+)?$/.exec(sub);
    const authorization = auth ? authorizations.find((a) => a.id === Number(auth[1]) && a.computer_id === computer.id) : undefined;
    if (!auth || !authorization) return json(404, { error: "not_found" });
    const action = auth[2] ?? "";
    if (req.method === "POST" && action === "/decide") {
      if (!host) return json(403);
      if (Date.parse(authorization.expires_at) <= Date.now()) return json(410, { error: "expired" });
      if (authorization.state !== "pending") return json(409);
      if (body.state === "approved" && !(typeof body.sealed_response === "string" && body.sealed_response.length >= 32)) return json(422);
      authorization.state = body.state;
      authorization.sealed_response = body.state === "approved" ? body.sealed_response : null;
      return json(204);
    }
    if (req.method === "GET" && action === "") {
      return json(200, { state: authorization.state, sealed_response: authorization.sealed_response });
    }
    if (req.method === "POST" && action === "/consume") {
      authorization.state = "consumed";
      authorization.sealed_response = null;
      return json(204);
    }
    if (req.method === "POST" && action === "/endorse") {
      if (!computer.approver_keys.includes(body.approver_key)) return json(403, { error: "not_an_approver" });
      if (authorization.state !== "pending") return json(409);
      authorization.endorsements = [...authorization.endorsements.filter((e) => e.approver_key !== body.approver_key), { approver_key: body.approver_key, endorsement: body.endorsement }].slice(-5);
      return json(204);
    }
    return json(404, { error: "not_found" });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const addComputer: FakeBackend["addComputer"] = (args) => {
    const computer: FakeComputer = {
      id: nextId++,
      name: args.name,
      public_key: args.public_key,
      kind: args.kind ?? "desktop",
      platform: null,
      credential: randomBytes(16).toString("hex"),
      approver_keys: args.approver_keys ?? [],
      status: null,
      last_seen_at: new Date().toISOString(),
      heartbeats: 0,
    };
    computers.push(computer);
    return computer;
  };

  return {
    url,
    userToken,
    computers,
    authorizations,
    logins,
    calls,
    deviceTokens,
    pollExtras,
    addComputer,
    approveLogin(code, approver) {
      const login = logins.find((l) => l.user_code === code);
      if (!login) throw new Error(`no login ${code}`);
      const computer = addComputer({ name: login.name, public_key: login.public_key, kind: "server", approver_keys: approver ? [approver.public_key] : [] });
      computer.platform = login.platform;
      login.state = "approved";
      login.computer_id = computer.id;
      login.approver = approver ? { kind: approver.kind, public_key: approver.public_key, name: approver.name ?? "Mac de Jimmy" } : null;
    },
    denyLogin(code) {
      const login = logins.find((l) => l.user_code === code);
      if (!login) throw new Error(`no login ${code}`);
      login.state = "denied";
    },
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : input);
      return globalThis.fetch(`${url}${target.pathname}${target.search}`, init);
    }) as typeof fetch,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/// A model runtime speaking OpenAI's streaming chat: each answer is
/// `reply(model)` in three pieces. `cutAfterFirst` drops the connection
/// after the first piece.
export async function startFakeRuntime(options: { models: string[]; reply?: (model: string) => string; cutAfterFirst?: boolean }): Promise<{ url: string; calls: Array<{ model: string; body: any }>; close(): Promise<void> }> {
  const calls: Array<{ model: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: options.models.map((id) => ({ id })) }));
      return;
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      const body = await readBody(req);
      calls.push({ model: body.model, body });
      if (!options.models.includes(body.model)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "model not found" }));
        return;
      }
      const text = options.reply?.(body.model) ?? `Réponse de ${body.model}.`;
      const pieces = [text.slice(0, 4), text.slice(4, 10), text.slice(10)].filter(Boolean);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [i, piece] of pieces.entries()) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        if (options.cutAfterFirst && i === 0) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          res.destroy();
          return;
        }
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 }, timings: { prompt_n: 12, prompt_ms: 40, predicted_n: 6, predicted_ms: 300 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
