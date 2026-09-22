// What travels inside the encrypted channel: the phone's HTTP requests
// and this server's answers, cut into messages small enough to send one
// at a time.
//
// The phone already speaks HTTP to twoody-server on the LAN, and every
// screen in the app is built on that. So the tunnel carries the same
// requests rather than a second, smaller API that would drift from the
// first — the phone changes only where it sends them.
//
// A message is a short JSON header and, for the ones that carry bytes, a
// body after it:
//
//   header length (4 bytes) | header JSON | body
//
// Answers arrive in pieces, because the answers that matter here are
// streamed: a model writing a reply sends tokens for a minute, and the
// phone must show them as they come rather than after. So a response is
// a `res` (status and headers), then `chunk`s, then `end`.

export interface RequestMessage {
  t: "req";
  /// Identifies this exchange. The phone picks it; it only has to be
  /// unique among the requests it has in flight.
  id: number;
  method: string;
  /// Path and query, as written — never a whole URL. The host side
  /// decides which server it points at.
  path: string;
  headers: Record<string, string>;
}

export interface ResponseMessage {
  t: "res";
  id: number;
  status: number;
  headers: Record<string, string>;
}

export interface ChunkMessage {
  t: "chunk";
  id: number;
}

export interface EndMessage {
  t: "end";
  id: number;
}

export interface ErrorMessage {
  t: "err";
  id: number;
  /// For the phone to show. It says what went wrong between the tunnel
  /// and the local server, never what the local server holds.
  message: string;
}

export interface AbortMessage {
  t: "abort";
  id: number;
}

export interface PingMessage {
  t: "ping";
}

export type Message =
  | RequestMessage
  | ResponseMessage
  | ChunkMessage
  | EndMessage
  | ErrorMessage
  | AbortMessage
  | PingMessage;

export class ProtocolError extends Error {}

/// Bodies are capped so one side cannot make the other allocate freely.
/// 32 MB is more than any screen sends; a document upload has its own
/// route and is chunked.
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

export function encode(message: Message, body?: Buffer): Buffer {
  const header = Buffer.from(JSON.stringify(message), "utf8");
  if (header.length > MAX_HEADER_BYTES) throw new ProtocolError("message header too large");
  if (body && body.length > MAX_BODY_BYTES) throw new ProtocolError("message body too large");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length, 0);
  return body && body.length > 0 ? Buffer.concat([length, header, body]) : Buffer.concat([length, header]);
}

export function decode(frame: Buffer): { message: Message; body: Buffer } {
  if (frame.length < 4) throw new ProtocolError("message too short");
  const headerLength = frame.readUInt32BE(0);
  if (headerLength > MAX_HEADER_BYTES || 4 + headerLength > frame.length) throw new ProtocolError("message header length is wrong");
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.subarray(4, 4 + headerLength).toString("utf8"));
  } catch {
    throw new ProtocolError("message header is not JSON");
  }
  return { message: asMessage(parsed), body: frame.subarray(4 + headerLength) };
}

/// Everything that comes out of the channel is checked before it is
/// used. The channel proves the other device sealed it; it does not
/// prove that device sent something sensible, and a bug on one side
/// should not become a crash on the other.
function asMessage(value: unknown): Message {
  if (typeof value !== "object" || value === null) throw new ProtocolError("message is not an object");
  const record = value as Record<string, unknown>;
  switch (record.t) {
    case "ping":
      return { t: "ping" };
    case "req": {
      const id = asId(record.id);
      if (typeof record.method !== "string" || !/^[A-Z]{3,7}$/.test(record.method)) throw new ProtocolError("request method is not a method");
      if (typeof record.path !== "string" || !record.path.startsWith("/")) throw new ProtocolError("request path must start with /");
      return { t: "req", id, method: record.method, path: record.path, headers: asHeaders(record.headers) };
    }
    case "res": {
      const id = asId(record.id);
      if (typeof record.status !== "number" || !Number.isInteger(record.status) || record.status < 100 || record.status > 599) {
        throw new ProtocolError("response status is not a status");
      }
      return { t: "res", id, status: record.status, headers: asHeaders(record.headers) };
    }
    case "chunk":
      return { t: "chunk", id: asId(record.id) };
    case "end":
      return { t: "end", id: asId(record.id) };
    case "abort":
      return { t: "abort", id: asId(record.id) };
    case "err":
      return { t: "err", id: asId(record.id), message: typeof record.message === "string" ? record.message.slice(0, 500) : "unknown error" };
    default:
      throw new ProtocolError(`unknown message type ${JSON.stringify(record.t)}`);
  }
}

function asId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ProtocolError("message id is not an id");
  return value;
}

function asHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new ProtocolError("headers are not an object");
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    // A newline in a header name or value is how a request gets split
    // into two. Refuse rather than sanitise: there is no legitimate one.
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new ProtocolError(`header name is not a header name: ${JSON.stringify(name.slice(0, 40))}`);
    if (typeof raw !== "string" || /[\r\n\0]/.test(raw)) throw new ProtocolError(`header ${name} holds a line break`);
    headers[name.toLowerCase()] = raw;
  }
  return headers;
}
