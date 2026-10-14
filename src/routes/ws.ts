import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate } from "../auth.js";
import { subscribe } from "../events.js";
import { reachesWalledProjects, walledConversation } from "../projects/walledAccess.js";

// `/ws` — single WebSocket endpoint that fans out per-user server
// events to connected clients. Mirrors what /cable does on the
// cloud Rails backend, but stripped to the wire shape twoody-app /
// twoody-desktop actually consume:
//
//   server → client
//     {"type":"hello", "user_id":"…"}
//     {"type":"discussion.created",  "discussion_id":"…", "title":"…"}
//     {"type":"discussion.touched",  "discussion_id":"…", "last_activity_at":"…"}
//     {"type":"discussion.updated",  "discussion_id":"…", "title":"…"}
//         its title changed: the model wrote one after the first answer
//         (src/discussionTitles.ts), or another device's came with the
//         synchronised history; GET /discussions lists it from then on
//     {"type":"message.appended",    "discussion_id":"…", "role":"user|assistant"}
//
//   client → server
//     {"type":"ping"}    → server replies {"type":"pong"}
//
// Auth: bearer token in `?token=` query param, since browsers /
// Electron renderers can't set custom headers on `new WebSocket(url)`.
// The token is matched against `auth_sessions` + `devices` the same
// way the HTTP routes do — same source of truth, no separate
// session table.
export async function wsRoutes(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, async (socket, req) => {
    const token = (req.query as { token?: string }).token;
    const auth = await authenticateFromToken(req, token);
    if (!auth) {
      socket.send(JSON.stringify({ type: "error", error: "unauthorized" }));
      socket.close(1008, "unauthorized");
      return;
    }

    socket.send(JSON.stringify({ type: "hello", user_id: auth.userId }));

    // Per-user server-event subscription. Other users' events
    // (different `userId`) are filtered server-side so a stray
    // subscriber can't snoop the bus. The unsubscribe is fired
    // when the socket closes — `socket.on("close", …)` below.
    // A walled-off project's conversations (src/projects/isolation.ts) are
    // this computer's app's only: their titles and activity reach no other
    // socket — a phone, another computer, a browser on the network.
    const thisApp = await reachesWalledProjects(req, auth);
    const unsubscribe = subscribe((event) => {
      if (!eventReaches(event, auth.userId, thisApp)) return;
      const payload = serializeEvent(event);
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        // Socket closed mid-send — `subscribe` callback fires on
        // the bus's emit thread, so a closed-state isn't atomic.
        // Best-effort send, the close handler unwires us.
      }
    });

    socket.on("message", (raw: Buffer) => {
      // The protocol is intentionally tiny — one client→server
      // message type. Keepalive pings let the client distinguish
      // "server is alive but quiet" from a dropped TCP socket.
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(raw.toString("utf-8"));
      } catch {
        return;
      }
      if (parsed.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      }
    });

    socket.on("close", () => {
      unsubscribe();
    });
  });
}

type SerializedEvent =
  | {
      type: "discussion.created";
      discussion_id: string;
      title: string | null;
    }
  | {
      type: "discussion.touched";
      discussion_id: string;
      last_activity_at: string;
    }
  | {
      type: "discussion.updated";
      discussion_id: string;
      title: string | null;
    }
  | {
      type: "message.appended";
      discussion_id: string;
      role: "user" | "assistant";
    };

/// Whether a server event goes to a socket of this person: another
/// person's never; a walled-off project's conversation only to a socket
/// that reaches the walled-off projects (this computer's app).
export function eventReaches(event: Parameters<Parameters<typeof subscribe>[0]>[0], userId: string, reachesWalled: boolean): boolean {
  if (event.userId !== userId) return false;
  return reachesWalled || !walledConversation(event.discussionId);
}

function serializeEvent(event: Parameters<Parameters<typeof subscribe>[0]>[0]): SerializedEvent {
  switch (event.kind) {
    case "discussion.created":
      return { type: "discussion.created", discussion_id: event.discussionId, title: event.title };
    case "discussion.updated":
      return { type: "discussion.updated", discussion_id: event.discussionId, title: event.title };
    case "discussion.touched":
      return { type: "discussion.touched", discussion_id: event.discussionId, last_activity_at: event.lastActivityAt };
    case "message.appended":
      return { type: "message.appended", discussion_id: event.discussionId, role: event.role };
  }
}

/// `authenticate()` reads X-User-Token / Authorization headers, which
/// we don't get on a WebSocket upgrade in the browser. Instead the
/// client sends `?token=…` in the URL — we synthesise a request-like
/// object with the token in the standard header so the same auth
/// path runs without duplication — the request's own url with it, so a
/// session limited to some routes (a peer's, auth.ts) is refused here too.
async function authenticateFromToken(
  req: FastifyRequest,
  token: string | undefined,
): Promise<{ userId: string; sessionId?: string; deviceId?: string; thisMachine?: boolean } | null> {
  if (!token) return null;
  // The upgrade's own address and headers (but its credentials): whether
  // it comes from this machine is told as for any route (auth.ts
  // fromThisMachine — a tunnel or a proxy is not this machine).
  const synthetic = {
    url: req.url,
    ip: req.ip,
    headers: {
      ...req.headers,
      authorization: `Bearer ${token}`,
    },
  } as unknown as FastifyRequest;
  const auth = await authenticate(synthetic);
  return auth ? { userId: auth.userId, sessionId: auth.sessionId, deviceId: auth.deviceId, thisMachine: auth.thisMachine } : null;
}
