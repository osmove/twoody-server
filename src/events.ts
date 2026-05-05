import { EventEmitter } from "node:events";

// Internal event bus for the local server. Routes that mutate
// discussion state (`/queries` after a turn lands, future `/messages`
// inserts) call `publish(...)`; the WebSocket route subscribes to
// fan out per-user updates to connected clients.
//
// Keeping the bus in-process means we can't scale beyond one Node
// instance, which is fine — twoody-server is a single-machine
// self-hosted backend, not a fleet. Cloud-style multi-replica
// pub/sub is a non-goal for the OSS edition.

export type ServerEvent =
  | {
      kind: "discussion.touched";
      userId: string;
      discussionId: string;
      lastActivityAt: string;
    }
  | {
      kind: "discussion.created";
      userId: string;
      discussionId: string;
      title: string | null;
    }
  | {
      kind: "message.appended";
      userId: string;
      discussionId: string;
      role: "user" | "assistant";
    };

const bus = new EventEmitter();
// Bump default max listeners — every WebSocket connection adds one,
// and 10 is the silent threshold beyond which Node logs a warning
// even when more is fine. Self-hosted users typically have <10
// devices but multi-tab desktop sessions can push that over.
bus.setMaxListeners(64);

export function publish(event: ServerEvent): void {
  bus.emit("event", event);
}

export function subscribe(handler: (event: ServerEvent) => void): () => void {
  bus.on("event", handler);
  return () => {
    bus.off("event", handler);
  };
}
