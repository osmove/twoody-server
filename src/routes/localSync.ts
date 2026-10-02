import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { calendarEvents, contacts, db, sqlite } from "../db.js";
import { requireAuth } from "../auth.js";
import { isThisComputersApp } from "./usage.js";
import type { PersonalContact, PersonalEvent } from "../personalContext.js";
import { localCapabilities } from "../localCapabilities.js";

// Contacts and Calendar of this Mac, copied into the embedded server by the
// desktop app when the person turns them on in « Capacités » (29/09/2026): the
// app reads them with macOS's own permission (twoody-personal-data) and
// sends the whole set every 15 minutes. Each copy replaces the previous
// one, row for row, and never touches a contact or an event the person
// made here (source NULL). An empty set, sent when the switch is turned
// off, removes the copy. Only this computer's app may send it; nothing is
// sent anywhere from here: the chat reads it on this computer.

export const SYNC_SOURCES = ["macos"] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];

const MAX_CONTACTS = 20_000;
const MAX_EVENTS = 20_000;
const TEXT = 500;
const NOTES = 2_000;
const LIST = 10;

class Invalid extends Error {}

function text(value: unknown, max = TEXT): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const entry = text(item, 200);
    if (entry && !out.includes(entry)) out.push(entry);
    if (out.length >= LIST) break;
  }
  return out;
}

function source(value: unknown): SyncSource {
  if (value === undefined || value === null) return "macos";
  if (typeof value === "string" && (SYNC_SOURCES as readonly string[]).includes(value)) return value as SyncSource;
  throw new Invalid("source");
}

/// A stable row id for what the Mac calls `externalId`, so an event keeps
/// its id from one copy to the next.
function rowId(userId: string, src: SyncSource, externalId: string): string {
  return `${src}-${createHash("sha256").update(`${userId}\0${externalId}`).digest("hex").slice(0, 32)}`;
}

/// "1990-05-17" or "--05-17" (a birthday without its year).
function birthday(value: unknown): string | null {
  const raw = text(value, 40);
  return raw && /^(?:\d{4}|-)-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(raw) ? raw : null;
}

function instant(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function readContacts(raw: unknown): Array<{
  externalId: string; name: string | null; firstName: string | null; lastName: string | null;
  organization: string | null; phones: string[]; emails: string[]; birthday: string | null; addresses: string[];
}> {
  if (!Array.isArray(raw)) throw new Invalid("contacts");
  if (raw.length > MAX_CONTACTS) throw new Invalid("too_many");
  const seen = new Set<string>();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const externalId = text(row.id, 200);
    if (!externalId || seen.has(externalId)) continue;
    const firstName = text(row.given_name ?? row.first_name, 200);
    const lastName = text(row.family_name ?? row.last_name, 200);
    const organization = text(row.organization, 200);
    // A company's card is called by its organization, as in Contacts.
    const name = text(row.name, 300) ?? ([firstName, lastName].filter(Boolean).join(" ") || organization);
    const phones = list(row.phones);
    const emails = list(row.emails);
    // A card with nothing to call it by is of no use to the chat.
    if (!name && !organization && phones.length === 0 && emails.length === 0) continue;
    seen.add(externalId);
    out.push({ externalId, name, firstName, lastName, organization, phones, emails, birthday: birthday(row.birthday), addresses: list(row.addresses) });
  }
  return out;
}

export function readEvents(raw: unknown): Array<{
  externalId: string; title: string; start: Date; end: Date | null; allDay: boolean;
  location: string | null; calendar: string | null; notes: string | null;
}> {
  if (!Array.isArray(raw)) throw new Invalid("events");
  if (raw.length > MAX_EVENTS) throw new Invalid("too_many");
  const seen = new Set<string>();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const externalId = text(row.id, 300);
    const start = instant(row.start);
    if (!externalId || !start || seen.has(externalId)) continue;
    const end = instant(row.end);
    seen.add(externalId);
    out.push({
      externalId,
      title: text(row.title) ?? "",
      start,
      end: end && end >= start ? end : null,
      allDay: row.all_day === true,
      location: text(row.location),
      calendar: text(row.calendar, 200),
      notes: text(row.notes, NOTES),
    });
  }
  return out;
}

export function replaceContacts(userId: string, src: SyncSource, rows: ReturnType<typeof readContacts>): number {
  const now = new Date();
  sqlite.transaction(() => {
    db.delete(contacts).where(and(eq(contacts.userId, userId), eq(contacts.source, src))).run();
    for (const row of rows) {
      db.insert(contacts).values({
        id: rowId(userId, src, row.externalId),
        userId,
        name: row.name,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.emails[0] ?? null,
        phoneNumber: row.phones[0] ?? null,
        origin: src,
        source: src,
        externalId: row.externalId,
        organization: row.organization,
        phonesJson: JSON.stringify(row.phones),
        emailsJson: JSON.stringify(row.emails),
        birthday: row.birthday,
        addressesJson: row.addresses.length ? JSON.stringify(row.addresses) : null,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
  })();
  return rows.length;
}

export function replaceEvents(userId: string, src: SyncSource, rows: ReturnType<typeof readEvents>): number {
  const now = new Date();
  sqlite.transaction(() => {
    db.delete(calendarEvents).where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.source, src))).run();
    for (const row of rows) {
      db.insert(calendarEvents).values({
        id: rowId(userId, src, row.externalId),
        userId,
        name: row.title,
        notes: row.notes,
        startTime: row.start,
        endTime: row.end,
        allDay: row.allDay,
        location: row.location,
        source: src,
        externalId: row.externalId,
        calendar: row.calendar,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
  })();
  return rows.length;
}

function parseJsonList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/// What the chat may draw on for one turn: every contact (they are matched
/// by name in memory, accents and case aside), and the events from a month
/// ago to a year ahead.
export function loadPersonalData(userId: string, now = new Date()): { contacts: PersonalContact[]; events: PersonalEvent[] } {
  // Each only once switched on in Capabilities (localCapabilities.ts).
  const switches = localCapabilities(userId);
  const people = !switches.contacts ? [] : db
    .select()
    .from(contacts)
    .where(eq(contacts.userId, userId))
    .limit(MAX_CONTACTS + 1_000)
    .all()
    .map((row) => ({
      name: row.name || [row.firstName, row.lastName].filter(Boolean).join(" ") || null,
      firstName: row.firstName,
      lastName: row.lastName,
      organization: row.organization,
      phones: row.phonesJson ? parseJsonList(row.phonesJson) : [row.phoneNumber].filter((phone): phone is string => Boolean(phone)),
      emails: row.emailsJson ? parseJsonList(row.emailsJson) : [row.email].filter((email): email is string => Boolean(email)),
      birthday: row.birthday,
    }));
  const from = new Date(now.getTime() - 31 * 86_400_000);
  const to = new Date(now.getTime() + 366 * 86_400_000);
  const events = !switches.calendar ? [] : db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.userId, userId), gte(calendarEvents.startTime, from), lte(calendarEvents.startTime, to)))
    .orderBy(asc(calendarEvents.startTime))
    .limit(MAX_EVENTS + 1_000)
    .all()
    .map((row) => ({
      title: row.name,
      start: row.startTime,
      end: row.endTime,
      allDay: Boolean(row.allDay),
      location: row.location,
      calendar: row.calendar,
      notes: row.notes,
    }));
  return { contacts: people, events };
}

export async function localSyncRoutes(app: FastifyInstance) {
  const guard = async (req: Parameters<typeof requireAuth>[0], reply: Parameters<typeof requireAuth>[1]) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return null;
    if (!isThisComputersApp(auth)) {
      reply.code(403).send({ error: "desktop_app_only" });
      return null;
    }
    return auth;
  };

  app.put<{ Body: { source?: unknown; contacts?: unknown } }>("/local_sync/contacts", {
    bodyLimit: 32 * 1024 * 1024,
    schema: {
      tags: ["contacts"],
      summary: "Replace the contacts copied from this computer (its own app only)",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      try {
        const src = source(req.body?.source);
        const count = replaceContacts(auth.userId, src, readContacts(req.body?.contacts));
        return reply.send({ source: src, contacts: count });
      } catch (err) {
        if (err instanceof Invalid) return reply.code(422).send({ error: "invalid", field: err.message });
        throw err;
      }
    },
  });

  app.put<{ Body: { source?: unknown; events?: unknown } }>("/local_sync/events", {
    bodyLimit: 32 * 1024 * 1024,
    schema: {
      tags: ["events"],
      summary: "Replace the calendar events copied from this computer (its own app only)",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      try {
        const src = source(req.body?.source);
        const count = replaceEvents(auth.userId, src, readEvents(req.body?.events));
        return reply.send({ source: src, events: count });
      } catch (err) {
        if (err instanceof Invalid) return reply.code(422).send({ error: "invalid", field: err.message });
        throw err;
      }
    },
  });
}
