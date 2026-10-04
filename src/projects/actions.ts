import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import { normaliseName } from "../memory/entities.js";
import { updateProject, PROJECT_STATUSES, type ProjectStatus } from "./projects.js";

// What the chat may do on the person's say (docs/projects-design.md §4, lot
// P4): a reminder, a task, a project's status or due date. Only when they
// ask (the system prompt says so); each one said under the answer, with
// « Annuler » (routes/queries.ts `actions`).

export interface ChatAction {
  /// "home": a device of the person's home switched (home/homeAssistant.ts).
  type: "reminder" | "task" | "project" | "home";
  id: string;
  title: string;
  /// When it is due or will ring (ISO), if it has a time.
  at: string | null;
  project: { id: string; title: string } | null;
  /// For a project: what changed.
  change?: { status?: string; due?: string | null; state?: string; brightness?: number | null };
}

export const ACTION_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "create_reminder",
      description:
        "Create a reminder for the user, that rings at a given time. Only when they ask to be reminded of something. " +
        "Optionally tied to one of their projects, by its name.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remind them of, in their words and language." },
          when: { type: "string", description: "Local date and time, YYYY-MM-DDTHH:MM (their time zone). Default to 09:00 when they give only a day." },
          project: { type: "string", description: "The project's name, if it is about one." },
        },
        required: ["text", "when"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_task",
      description: "Add a task to the user's to-do list. Only when they ask to note something to do. Optionally with a due date and a project.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The task, in their words and language." },
          due: { type: "string", description: "Due date YYYY-MM-DD, if they give one." },
          project: { type: "string", description: "The project's name, if it is about one." },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_project",
      description: "Change the status or due date of one of the user's projects, when they say it changed (bought, done, paused, dropped, a new date).",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "The project's name." },
          status: { type: "string", enum: [...PROJECT_STATUSES], description: "idea, active, paused, done or dropped." },
          due: { type: "string", description: "New due date YYYY-MM-DD." },
        },
        required: ["project"],
      },
    },
  },
];

export class ActionError extends Error {}

/// The project a name means: its title or one of its entity's names, the
/// same or one inside the other; not a dropped one, never an isolated one
/// (isolation.ts: no other conversation acts on a client file, nor learns
/// its name).
export function resolveProject(userId: string, name: unknown): { id: string; title: string } | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const wanted = normaliseName(name);
  if (!wanted) return null;
  const rows = sqlite.prepare(`SELECT p.id, p.title, e.norm AS entity_norm FROM projects p LEFT JOIN entities e ON e.id = p.entity_id
    WHERE p.user_id = ? AND p.status != 'dropped' AND p.isolated = 0 ORDER BY p.updated_at DESC`).all(userId) as Array<{ id: string; title: string; entity_norm: string | null }>;
  const aliases = (id: string) => (sqlite.prepare("SELECT a.norm FROM projects p JOIN entity_aliases a ON a.entity_id = p.entity_id WHERE p.id = ?").all(id) as Array<{ norm: string }>).map((row) => row.norm);
  for (const row of rows) {
    const names = [normaliseName(row.title), row.entity_norm, ...aliases(row.id)].filter((value): value is string => !!value);
    if (names.some((value) => value === wanted || value.includes(wanted) || wanted.includes(value))) return { id: row.id, title: row.title };
  }
  return null;
}

/// « 2026-10-03T09:00 » in the person's time zone, as an instant.
export function zonedInstant(local: string, timeZone: string | null): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(local.trim());
  if (!match) {
    const parsed = Date.parse(local);
    if (Number.isNaN(parsed)) throw new ActionError("invalid_when");
    return new Date(parsed);
  }
  const [, y, mo, d, h = "09", mi = "00"] = match;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  if (!timeZone) return new Date(asUtc);
  // The zone's offset at that moment: what its clock says for the UTC instant.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(asUtc))
    .reduce<Record<string, string>>((out, part) => ({ ...out, [part.type]: part.value }), {});
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(asUtc - (shown - asUtc));
}

export function runAction(userId: string, name: string, args: Record<string, unknown>, timeZone: string | null, now = new Date(), said = ""): ChatAction {
  const project = resolveProject(userId, args.project);
  // The day the person named wins over the model's reading of it.
  const day = namedDay(said, timeZone, now);
  if (name === "create_reminder") {
    const text = typeof args.text === "string" ? args.text.trim().slice(0, 500) : "";
    if (!text || (typeof args.when !== "string" && !day)) throw new ActionError("text_and_when_required");
    const time = typeof args.when === "string" ? /(?:T|\s)(\d{2}:\d{2})/.exec(args.when)?.[1] ?? null : null;
    const at = zonedInstant(day ? `${day}T${time ?? "09:00"}` : (args.when as string), timeZone);
    const id = randomUUID();
    const stamp = now.getTime();
    sqlite.prepare(`INSERT INTO reminders (id, user_id, project_id, text, title, notify_at, status, channel, reminder_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 'push', 'once', ?, ?)`).run(id, userId, project?.id ?? null, text, text, at.getTime(), stamp, stamp);
    return { type: "reminder", id, title: text, at: at.toISOString(), project };
  }
  if (name === "create_task") {
    const title = typeof args.title === "string" ? args.title.trim().slice(0, 500) : "";
    if (!title) throw new ActionError("title_required");
    const dueDay = day ?? (typeof args.due === "string" && /^\d{4}-\d{2}-\d{2}/.test(args.due) ? args.due.slice(0, 10) : null);
    const due = dueDay ? zonedInstant(dueDay, timeZone) : null;
    const id = randomUUID();
    const stamp = now.getTime();
    sqlite.prepare("INSERT INTO tasks (id, user_id, title, due_at, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, title, due ? due.getTime() : null, project?.id ?? null, stamp, stamp);
    return { type: "task", id, title, at: due?.toISOString() ?? null, project };
  }
  if (name === "update_project") {
    if (!project) throw new ActionError("no_such_project");
    const status = typeof args.status === "string" && (PROJECT_STATUSES as readonly string[]).includes(args.status) ? (args.status as ProjectStatus) : undefined;
    const due = typeof args.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.due) ? `${args.due}T12:00:00.000Z` : undefined;
    if (!status && !due) throw new ActionError("nothing_to_change");
    updateProject(userId, project.id, { ...(status ? { status } : {}), ...(due ? { due_at: due } : {}) });
    return { type: "project", id: project.id, title: project.title, at: due ?? null, project, change: { ...(status ? { status } : {}), ...(due ? { due: args.due as string } : {}) } };
  }
  throw new ActionError("unknown_tool");
}

/// A message that asks for a reminder or a task outright: the model is made
/// to call the tool (it said « rappel créé » without one, 2 times in 6 with
/// Qwen3.5 9B, 01/10/2026).
const ASKS_REMINDER = /\b(?:rappelle[- ]?moi|rappelle[- ]nous|fais[- ]moi penser|n'oublie pas de me rappeler|pense [àa] me rappeler|remind me|reminder to)\b/i;
const ASKS_TASK = /\b(?:note que je dois|note[- ]moi de|ajoute (?:[àa] ma liste|une t[âa]che|dans mes t[âa]ches)|mets? (?:[çc]a )?dans mes t[âa]ches|add (?:a task|to my (?:to-?do|list|tasks)))\b/i;

export function askedAction(text: string): "create_reminder" | "create_task" | null {
  const plain = text.replace(/[’‘ʼ]/g, "'");
  if (ASKS_REMINDER.test(plain)) return "create_reminder";
  if (ASKS_TASK.test(plain)) return "create_task";
  return null;
}

const WEEKDAYS: Array<[RegExp, number]> = [
  [/\b(?:dimanche|sunday)\b/i, 0], [/\b(?:lundi|monday)\b/i, 1], [/\b(?:mardi|tuesday)\b/i, 2], [/\b(?:mercredi|wednesday)\b/i, 3],
  [/\b(?:jeudi|thursday)\b/i, 4], [/\b(?:vendredi|friday)\b/i, 5], [/\b(?:samedi|saturday)\b/i, 6],
];

/// The day the person named — « demain », « après-demain », « vendredi »
/// (the next one) — as YYYY-MM-DD in their zone; null when they named none
/// or gave a date of their own (« le 12 »), which the model reads.
export function namedDay(text: string, timeZone: string | null, now = new Date()): string | null {
  const plain = text.replace(/[’‘ʼ]/g, "'").toLowerCase();
  if (/\b\d{1,2}(?:er)?\s+(?:janv|f[ée]vr|mars|avr|mai|juin|juil|ao[ûu]t|sept|oct|nov|d[ée]c)|\b\d{1,2}\/\d{1,2}\b/.test(plain)) return null;
  const local = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const weekdayOf = (at: Date) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: timeZone ?? undefined, weekday: "short" }).format(at));
  const plus = (days: number) => local(new Date(now.getTime() + days * 86_400_000));
  if (/\bapr[èe]s[- ]demain\b|\bday after tomorrow\b/.test(plain)) return plus(2);
  if (/\bdemain\b|\btomorrow\b/.test(plain)) return plus(1);
  if (/\baujourd'hui\b|\bce soir\b|\bcet apr[èe]s[- ]midi\b|\btoday\b|\btonight\b/.test(plain)) return plus(0);
  for (const [pattern, weekday] of WEEKDAYS) {
    if (!pattern.test(plain)) continue;
    const today = weekdayOf(now);
    let ahead = (weekday - today + 7) % 7;
    if (ahead === 0) ahead = 7;
    if (/\b(?:prochain|next)\b/.test(plain) && ahead < 7 && /\b(?:semaine prochaine|next week)\b/.test(plain)) ahead += 7;
    return plus(ahead);
  }
  return null;
}
