import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import { memoryIdsOf, projectEntity, findEntity, aliasesOf, entitiesInText } from "../memory/entities.js";
import { memoriesChanged } from "../memory/changes.js";

// Projects (docs/projects-design.md, lot P1): what the person is working
// towards — a house, a Mac mini, a wedding, a move — and what hangs off it:
// the memories naming it (through its entity in the memory graph), its
// tasks, reminders, events, conversations and documents.

export const PROJECT_KINDS = ["purchase", "event", "home", "travel", "work", "health", "learning", "admin", "other"] as const;
/// How much a project matters (Jimmy, 02/10/2026: « petit et grand…
/// ajouter moyen, et critique »): a large or critical one is in every
/// conversation, a critical one first.
export const PROJECT_SIZES = ["small", "medium", "large", "critical"] as const;
export const PROJECT_STATUSES = ["idea", "active", "paused", "done", "dropped"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export type ProjectSize = (typeof PROJECT_SIZES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const MAX_TITLE = 200;
const MAX_BRIEF = 4000;

export class ProjectError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export interface ProjectInput {
  title?: string;
  /// How the person names it in a sentence (« le Mac mini »), and other names.
  name?: string;
  aliases?: string[];
  kind?: ProjectKind;
  size?: ProjectSize;
  status?: ProjectStatus;
  brief?: string | null;
  due_at?: string | null;
  budget_cents?: number | null;
  currency?: string | null;
}

interface Row {
  id: string; user_id: string; entity_id: string | null; title: string; kind: string; size: string; status: string; brief: string | null;
  started_at: number | null; due_at: number | null; done_at: number | null; budget_cents: number | null; currency: string | null;
  source: string; created_at: number; updated_at: number;
}

const iso = (ms: number | null) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export function readProjectInput(raw: unknown, creating: boolean): ProjectInput {
  const body = ((raw as { project?: unknown } | null)?.project ?? raw) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw new ProjectError(422, "project_required");
  const out: ProjectInput = {};
  if (body.title !== undefined || creating) {
    const title = typeof body.title === "string" ? body.title.trim().replace(/\s+/g, " ") : "";
    if (!title || title.length > MAX_TITLE) throw new ProjectError(422, "invalid_title");
    out.title = title;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > MAX_TITLE) throw new ProjectError(422, "invalid_name");
    out.name = body.name.trim();
  }
  if (body.aliases !== undefined) {
    if (!Array.isArray(body.aliases) || body.aliases.length > 16 || body.aliases.some((alias) => typeof alias !== "string" || alias.length > 100)) throw new ProjectError(422, "invalid_aliases");
    out.aliases = body.aliases as string[];
  }
  for (const [key, allowed] of [["kind", PROJECT_KINDS], ["size", PROJECT_SIZES], ["status", PROJECT_STATUSES]] as const) {
    if (body[key] === undefined) continue;
    if (!(allowed as readonly string[]).includes(String(body[key]))) throw new ProjectError(422, `invalid_${key}`);
    (out as Record<string, unknown>)[key] = body[key];
  }
  if (body.brief !== undefined) {
    if (body.brief !== null && (typeof body.brief !== "string" || body.brief.length > MAX_BRIEF)) throw new ProjectError(422, "invalid_brief");
    out.brief = typeof body.brief === "string" && body.brief.trim() ? body.brief.trim() : null;
  }
  if (body.due_at !== undefined) {
    if (body.due_at !== null && (typeof body.due_at !== "string" || Number.isNaN(Date.parse(body.due_at)))) throw new ProjectError(422, "invalid_due_at");
    out.due_at = body.due_at as string | null;
  }
  if (body.budget_cents !== undefined) {
    if (body.budget_cents !== null && (!Number.isInteger(body.budget_cents) || (body.budget_cents as number) < 0)) throw new ProjectError(422, "invalid_budget");
    out.budget_cents = body.budget_cents as number | null;
  }
  if (body.currency !== undefined) {
    if (body.currency !== null && (typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency))) throw new ProjectError(422, "invalid_currency");
    out.currency = body.currency as string | null;
  }
  return out;
}

function byId(userId: string, id: string): Row | undefined {
  return sqlite.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
}

export function createProject(userId: string, input: ProjectInput, source: "manual" | "learned" | "account" = "manual", now = Date.now()): string {
  const title = input.title!;
  const entity = projectEntity(userId, input.name ?? title, [...(input.name && input.name !== title ? [title] : []), ...(input.aliases ?? [])], source, now);
  // The same entity already has a project: that one.
  const existing = sqlite.prepare("SELECT id FROM projects WHERE user_id = ? AND entity_id = ? AND status != 'dropped'").get(userId, entity.id) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const status = input.status ?? "active";
  sqlite.prepare(`INSERT INTO projects (id, user_id, entity_id, title, kind, size, status, brief, started_at, due_at, done_at, budget_cents, currency, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, userId, entity.id, title, input.kind ?? "other", input.size ?? "small", status, input.brief ?? null,
    status === "active" ? now : null, input.due_at ? Date.parse(input.due_at) : null, status === "done" ? now : null,
    input.budget_cents ?? null, input.currency ?? null, source, now, now,
  );
  // The profile's « Projects under way » may change: read ahead again.
  memoriesChanged(userId);
  return id;
}

export function updateProject(userId: string, id: string, input: ProjectInput, now = Date.now()) {
  const row = byId(userId, id);
  if (!row) throw new ProjectError(404, "not_found");
  const status = input.status ?? row.status;
  sqlite.prepare(`UPDATE projects SET title = ?, kind = ?, size = ?, status = ?, brief = ?, due_at = ?, budget_cents = ?, currency = ?,
    started_at = ?, done_at = ?, updated_at = ? WHERE id = ?`).run(
    input.title ?? row.title, input.kind ?? row.kind, input.size ?? row.size, status,
    input.brief !== undefined ? input.brief : row.brief,
    input.due_at !== undefined ? (input.due_at ? Date.parse(input.due_at) : null) : row.due_at,
    input.budget_cents !== undefined ? input.budget_cents : row.budget_cents,
    input.currency !== undefined ? input.currency : row.currency,
    row.started_at ?? (status === "active" ? now : null),
    status === "done" ? row.done_at ?? now : null,
    now, id,
  );
  if (input.name || input.aliases?.length) projectEntity(userId, input.name ?? row.title, input.aliases ?? [], row.source, now);
  memoriesChanged(userId);
}

/// The project goes; what hung off it stays, unlinked.
export function deleteProject(userId: string, id: string) {
  const row = byId(userId, id);
  if (!row) throw new ProjectError(404, "not_found");
  sqlite.transaction(() => {
    for (const table of ["tasks", "reminders", "events", "discussions"]) sqlite.prepare(`UPDATE ${table} SET project_id = NULL WHERE project_id = ? AND user_id = ?`).run(id, userId);
    sqlite.prepare("DELETE FROM project_documents WHERE project_id = ?").run(id);
    sqlite.prepare("DELETE FROM projects WHERE id = ?").run(id);
  })();
  memoriesChanged(userId);
}

const LINKS = { task_id: "tasks", reminder_id: "reminders", event_id: "events", discussion_id: "discussions" } as const;

/// Ties a task, reminder, event or conversation to the project — or unties
/// it (`project: null` on the item's own route does the same).
export function linkToProject(userId: string, id: string, body: Record<string, unknown>, unlink = false) {
  if (!byId(userId, id)) throw new ProjectError(404, "not_found");
  let linked = 0;
  for (const [key, table] of Object.entries(LINKS)) {
    const target = body[key];
    if (typeof target !== "string") continue;
    const result = sqlite.prepare(`UPDATE ${table} SET project_id = ? WHERE id = ? AND user_id = ?`).run(unlink ? null : id, target, userId);
    if (result.changes === 0) throw new ProjectError(404, `${key}_not_found`);
    linked += 1;
  }
  const document = body.document as { computer_id?: unknown; document_id?: unknown; name?: unknown } | undefined;
  if (document && typeof document.computer_id === "string" && typeof document.document_id === "string") {
    if (unlink) sqlite.prepare("DELETE FROM project_documents WHERE project_id = ? AND computer_id = ? AND document_id = ?").run(id, document.computer_id, document.document_id);
    else sqlite.prepare("INSERT OR IGNORE INTO project_documents (project_id, computer_id, document_id, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, document.computer_id, document.document_id, typeof document.name === "string" ? document.name.slice(0, 250) : null, Date.now());
    linked += 1;
  }
  if (linked === 0) throw new ProjectError(422, "nothing_to_link");
}

function serialize(row: Row) {
  const entity = row.entity_id ? findEntity(row.user_id, row.entity_id) : null;
  const count = (sql: string) => (sqlite.prepare(sql).get(row.id, row.user_id) as { n: number }).n;
  return {
    id: row.id, title: row.title, kind: row.kind, size: row.size, status: row.status, brief: row.brief, source: row.source,
    name: entity?.name ?? null, aliases: entity ? aliasesOf(entity.id) : [], entity_id: row.entity_id,
    started_at: iso(row.started_at), due_at: iso(row.due_at), done_at: iso(row.done_at),
    budget_cents: row.budget_cents, currency: row.currency,
    counts: {
      memories: entity ? memoryIdsOf(entity.id).length : 0,
      tasks_open: count("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND user_id = ? AND done_at IS NULL"),
      reminders: count("SELECT COUNT(*) AS n FROM reminders WHERE project_id = ? AND user_id = ? AND status = 'active'"),
      events: count("SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND user_id = ?"),
      conversations: count("SELECT COUNT(*) AS n FROM discussions WHERE project_id = ? AND user_id = ?"),
      documents: (sqlite.prepare("SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ?").get(row.id) as { n: number }).n,
    },
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  };
}

const STATUS_ORDER = "CASE status WHEN 'active' THEN 0 WHEN 'idea' THEN 1 WHEN 'paused' THEN 2 WHEN 'done' THEN 3 ELSE 4 END";

export function listProjects(userId: string) {
  return (sqlite.prepare(`SELECT * FROM projects WHERE user_id = ? ORDER BY ${STATUS_ORDER}, updated_at DESC LIMIT 500`).all(userId) as Row[]).map(serialize);
}

export function projectDetail(userId: string, id: string) {
  const row = byId(userId, id);
  if (!row) throw new ProjectError(404, "not_found");
  const memoryIds = row.entity_id ? memoryIdsOf(row.entity_id) : [];
  const memories = memoryIds.length
    ? (sqlite.prepare(`SELECT id, kind, title, content, created_at FROM memories WHERE user_id = ? AND superseded_by_id IS NULL AND id IN (${memoryIds.map(() => "?").join(",")}) ORDER BY created_at DESC`).all(userId, ...memoryIds) as Array<{ id: string; kind: string; title: string | null; content: string; created_at: number }>)
      .map((memory) => ({ ...memory, created_at: new Date(memory.created_at).toISOString() }))
    : [];
  const at = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    ...serialize(row),
    memories,
    tasks: (sqlite.prepare("SELECT id, title, due_at, done_at FROM tasks WHERE project_id = ? AND user_id = ? ORDER BY done_at IS NOT NULL, due_at").all(id, userId) as Array<{ id: string; title: string; due_at: number | null; done_at: number | null }>)
      .map((task) => ({ id: task.id, title: task.title, due_at: at(task.due_at), done_at: at(task.done_at) })),
    reminders: (sqlite.prepare("SELECT id, text, title, notify_at, status FROM reminders WHERE project_id = ? AND user_id = ? ORDER BY notify_at").all(id, userId) as Array<{ id: string; text: string; title: string | null; notify_at: number | null; status: string }>)
      .map((reminder) => ({ id: reminder.id, text: reminder.title || reminder.text, notify_at: at(reminder.notify_at), status: reminder.status })),
    events: (sqlite.prepare("SELECT id, name, start_time, end_time, location FROM events WHERE project_id = ? AND user_id = ? ORDER BY start_time").all(id, userId) as Array<{ id: string; name: string; start_time: number; end_time: number | null; location: string | null }>)
      .map((event) => ({ id: event.id, name: event.name, start_time: at(event.start_time), end_time: at(event.end_time), location: event.location })),
    conversations: (sqlite.prepare("SELECT id, title, last_activity_at FROM discussions WHERE project_id = ? AND user_id = ? ORDER BY last_activity_at DESC LIMIT 50").all(id, userId) as Array<{ id: string; title: string | null; last_activity_at: number }>)
      .map((discussion) => ({ id: discussion.id, title: discussion.title, last_activity_at: at(discussion.last_activity_at) })),
    documents: sqlite.prepare("SELECT computer_id, document_id, name FROM project_documents WHERE project_id = ? ORDER BY created_at").all(id),
  };
}

/// The projects a learner is shown, so that it names them and does not
/// propose them again: the ones not dropped, newest first.
export function knownProjects(userId: string): Array<{ ref: string; id: string; title: string; status: string; name: string | null }> {
  return (sqlite.prepare("SELECT id, title, status, entity_id FROM projects WHERE user_id = ? AND status != 'dropped' ORDER BY updated_at DESC LIMIT 30").all(userId) as Array<{ id: string; title: string; status: string; entity_id: string | null }>)
    .map((row, index) => ({ ref: `p${index + 1}`, id: row.id, title: row.title, status: row.status, name: row.entity_id ? findEntity(userId, row.entity_id)?.name ?? null : null }));
}

const KIND_WORDS: Record<string, string> = { purchase: "purchase", event: "event", home: "home", travel: "travel", work: "work", health: "health", learning: "learning", admin: "paperwork", other: "project" };
const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

/// « Projects under way: … » — the large ones in progress or in mind, in the
/// profile (docs/projects-design.md §4): changes only with the projects, so
/// the prompt cache holds.
export function projectsLine(userId: string): string | null {
  const rows = sqlite.prepare("SELECT title, due_at, size FROM projects WHERE user_id = ? AND size IN ('large', 'critical') AND status IN ('active', 'idea') ORDER BY size = 'critical' DESC, created_at LIMIT 6").all(userId) as Array<{ title: string; due_at: number | null; size: string }>;
  if (!rows.length) return null;
  return `Projects under way: ${rows.map((row) => `${row.title}${row.size === "critical" ? " (critical)" : ""}${row.due_at ? ` (due ${day(row.due_at)})` : ""}`).join("; ")}.`;
}

/// The cards of the projects a message is about — named (its name, an
/// alias) or reached through the memories given with it: status, due
/// date, open tasks, next reminders, the last facts. At most two, ~600
/// characters each, in the message (never the system prompt).
export function projectCards(userId: string, text: string, memoryIds: Array<string | null> = []): Array<{ id: string; title: string; card: string }> {
  const named = new Set(entitiesInText(userId, text).map((link) => link.entity_id));
  const viaMemories = memoryIds.filter((id): id is string => !!id);
  if (viaMemories.length) {
    for (const row of sqlite.prepare(`SELECT entity_id FROM memory_entities WHERE memory_id IN (${viaMemories.map(() => "?").join(",")})`).all(...viaMemories) as Array<{ entity_id: string }>) named.add(row.entity_id);
  }
  if (!named.size) return [];
  const rows = sqlite.prepare(`SELECT * FROM projects WHERE user_id = ? AND status != 'dropped' AND entity_id IN (${[...named].map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT 2`).all(userId, ...named) as Row[];
  const at = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
  return rows.map((row) => {
    const tasks = (sqlite.prepare("SELECT title, due_at FROM tasks WHERE project_id = ? AND user_id = ? AND done_at IS NULL ORDER BY due_at IS NULL, due_at LIMIT 4").all(row.id, userId) as Array<{ title: string; due_at: number | null }>)
      .map((task) => (task.due_at ? `${task.title} (${at(task.due_at)})` : task.title));
    const reminders = (sqlite.prepare("SELECT COALESCE(title, text) AS text, notify_at FROM reminders WHERE project_id = ? AND user_id = ? AND status = 'active' ORDER BY notify_at LIMIT 3").all(row.id, userId) as Array<{ text: string; notify_at: number | null }>)
      .map((reminder) => (reminder.notify_at ? `${reminder.text} (${at(reminder.notify_at)})` : reminder.text));
    const facts = row.entity_id
      ? (sqlite.prepare(`SELECT m.content FROM memories m JOIN memory_entities l ON l.memory_id = m.id WHERE l.entity_id = ? AND m.user_id = ? AND m.superseded_by_id IS NULL AND m.tags NOT LIKE '%"sensitive"%' ORDER BY m.created_at DESC LIMIT 3`).all(row.entity_id, userId) as Array<{ content: string }>).map((fact) => fact.content.replace(/\s+/g, " ").slice(0, 160))
      : [];
    const head = [`${KIND_WORDS[row.kind] ?? "project"}`, (PROJECT_SIZES as readonly string[]).includes(row.size) ? row.size : "small", row.status, row.due_at ? `due ${day(row.due_at)}` : null, row.budget_cents ? `budget ${(row.budget_cents / 100).toFixed(0)} ${row.currency ?? ""}`.trim() : null].filter(Boolean).join(", ");
    const lines = [
      `${row.title} — ${head}`,
      row.brief ? `Notes: ${row.brief.replace(/\s+/g, " ").slice(0, 200)}` : null,
      tasks.length ? `Open tasks: ${tasks.join("; ")}` : null,
      reminders.length ? `Reminders: ${reminders.join("; ")}` : null,
      facts.length ? `What they said: ${facts.join(" · ")}` : null,
    ].filter(Boolean);
    return { id: row.id, title: row.title, card: lines.join("\n").slice(0, 700) };
  });
}
