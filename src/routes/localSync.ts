import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { calendarEvents, contacts, db } from "../db.js";
import { requireAuth } from "../auth.js";
import { isThisComputersApp } from "./usage.js";
import type { PersonalContact, PersonalEvent } from "../personalContext.js";
import { localCapabilities } from "../localCapabilities.js";
import { storedValues } from "../contactFields.js";
import { InvalidCopy, MAX_CONTACTS, MAX_EVENTS, readContacts, readEvents, replaceContacts, replaceEvents, SYNC_SOURCES, type SyncSource } from "../personalSync.js";

// Contacts and Calendar of this Mac, copied into the embedded server by the
// desktop app when the person turns them on in « Capacités » (29/09/2026): the
// app reads them with macOS's own permission (twoody-personal-data) and
// sends the whole set every 15 minutes. Each copy replaces the previous
// one, row for row, and never touches another source's rows nor a contact
// or an event the person made here (source NULL) — src/personalSync.ts,
// shared with the copy of Outlook's that this server reads itself
// (src/microsoft/sync.ts). An empty set, sent when the switch is turned off,
// removes the copy. Only this computer's app may send it, and only its own
// source; nothing is sent anywhere from here: the chat reads it on this
// computer.

/// What this computer's app may send: the Mac's.
const APP_SOURCES: readonly SyncSource[] = ["macos"];

function source(value: unknown): SyncSource {
  if (value === undefined || value === null) return "macos";
  if (typeof value === "string" && (APP_SOURCES as readonly string[]).includes(value)) return value as SyncSource;
  throw new InvalidCopy("source");
}

/// What the chat may draw on for one turn: every contact (they are matched
/// by name in memory, accents and case aside), and the events from a month
/// ago to a year ahead — whatever their source, each copy as large as it
/// may be.
export function loadPersonalData(userId: string, now = new Date()): { contacts: PersonalContact[]; events: PersonalEvent[] } {
  // Each only once switched on in Capabilities (localCapabilities.ts).
  const switches = localCapabilities(userId);
  const people = !switches.contacts ? [] : db
    .select()
    .from(contacts)
    .where(eq(contacts.userId, userId))
    .limit(MAX_CONTACTS * SYNC_SOURCES.length + 1_000)
    .all()
    .map((row) => ({
      name: row.name || [row.firstName, row.lastName].filter(Boolean).join(" ") || null,
      firstName: row.firstName,
      lastName: row.lastName,
      organization: row.organization,
      phones: row.phonesJson ? storedValues(row.phonesJson) : [row.phoneNumber].filter((phone): phone is string => Boolean(phone)),
      emails: row.emailsJson ? storedValues(row.emailsJson) : [row.email].filter((email): email is string => Boolean(email)),
      birthday: row.birthday,
    }));
  const from = new Date(now.getTime() - 31 * 86_400_000);
  const to = new Date(now.getTime() + 366 * 86_400_000);
  const events = !switches.calendar ? [] : db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.userId, userId), gte(calendarEvents.startTime, from), lte(calendarEvents.startTime, to)))
    .orderBy(asc(calendarEvents.startTime))
    .limit(MAX_EVENTS * SYNC_SOURCES.length + 1_000)
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
        if (err instanceof InvalidCopy) return reply.code(422).send({ error: "invalid", field: err.message });
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
        if (err instanceof InvalidCopy) return reply.code(422).send({ error: "invalid", field: err.message });
        throw err;
      }
    },
  });
}
