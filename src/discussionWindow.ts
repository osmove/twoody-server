// Which conversation a message belongs to when it does not name one.
//
// A text surface owns its thread state: the chat knows which conversation
// it is showing, so a message without `discussion_id` means "this is a new
// conversation". A voice surface has no such button: two short utterances
// a moment apart ("what time is it?" … "and tomorrow?") belong together,
// and a question after a coffee break starts over.
//
// Same rule and same table as the cloud backend's DiscussionResolver. The
// server used to reuse the latest conversation for half an hour whatever
// the surface: "New conversation" in the desktop chat then kept writing
// into the previous thread, which also handed the previous exchange to
// the model as if it were part of the new one.

const REUSE_WINDOWS_MS: Record<string, number> = {
  device: 60 * 1000,
  watch: 10 * 60 * 1000,
};

/// How long a conversation stays open to a message from this channel that
/// names none. null: never, every such message starts a conversation.
export function reuseWindowMs(channel: string | null | undefined): number | null {
  return REUSE_WINDOWS_MS[String(channel ?? "")] ?? null;
}

export interface ThreadRef {
  id: string;
  lastActivityAt: Date;
}

/// The conversation to continue, or null when a new one must be created.
///
/// - `forceNew` wins over everything: the client said "new conversation".
/// - `explicit` is the conversation the client named, already checked to
///   be the user's. A voice surface naming one that has gone quiet for
///   longer than its window still starts over.
/// - `mostRecent` is the user's latest conversation, reused only inside
///   the channel's window.
export function chooseDiscussion<T extends ThreadRef>(options: {
  channel: string | null | undefined;
  forceNew: boolean;
  explicit: T | null;
  mostRecent: T | null;
  now?: Date;
}): T | null {
  if (options.forceNew) return null;
  const window = reuseWindowMs(options.channel);
  const now = (options.now ?? new Date()).getTime();
  const stillOpen = (thread: T) => window !== null && now - thread.lastActivityAt.getTime() < window;

  if (options.explicit && (window === null || stillOpen(options.explicit))) return options.explicit;
  if (options.mostRecent && stillOpen(options.mostRecent)) return options.mostRecent;
  return null;
}
