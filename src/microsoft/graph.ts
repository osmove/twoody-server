import { createHash } from "node:crypto";
import { capabilityOn } from "../localCapabilities.js";
import { GRAPH_ME, graphDoor, GraphDoorClosedError, graphFetch, type GraphCapabilitiesOn, type GraphDoorReason } from "../outbound.js";
import { MAX_CONTACTS, MAX_EVENTS } from "../personalSync.js";
import { GRAPH_CAPABILITIES, graphRefreshToken, renewGraphRefreshToken } from "./link.js";
import { microsoftAccess, MicrosoftSignInError, type MicrosoftSignInCode } from "./token.js";

// Microsoft Graph, with the link's access token (link.ts, token.ts) —
// through the door of src/outbound.ts, which opens only the addresses each
// capability declares, while it is on and the link is kept: GraphSession,
// the one place that sends a request to Graph, and graphRefusal, the one
// place where Graph's refusals become codes. Here for Outlook's calendar and
// contacts:
//   - the calendars (/me/calendars), then each one's view
//     (/me/calendars/{id}/calendarView) from 30 days ago to 365 days ahead,
//     as the Mac's helper reads its Calendar: a repeating event there once
//     per occurrence, every time in UTC (Prefer: outlook.timezone="UTC");
//   - the contacts (/me/contacts), and those of the folders made in them
//     (/me/contactFolders, one level down).
// The mailbox's folders and messages are read in mail.ts, with the same
// session. Each page Graph links to (@odata.nextLink) goes through the door
// like the first. Asked to slow down (429, or 503 with Retry-After), it
// waits what Graph says before asking again — or, for longer than a round,
// stops until then. The one thing ever written there is a draft the person
// allowed (post). What Graph refuses is said as a code, never its text.

/// The view's window, the Mac's (twoody-desktop personalDataSync.ts).
export const PAST_DAYS = 30;
export const FUTURE_DAYS = 365;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 30_000;
/// Tries of one address when Graph asks to wait.
const MAX_TRIES = 4;
/// Waited at most, in one go, between two tries; longer, the copy stops
/// until then.
const MAX_WAIT_MS = 2 * 60_000;
/// Pages of one list, at most: a guard against a list that never ends.
const MAX_PAGES = 2_500;
const PAGE = "250";

export type GraphErrorCode =
  | MicrosoftSignInCode | GraphDoorReason
  // Graph refuses this account's data to Twoody (401 with a new token, 403);
  // the account has no mailbox there (no calendar, contacts or mail); an item
  // listed earlier is gone since (a calendar, a folder: skipped); Graph asks
  // to wait longer than a round, cannot be reached, answers something else;
  // or the copy would hold more than a copy may; or a round of changes
  // (delta) Graph can no longer continue, to start again from the start.
  | "graph_refused" | "no_mailbox" | "gone" | "throttled" | "graph_unreachable" | "graph_failed" | "too_many" | "sync_reset";

export class GraphError extends Error {
  constructor(public code: GraphErrorCode, public status: number | null = null) {
    super(code);
    this.name = "GraphError";
  }
}

/// What went wrong, as one of a few words.
export function graphErrorCode(err: unknown): GraphErrorCode {
  if (err instanceof GraphError) return err.code;
  if (err instanceof MicrosoftSignInError) return err.code;
  if (err instanceof GraphDoorClosedError) return err.reason;
  return "graph_failed";
}

type DoorState = { linked: boolean; capabilitiesOn: GraphCapabilitiesOn };
type Transport = (target: string, init: RequestInit, door: DoorState) => Promise<Response>;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let transport: Transport = graphFetch;
let sleep: (ms: number) => Promise<void> = wait;

/// For the tests: Graph answered by a fake (null: the real one), and the
/// waits Graph asks for made by `sleep`. The door is asked all the same.
export function useGraphForTests(fake: ((target: string, init: RequestInit) => Promise<Response>) | null, options: { sleep?: (ms: number) => Promise<void> } = {}): void {
  transport = fake ? (target, init) => fake(target, init) : graphFetch;
  sleep = options.sleep ?? wait;
  holdUntil.clear();
}

/// Until when Graph asked a person's copies to wait, past a round.
const holdUntil = new Map<string, number>();

/// Whether Graph asked to wait, and until when (ms).
export function graphHeldUntil(userId: string, now = Date.now()): number | null {
  const until = holdUntil.get(userId);
  if (until === undefined) return null;
  if (until <= now) {
    holdUntil.delete(userId);
    return null;
  }
  return until;
}

/// Retry-After: seconds, or a date.
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/// What a refusal of Graph means — the one place where Graph's answers
/// become codes, from its status, its error's code (never its message,
/// which may name the account) and the address asked. An account Graph has
/// no mailbox for (MailboxNotEnabledForRESTAPI, MailboxNotFound,
/// NonExistentMailbox; or nothing found at a whole collection —
/// /me/calendars, /me/contacts, /me/mailFolders — nor at a folder every
/// mailbox has: its Inbox, Sent Items, Drafts) is `no_mailbox`; nothing
/// found below one — a calendar or a folder listed earlier, a message
/// removed since — `gone`. A round of changes Graph can no longer continue
/// (410, or its state token forgotten: syncStateNotFound) is `sync_reset`.
export function graphRefusal(status: number, body: unknown, target: string): GraphError {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof code === "string" && /^(?:Error)?(?:MailboxNotEnabledForRESTAPI|MailboxNotFound|NonExistentMailbox)$/i.test(code)) return new GraphError("no_mailbox", status);
  if (status === 410 || (typeof code === "string" && /^(?:syncStateNotFound|syncStateInvalid|resyncRequired)$/i.test(code))) return new GraphError("sync_reset", status);
  if (status === 401 || status === 403) return new GraphError("graph_refused", status);
  if (status === 404) {
    let below: string | null = null;
    try {
      below = new URL(target).pathname.replace(/^\/v1\.0\/me(?=\/|$)/i, "");
    } catch {
      // Not an address: said as anything else, below.
    }
    if (below !== null) return new GraphError(/^\/[^/]+$/.test(below) || /^\/mailFolders\/(?:inbox|sentitems|drafts)$/i.test(below) ? "no_mailbox" : "gone", status);
  }
  if (status === 429 || status === 503 || status === 504) return new GraphError("throttled", status);
  return new GraphError("graph_failed", status);
}

/// Reading with one link: its access token, renewed when needed, and each
/// request through the door as it stands at that moment.
export class GraphSession {
  private refreshToken: string;
  private access: string | null = null;

  /// `linking`: the link is being made — not kept yet, the token Microsoft
  /// gives back is the caller's to keep (`newestRefreshToken`).
  constructor(
    private readonly userId: string,
    private readonly linkId: string,
    refreshToken: string,
    private readonly scope: string,
    private readonly linking = false,
  ) {
    this.refreshToken = refreshToken;
  }

  get newestRefreshToken(): string {
    return this.refreshToken;
  }

  /// The door now: the capabilities that read Graph as they are, the link
  /// still the one kept (or being made).
  private door(): DoorState {
    return {
      linked: this.linking || graphRefreshToken(this.userId, this.linkId) !== null,
      capabilitiesOn: Object.fromEntries(GRAPH_CAPABILITIES.map((capability) => [capability, capabilityOn(this.userId, capability)])),
    };
  }

  /// An access token to Graph: from memory, or from Microsoft's token
  /// endpoint (token.ts) — `fresh`, Graph having refused the one held. The
  /// refresh token given back is kept in place of the one used.
  async accessToken(fresh = false): Promise<string> {
    const door = this.door();
    const got = await microsoftAccess(this.refreshToken, { scope: this.scope, door: { graphLinked: door.linked, capabilitiesOn: door.capabilitiesOn } }, { fresh });
    if (got.refreshToken !== this.refreshToken) {
      if (!this.linking) renewGraphRefreshToken(this.userId, this.linkId, this.refreshToken, got.refreshToken);
      this.refreshToken = got.refreshToken;
    }
    this.access = got.accessToken;
    return got.accessToken;
  }

  /// One page, as JSON — every time in UTC unless `prefer` says otherwise.
  get(url: string, options: { prefer?: string } = {}): Promise<Record<string, unknown>> {
    return this.request("GET", url, { prefer: options.prefer ?? 'outlook.timezone="UTC"' });
  }

  /// A draft created (E-mails, once the person allowed it): the only thing
  /// ever written at Graph. Never sent again once it may have reached Graph.
  post(url: string, body: string, contentType: string): Promise<Record<string, unknown>> {
    return this.request("POST", url, { body, contentType });
  }

  /// One request, through the door as it stands, answered as JSON. A token
  /// Graph refuses was perhaps withdrawn before its time: a new one is got,
  /// once. Asked to wait, it waits — a write only when Graph says it did
  /// nothing (429), a read whenever it says how long.
  private async request(method: "GET" | "POST", url: string, options: { prefer?: string; body?: string; contentType?: string }): Promise<Record<string, unknown>> {
    let renewed = false;
    for (let attempt = 1; ; attempt += 1) {
      const token = this.access ?? (await this.accessToken());
      let response: Response;
      try {
        // The door first, whoever answers.
        graphDoor(url, method, this.door());
        response = await transport(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(options.prefer ? { prefer: options.prefer } : {}),
            ...(options.contentType ? { "content-type": options.contentType } : {}),
          },
          ...(options.body !== undefined ? { body: options.body } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, this.door());
      } catch (err) {
        if (err instanceof GraphDoorClosedError) throw err;
        throw new GraphError("graph_unreachable");
      }
      if (response.status === 401 && !renewed) {
        renewed = true;
        await response.body?.cancel().catch(() => undefined);
        await this.accessToken(true);
        continue;
      }
      const waitAsked = response.status === 429 || (method === "GET" && (response.status === 503 || response.status === 504) && response.headers.has("retry-after"));
      if (waitAsked) {
        await response.body?.cancel().catch(() => undefined);
        const asked = retryAfterMs(response.headers.get("retry-after")) ?? 2 ** attempt * 1_000;
        if (asked > MAX_WAIT_MS) {
          holdUntil.set(this.userId, Date.now() + asked);
          throw new GraphError("throttled", response.status);
        }
        if (attempt >= MAX_TRIES) throw new GraphError("throttled", response.status);
        await sleep(asked);
        continue;
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.ok && body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
      throw graphRefusal(response.status, body, url);
    }
  }

  /// Every page of a list, following @odata.nextLink.
  async *pages(first: string, options: { prefer?: string } = {}): AsyncGenerator<Array<Record<string, unknown>>> {
    const seen = new Set<string>();
    let next: string | null = first;
    while (next) {
      if (seen.size >= MAX_PAGES || seen.has(next)) throw new GraphError("graph_failed");
      seen.add(next);
      const body = await this.get(next, options);
      yield Array.isArray(body.value) ? body.value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
      next = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : null;
    }
  }
}

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

function str(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/// Graph's ids are long; a copy's row is named by a hash of its id.
const idOf = (id: string) => createHash("sha256").update(id).digest("base64url");

// ── The calendar ────────────────────────────────────────────────────────

const EVENT_FIELDS = "id,subject,start,end,isAllDay,isCancelled,location,bodyPreview";

/// A row as the Mac's helper writes one (personalSync.ts readEvents).
export interface OutlookEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  all_day: boolean;
  location?: string;
  calendar: string;
  notes?: string;
}

/// An all-day event is a date, kept at midnight UTC as the app keeps its own
/// (the Agenda page, the memory import). Asked in UTC, Graph gives that
/// midnight; should it give instead the midnight of the zone the event was
/// made in, seen from UTC, the date is the nearest one — the next when more
/// than ten hours before it (Paris, Tokyo, New Zealand), the same when ten or
/// less after (New York, Hawaii).
function wholeDay(ms: number): number {
  const day = Math.floor(ms / DAY_MS) * DAY_MS;
  return ms - day > 10 * HOUR_MS ? day + DAY_MS : day;
}

/// Graph's { dateTime, timeZone }, asked in UTC. A time said in another
/// zone is not read as UTC: it is left out.
function graphInstant(value: unknown, allDay: boolean): Date | null {
  if (!value || typeof value !== "object") return null;
  const { dateTime, timeZone } = value as { dateTime?: unknown; timeZone?: unknown };
  if (typeof dateTime !== "string") return null;
  if (typeof timeZone === "string" && timeZone.trim() && !/^(?:utc|etc\/utc|coordinated universal time)$/i.test(timeZone.trim())) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?Z?$/.exec(dateTime.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", fraction = "0"] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.slice(0, 3).padEnd(3, "0")));
  if (Number.isNaN(ms)) return null;
  return new Date(allDay ? wholeDay(ms) : ms);
}

/// One occurrence, as a row; a cancelled one is left out.
export function eventRow(event: Record<string, unknown>, calendar: string | null): OutlookEvent | null {
  if (event.isCancelled === true) return null;
  const id = str(event.id, 2_000);
  const allDay = event.isAllDay === true;
  const start = graphInstant(event.start, allDay);
  if (!id || !start) return null;
  const end = graphInstant(event.end, allDay);
  const row: OutlookEvent = { id: idOf(id), title: str(event.subject) ?? "", start: start.toISOString(), all_day: allDay, calendar: calendar ?? "" };
  if (end && end >= start) row.end = end.toISOString();
  const location = str((event.location as { displayName?: unknown } | null)?.displayName);
  if (location) row.location = location;
  const notes = str(event.bodyPreview, 2_000);
  if (notes) row.notes = notes;
  return row;
}

/// Every calendar's events in the window, with its name.
export async function readOutlookEvents(session: GraphSession, now = new Date()): Promise<OutlookEvent[]> {
  const from = new Date(now.getTime() - PAST_DAYS * DAY_MS).toISOString();
  const to = new Date(now.getTime() + FUTURE_DAYS * DAY_MS).toISOString();
  const calendars: Array<{ id: string; name: string | null }> = [];
  for await (const page of session.pages(`${GRAPH_ME}/calendars?${query({ $select: "id,name", $top: "100" })}`)) {
    for (const calendar of page) {
      const id = str(calendar.id, 2_000);
      if (id) calendars.push({ id, name: str(calendar.name, 200) });
    }
  }
  const rows: OutlookEvent[] = [];
  for (const calendar of calendars) {
    const view = `${GRAPH_ME}/calendars/${encodeURIComponent(calendar.id)}/calendarView?${query({ startDateTime: from, endDateTime: to, $select: EVENT_FIELDS, $top: PAGE })}`;
    try {
      for await (const page of session.pages(view)) {
        for (const event of page) {
          const row = eventRow(event, calendar.name);
          if (!row) continue;
          rows.push(row);
          if (rows.length > MAX_EVENTS) throw new GraphError("too_many");
        }
      }
    } catch (err) {
      // A calendar removed since it was listed: nothing to read in it.
      if (err instanceof GraphError && err.code === "gone") continue;
      throw err;
    }
  }
  return rows;
}

// ── The contacts ────────────────────────────────────────────────────────

const CONTACT_FIELDS = "id,displayName,givenName,surname,companyName,emailAddresses,mobilePhone,businessPhones,homePhones,birthday,homeAddress,businessAddress,otherAddress";

/// A card as the Mac's helper writes one (personalSync.ts readContacts).
export interface OutlookContact {
  id: string;
  name: string;
  given_name: string;
  family_name: string;
  organization: string;
  phones: string[];
  emails: string[];
  birthday?: string;
  addresses: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => str(item, 200)).filter((item): item is string => !!item) : [];
}

/// Outlook keeps a birthday as an instant: near noon UTC, or the midnight
/// of the zone it was typed in. Its date is the nearest midnight's. A year
/// of 1604 is Outlook's for none.
export function birthdayOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const day = Math.floor(ms / DAY_MS) * DAY_MS;
  const date = new Date(ms - day > 12 * HOUR_MS ? day + DAY_MS : day).toISOString().slice(0, 10);
  return date.startsWith("1604-") ? `--${date.slice(5)}` : date;
}

/// « 1 rue de la Paix, 75002 Paris, France ».
function addressLine(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const address = value as Record<string, unknown>;
  const street = str(address.street)?.replace(/\s*\n\s*/g, ", ") ?? null;
  const city = [str(address.postalCode, 40), str(address.city, 200)].filter(Boolean).join(" ");
  const line = [street, city, str(address.state, 200), str(address.countryOrRegion, 200)].filter(Boolean).join(", ");
  return line || null;
}

/// One card, as a row.
export function contactRow(contact: Record<string, unknown>): OutlookContact | null {
  const id = str(contact.id, 2_000);
  if (!id) return null;
  const emails = Array.isArray(contact.emailAddresses)
    ? contact.emailAddresses.map((entry) => str((entry as { address?: unknown } | null)?.address, 200)).filter((address): address is string => !!address)
    : [];
  const phones = [...new Set([str(contact.mobilePhone, 200), ...strings(contact.businessPhones), ...strings(contact.homePhones)].filter((phone): phone is string => !!phone))];
  const row: OutlookContact = {
    id: idOf(id),
    name: str(contact.displayName, 300) ?? "",
    given_name: str(contact.givenName, 200) ?? "",
    family_name: str(contact.surname, 200) ?? "",
    organization: str(contact.companyName, 200) ?? "",
    phones,
    emails: [...new Set(emails)],
    addresses: [contact.homeAddress, contact.businessAddress, contact.otherAddress].map(addressLine).filter((line): line is string => !!line),
  };
  const birthday = birthdayOf(contact.birthday);
  if (birthday) row.birthday = birthday;
  return row;
}

/// The contacts, and those of the folders made in them, one level down.
export async function readOutlookContacts(session: GraphSession): Promise<OutlookContact[]> {
  const rows: OutlookContact[] = [];
  const seen = new Set<string>();
  const take = async (url: string) => {
    for await (const page of session.pages(url)) {
      for (const contact of page) {
        const row = contactRow(contact);
        if (!row || seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
        if (rows.length > MAX_CONTACTS) throw new GraphError("too_many");
      }
    }
  };
  await take(`${GRAPH_ME}/contacts?${query({ $select: CONTACT_FIELDS, $top: PAGE })}`);
  const folders: string[] = [];
  for await (const page of session.pages(`${GRAPH_ME}/contactFolders?${query({ $select: "id", $top: "100" })}`)) {
    for (const folder of page) {
      const id = str(folder.id, 2_000);
      if (id) folders.push(id);
    }
  }
  for (const id of folders) {
    try {
      await take(`${GRAPH_ME}/contactFolders/${encodeURIComponent(id)}/contacts?${query({ $select: CONTACT_FIELDS, $top: PAGE })}`);
    } catch (err) {
      // A folder removed since it was listed.
      if (err instanceof GraphError && err.code === "gone") continue;
      throw err;
    }
  }
  return rows;
}
