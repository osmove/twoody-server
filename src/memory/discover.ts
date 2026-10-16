import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import { setLocalCapability } from "../localCapabilities.js";
import { createProject, knownProjects } from "../projects/projects.js";
import { learningModel, type LearnMessages, type LearningModel } from "./learner.js";

// What an import brings besides facts (Jimmy, 02/10/2026: Steeve imported
// what Claude knew of him — Twoody sorted some into « Projet », some into
// « Consigne » — « il faudrait en faire quelque chose »): the projects the
// memories speak of, the people, the dates. The model of this computer
// reads the imported memories once and proposes; the person ticks what to
// keep, and only that is made (applyDiscovery). Nothing is made unasked.

export interface DiscoveredProject { key: string; title: string; name: string | null; kind: string; status: string; memory_ids: string[] }
export interface DiscoveredContact { key: string; name: string; relation: string | null; detail: string | null; birthday: string | null; memory_ids: string[] }
export interface DiscoveredEvent { key: string; name: string; date: string; memory_ids: string[] }
export interface Discovery { projects: DiscoveredProject[]; contacts: DiscoveredContact[]; events: DiscoveredEvent[] }

const MAX_FACTS = 200;
const BATCH = 40;
const FACT_CHARS = 400;
const KINDS = new Set(["purchase", "event", "home", "travel", "work", "health", "learning", "admin", "other"]);
const STATUSES = new Set(["idea", "active", "paused", "done", "dropped"]);
/// The kinds of a contact card's relation (contacts.relation_type, the same
/// on the account: schema/contract.json).
export const CONTACT_RELATION_TYPES = ["family", "partner", "friend", "colleague", "client", "other"] as const;
const RELATIONS = new Set<string>(CONTACT_RELATION_TYPES);

export function discoveryPrompt(facts: Array<{ ref: string; text: string }>, known: { projects: string[]; contacts: string[] }): LearnMessages {
  return [
    {
      role: "system",
      content:
        "You read facts a person keeps about themselves (imported from another assistant) and list what they hold besides facts, to be made in their assistant:\n" +
        "- projects: what the person is working towards or runs over weeks or months (a company they founded, a website they build or look after for a client, a purchase, a move, a trip, a job search). " +
        "Not a preference or a way of working (« wants a detailed plan before any update » is no project), nor a step of another project (« moving to an SAS » belongs to the company's project: leave it out). " +
        "title: a short name in their language (« The Posterity Project », « Achat d'un Mac mini »); name: how they call it in a sentence when it differs from the title, else null; kind: purchase, event, home, travel, work, health, learning, admin or other; status: idea, active, paused, done or dropped.\n" +
        "- contacts: people of their life named in the facts (family, partner, friends, colleagues, clients, a lawyer, a doctor). name: as written; relation: family, partner, friend, colleague, client or other; detail: a few words on who they are (« avocate », « associé »), or null; birthday: YYYY-MM-DD when a fact gives the full date, else null. Never the person themselves.\n" +
        "- events: dated moments to keep in their calendar (a wedding, a deadline, a trip) with a full date: name and date YYYY-MM-DD. Not birthdays (they go with the contact).\n" +
        "Each item lists the facts it comes from in \"facts\" (their refs, like F3). Only what the facts say: never guess a date, a relation or a name. Leave out what KNOWN already has.\n" +
        "Answer with JSON only: {\"projects\":[{\"title\":\"…\",\"name\":null,\"kind\":\"work\",\"status\":\"active\",\"facts\":[\"F1\"]}],\"contacts\":[{\"name\":\"…\",\"relation\":\"friend\",\"detail\":null,\"birthday\":null,\"facts\":[\"F2\"]}],\"events\":[{\"name\":\"…\",\"date\":\"2026-06-12\",\"facts\":[\"F4\"]}]}. " +
        "Empty lists when there is nothing.",
    },
    {
      role: "user",
      content: `KNOWN projects: ${known.projects.join(" · ") || "(none)"}\nKNOWN contacts: ${known.contacts.join(" · ") || "(none)"}\n\nFACTS:\n${facts.map((fact) => `${fact.ref}: ${fact.text}`).join("\n")}`,
    },
  ];
}

const loose = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const validDate = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
};

/// The model's answer, held to the facts: every item cites facts given,
/// nothing already known comes again, nothing twice.
export function parseDiscovery(answer: string, refs: Map<string, string>, known: { projects: string[]; contacts: string[] }): Discovery {
  const out: Discovery = { projects: [], contacts: [], events: [] };
  const json = answer.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").match(/\{[\s\S]*\}/)?.[0];
  if (!json) return out;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return out;
  }
  const cited = (item: Record<string, unknown>) => (Array.isArray(item.facts) ? item.facts : []).map((ref) => refs.get(String(ref).trim())).filter((id): id is string => !!id);
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : null);
  const seen = new Set([...known.projects, ...known.contacts].map(loose));
  const list = (key: string) => (Array.isArray(parsed[key]) ? (parsed[key] as unknown[]) : []).filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  for (const item of list("projects")) {
    const title = text(item.title, 120);
    const memoryIds = cited(item);
    if (!title || !memoryIds.length || seen.has(loose(title))) continue;
    seen.add(loose(title));
    out.projects.push({
      key: randomUUID(), title, name: text(item.name, 120),
      kind: typeof item.kind === "string" && KINDS.has(item.kind) ? item.kind : "other",
      status: typeof item.status === "string" && STATUSES.has(item.status) ? item.status : "active",
      memory_ids: memoryIds,
    });
  }
  for (const item of list("contacts")) {
    const name = text(item.name, 120);
    const memoryIds = cited(item);
    if (!name || !memoryIds.length || seen.has(loose(name))) continue;
    seen.add(loose(name));
    out.contacts.push({
      key: randomUUID(), name,
      relation: typeof item.relation === "string" && RELATIONS.has(item.relation) ? item.relation : null,
      detail: text(item.detail, 120), birthday: validDate(item.birthday), memory_ids: memoryIds,
    });
  }
  for (const item of list("events")) {
    const name = text(item.name, 160);
    const date = validDate(item.date);
    const memoryIds = cited(item);
    if (!name || !date || !memoryIds.length || seen.has(loose(`${name} ${date}`))) continue;
    seen.add(loose(`${name} ${date}`));
    out.events.push({ key: randomUUID(), name, date, memory_ids: memoryIds });
  }
  return out;
}

export class DiscoveryError extends Error {
  constructor(public code: "no_model" | "no_memories") {
    super(code);
  }
}

/// Reads these memories of the person and proposes what to make of them.
export async function discoverFromMemories(userId: string, memoryIds: string[], ask: LearningModel | null = learningModel()): Promise<Discovery> {
  if (!ask) throw new DiscoveryError("no_model");
  const rows = memoryIds.slice(0, MAX_FACTS).flatMap((id) => {
    const row = sqlite.prepare("SELECT id, content FROM memories WHERE id = ? AND user_id = ? AND superseded_by_id IS NULL").get(id, userId) as { id: string; content: string } | undefined;
    return row && row.content.trim() ? [row] : [];
  });
  if (!rows.length) throw new DiscoveryError("no_memories");
  const known = {
    projects: knownProjects(userId).map((project) => project.title),
    contacts: (sqlite.prepare("SELECT name FROM contacts WHERE user_id = ? AND name IS NOT NULL").all(userId) as Array<{ name: string }>).map((row) => row.name),
  };
  // In batches a small model reads whole (some 4 000 tokens each); what one
  // batch found is known to the next.
  const out: Discovery = { projects: [], contacts: [], events: [] };
  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH);
    const refs = new Map(batch.map((row, index) => [`F${index + 1}`, row.id]));
    const facts = batch.map((row, index) => ({ ref: `F${index + 1}`, text: row.content.trim().replace(/\s+/g, " ").slice(0, FACT_CHARS) }));
    const found = parseDiscovery(await ask(userId, discoveryPrompt(facts, known)), refs, known);
    out.projects.push(...found.projects);
    out.contacts.push(...found.contacts);
    out.events.push(...found.events);
    known.projects.push(...found.projects.map((project) => project.title));
    known.contacts.push(...found.contacts.map((contact) => contact.name));
  }
  return out;
}

/// Makes what the person ticked: projects (tied to their memories by
/// their name, entities.ts), contacts, events. What exists already is left.
export function applyDiscovery(userId: string, chosen: Partial<Discovery>, now = Date.now()): { projects: string[]; contacts: string[]; events: string[] } {
  const made = { projects: [] as string[], contacts: [] as string[], events: [] as string[] };
  const known = new Set(knownProjects(userId).map((project) => loose(project.title)));
  for (const project of (chosen.projects ?? []).slice(0, 50)) {
    if (typeof project?.title !== "string" || !project.title.trim() || known.has(loose(project.title))) continue;
    known.add(loose(project.title));
    made.projects.push(createProject(userId, {
      title: project.title.trim().slice(0, 120),
      ...(typeof project.name === "string" && project.name.trim() ? { name: project.name.trim().slice(0, 120) } : {}),
      kind: (KINDS.has(project.kind) ? project.kind : "other") as never,
      status: (STATUSES.has(project.status) ? project.status : "active") as never,
    }, "learned", now));
  }
  // Dates in milliseconds, as every table (migration 2).
  const at = now;
  for (const contact of (chosen.contacts ?? []).slice(0, 200)) {
    if (typeof contact?.name !== "string" || !contact.name.trim()) continue;
    const name = contact.name.trim().slice(0, 120);
    if (sqlite.prepare("SELECT 1 FROM contacts WHERE user_id = ? AND lower(name) = lower(?)").get(userId, name)) continue;
    const id = randomUUID();
    sqlite.prepare("INSERT INTO contacts (id, user_id, name, relation_type, relation_subtype, origin, birthday, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'local', ?, ?, ?)")
      .run(id, userId, name, contact.relation && RELATIONS.has(contact.relation) ? contact.relation : null, typeof contact.detail === "string" ? contact.detail.slice(0, 120) : null, validDate(contact.birthday), at, at);
    made.contacts.push(id);
  }
  for (const event of (chosen.events ?? []).slice(0, 100)) {
    const date = validDate(event?.date);
    if (typeof event?.name !== "string" || !event.name.trim() || !date) continue;
    const start = Date.parse(`${date}T00:00:00Z`);
    if (sqlite.prepare("SELECT 1 FROM events WHERE user_id = ? AND lower(name) = lower(?) AND start_time = ?").get(userId, event.name.trim(), start)) continue;
    const id = randomUUID();
    sqlite.prepare("INSERT INTO events (id, user_id, name, status, kind, start_time, all_day, created_at, updated_at) VALUES (?, ?, ?, 'confirmed', 'event', ?, 1, ?, ?)")
      .run(id, userId, event.name.trim().slice(0, 160), start, at, at);
    made.events.push(id);
  }
  // The person chose to keep these people and dates: their Contacts and
  // Agenda are switched on, or what was made would serve nothing.
  if (made.contacts.length) setLocalCapability(userId, "contacts", true);
  if (made.events.length) setLocalCapability(userId, "calendar", true);
  return made;
}
