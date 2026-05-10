// Static catalogue of built-in capabilities ("skills") that ship with
// twoody-server's OSS edition. Each capability bundles a set of
// related tools the LLM can call. Toggling a capability flips all
// its tools on/off in lockstep; advanced users can toggle individual
// tools via PATCH /built_in_capabilities/:slug/tools/:tool_name.
//
// Per-user enable/disable state lives in `users.prefs_json` under the
// keys `disabled_capabilities: string[]` and `disabled_tools: string[]`
// — opt-out by default so freshly-paired users get the LAN-friendly
// defaults without the operator pre-flipping anything.
//
// The catalogue is wire-compatible with Rails `/built_in_capabilities`
// (same field names, same shape per-row), so the iPhone + desktop's
// Capabilities tab can drive both backends with identical code.
//
// When twoody-mcp gains a discovery endpoint we'll fold its tools into
// this list at runtime; until then, these are the routes the OSS server
// itself can satisfy without a separate process.

export interface BuiltInCapabilityDef {
  slug:           string;
  label:          string;
  description:    string;
  icon:           string;
  cost:           "free" | "paid" | "real_money";
  requires_setup: boolean;
  default_on:     boolean;
  tools:          BuiltInToolDef[];
}

export interface BuiltInToolDef {
  name:        string;
  description: string;
}

export const BUILT_IN_CAPABILITIES: BuiltInCapabilityDef[] = [
  {
    slug:           "memory",
    label:          "Memory",
    description:    "Store and recall facts, preferences, and project notes across conversations.",
    icon:           "book-open",
    cost:           "free",
    requires_setup: false,
    default_on:     true,
    tools: [
      { name: "memory_search", description: "Search the user's memories by keyword or kind." },
      { name: "memory_create", description: "Save a new memory (title + content + tags)." },
      { name: "memory_update", description: "Edit an existing memory." },
      { name: "memory_delete", description: "Forget a specific memory." },
    ],
  },
  {
    slug:           "tasks",
    label:          "Tasks",
    description:    "Track to-dos with due dates and priorities.",
    icon:           "check-square",
    cost:           "free",
    requires_setup: false,
    default_on:     true,
    tools: [
      { name: "task_list",   description: "List the user's open and recently completed tasks." },
      { name: "task_create", description: "Create a new task with optional due date and notes." },
      { name: "task_update", description: "Mark a task done, change due date, or edit notes." },
      { name: "task_delete", description: "Remove a task." },
    ],
  },
  {
    slug:           "reminders",
    label:          "Reminders",
    description:    "Keep time-based reminders with active, done, and deleted states.",
    icon:           "bell",
    cost:           "free",
    requires_setup: false,
    default_on:     true,
    tools: [
      { name: "reminder_list", description: "List active, overdue, done, or deleted reminders." },
      { name: "reminder_create", description: "Create a reminder with an optional notification time." },
      { name: "reminder_update", description: "Mark a reminder done, reopen it, or change its text/time." },
      { name: "reminder_delete", description: "Soft-delete a reminder." },
    ],
  },
  {
    slug:           "notes",
    label:          "Notes",
    description:    "Free-form notes Twoody can pin, archive, or search.",
    icon:           "sticky-note",
    cost:           "free",
    requires_setup: false,
    default_on:     true,
    tools: [
      { name: "note_search", description: "Search notes by title or body." },
      { name: "note_create", description: "Append a new note." },
      { name: "note_update", description: "Edit, pin, or archive an existing note." },
      { name: "note_delete", description: "Delete a note." },
    ],
  },
  {
    slug:           "discussions",
    label:          "Conversation history",
    description:    "Search past conversations and bring up earlier exchanges by keyword.",
    icon:           "message-square",
    cost:           "free",
    requires_setup: false,
    default_on:     true,
    tools: [
      { name: "discussion_search", description: "Find past conversations by keyword." },
      { name: "discussion_recall", description: "Replay a specific past conversation." },
    ],
  },
  {
    slug:           "local_llm",
    label:          "Local model bridge",
    description:    "Route LLM calls to mlx-lm or Ollama running on your Mac/NAS.",
    icon:           "cpu",
    cost:           "free",
    requires_setup: true,
    default_on:     false,
    tools: [
      { name: "local_chat_completion", description: "Run a chat completion against the bridged local model." },
    ],
  },
];

export function findCapability(slug: string): BuiltInCapabilityDef | undefined {
  return BUILT_IN_CAPABILITIES.find((c) => c.slug === slug);
}
