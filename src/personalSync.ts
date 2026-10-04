import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { calendarEvents, contacts, db, sqlite } from "./db.js";
import { toStored } from "./contactFields.js";

// The person's contacts and calendar copied from elsewhere, each copy by its
// source: « macos », the Mac's Contacts and Calendar sent by this computer's
// app (routes/localSync.ts, 29/09/2026); « microsoft », Outlook's or
// Microsoft 365's read by this server through Microsoft Graph
// (src/microsoft/sync.ts, 04/10/2026). Each copy replaces the previous one
// of its source, row for row, and never touches another source's rows nor a
// contact or an event the person made here (source NULL). An empty copy
// removes it. The chat reads them all on this computer
// (routes/localSync.ts loadPersonalData).

export const SYNC_SOURCES = ["macos", "microsoft"] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];

/// Rows in one copy, at most.
export const MAX_CONTACTS = 20_000;
export const MAX_EVENTS = 20_000;
const TEXT = 500;
const NOTES = 2_000;
const LIST = 10;

/// A copy that cannot be kept: what is wrong with it (a field, or too_many).
export class InvalidCopy extends Error {}

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

/// A stable row id for what the source calls `externalId`, so an event keeps
/// its id from one copy to the next: a UUID (migration 2 turned the
/// « macos-<hex> » of before into the UUID of that same hex).
export function rowId(userId: string, src: SyncSource, externalId: string): string {
  const hex = createHash("sha256").update(src === "macos" ? `${userId}\0${externalId}` : `${src}\0${userId}\0${externalId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
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
  if (!Array.isArray(raw)) throw new InvalidCopy("contacts");
  if (raw.length > MAX_CONTACTS) throw new InvalidCopy("too_many");
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
  if (!Array.isArray(raw)) throw new InvalidCopy("events");
  if (raw.length > MAX_EVENTS) throw new InvalidCopy("too_many");
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
        phonesJson: toStored(row.phones),
        emailsJson: toStored(row.emails),
        birthday: row.birthday,
        addressesJson: row.addresses.length ? toStored(row.addresses) : null,
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

/// How many rows a source's copy holds.
export function copySize(userId: string, src: SyncSource): { contacts: number; events: number } {
  const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? AND source = ?`).get(userId, src) as { n: number }).n;
  return { contacts: count("contacts"), events: count("events") };
}
