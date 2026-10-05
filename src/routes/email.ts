import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { isThisComputersApp } from "./usage.js";
import { accountWarnings, deleteKeptCopy, mailboxStatus, readAccountInput, removeMailbox, setUpMailbox, testMailbox } from "../email/account.js";
import { activeSource, activeSources, foldersOf, recentEmails, sourceAddresses, sourceById } from "../email/store.js";
import { syncMailbox, syncProgress } from "../email/sync.js";
import { capabilityOn } from "../localCapabilities.js";
import { formatAddress } from "../email/parse.js";

// Capacités → E-mails (src/email/), the page of this computer's app — the
// person's mailboxes, several (each `id`):
//   GET    /email/status      the mailboxes set up (never a password or token), each with its sync, the copies kept
//   GET    /email/folders     INBOX, Sent and Drafts as found on the server (?id=: of that mailbox; the first one otherwise)
//   GET    /email/recent      the latest messages, each with its mailbox (?folder=inbox|sent&mailbox=<id>&limit=: all of them without one)
//   POST   /email/test        { address, host, port, security?, username?, password } → the connection tried once;
//                             { auth: "graph", address, refresh_token?, scopes? } for an Outlook.com or Microsoft 365
//                             mailbox read through Microsoft Graph (the sign-in the Desktop's main process got, which
//                             becomes the link to Microsoft, or the link kept); { auth: "microsoft", address,
//                             refresh_token? } for one read over IMAP, as Twoody 0.13.76 linked them; { auth: "gmail",
//                             address, refresh_token?, scopes? } for a Gmail mailbox read through the Gmail API
//                             (« Se connecter avec Google »: the sign-in the Desktop's main process got, or the one kept).
//                             `warnings`: what the page says without refusing (a Gmail app password not of 16 letters)
//                             `id`: the mailbox being changed (« Modifier »); without it, one added — or the one at
//                             the same address changed
//   POST   /email/account     the same, tried then kept; read at once
//   POST   /email/sync        read what is new, now (?id=: in that mailbox; in each of them otherwise)
//   DELETE /email/account     ?id=&keep_messages=true|false: stops that mailbox (the only one, without an id), forgets
//                             its password or sign-in, keeps or deletes its copy
//   DELETE /email/kept/:id    a copy kept from a mailbox removed earlier, deleted
// What the messages say (recent) and every change: this computer's app
// only; the status and the folders: any of the person's sessions. No
// answer carries a password or a token.

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

/// How a refusal is answered.
function statusFor(error: string): number {
  if (error === "email_off") return 403;
  if (["not_configured", "signin_required", "not_linked", "microsoft_one_account"].includes(error)) return 409;
  if (error === "mailbox_not_found") return 404;
  if ([
    "auth_failed", "host_not_found", "unreachable", "tls_failed", "timeout", "no_inbox", "failed", "admin_consent_required", "signin_failed", "signin_unreachable", "imap_refused",
    // Through Microsoft Graph.
    "no_mailbox", "graph_refused", "throttled", "graph_unreachable", "graph_failed", "gone", "sync_reset", "other_address", "method_not_allowed",
    // What the IMAP server's own words said.
    "app_password_required", "imap_disabled", "web_login_required", "too_many_connections",
    // Through the Gmail API.
    "gmail_refused", "gmail_unreachable", "gmail_failed", "other_account",
  ].includes(error)) return 502;
  return 422;
}

const accountBody = {
  type: "object",
  properties: {
    id: { type: "string", maxLength: 64 },
    address: { type: "string", maxLength: 320 },
    host: { type: "string", maxLength: 253 },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    security: { type: "string", enum: ["tls", "starttls"] },
    username: { type: "string", maxLength: 320 },
    password: { type: "string", maxLength: 1000 },
    window_days: { type: "integer" },
    preset: { type: "string", maxLength: 30 },
    auth: { type: "string", enum: ["password", "microsoft", "graph", "gmail"] },
    refresh_token: { type: "string", maxLength: 16384 },
    scopes: { type: "string", maxLength: 4096 },
  },
};

export async function emailRoutes(app: FastifyInstance) {
  app.get("/email/status", {
    schema: { tags: ["email"], summary: "The mailbox set up (never its password or token), its sync, the copies kept", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send(mailboxStatus(auth.userId));
    },
  });

  app.get<{ Querystring: { id?: string } }>("/email/folders", {
    schema: { tags: ["email"], summary: "The folders of a mailbox Twoody reads and writes drafts to (?id=; the first one otherwise)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const named = typeof req.query.id === "string" && req.query.id ? sourceById(auth.userId, req.query.id) : null;
      const source = named && named.status !== "removed" ? named : req.query.id ? null : activeSource(auth.userId);
      if (!source) return reply.send({ folders: [] });
      reply.send({
        id: source.id,
        folders: foldersOf(source.id).filter((folder) => folder.role).map((folder) => ({
          role: folder.role, path: folder.path, name: folder.name, special_use: folder.special_use,
          messages_on_server: folder.message_count, last_synced_at: folder.last_synced_at,
        })),
      });
    },
  });

  app.get<{ Querystring: { folder?: string; limit?: string; mailbox?: string } }>("/email/recent", {
    schema: { tags: ["email"], summary: "The latest messages kept on this computer, each with its mailbox (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (!capabilityOn(auth.userId, "email")) return reply.code(403).send({ error: "email_off" });
      const folder = req.query.folder === "inbox" || req.query.folder === "sent" ? req.query.folder : null;
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
      const active = activeSources(auth.userId);
      // One mailbox of the person's, or all of those set up.
      const named = typeof req.query.mailbox === "string" && req.query.mailbox && req.query.mailbox !== "all" ? active.find((source) => source.id === req.query.mailbox) : null;
      if (req.query.mailbox && req.query.mailbox !== "all" && !named) return reply.send({ messages: [] });
      const addresses = sourceAddresses(auth.userId);
      const messages = named
        ? recentEmails(auth.userId, { sourceId: named.id, folder, limit })
        : active.length ? recentEmails(auth.userId, { sourceIds: active.map((source) => source.id), folder, limit }) : [];
      reply.send({
        messages: messages.map((email) => ({
          id: email.id,
          mailbox: { id: email.email_source_id, address: addresses.get(email.email_source_id) ?? null },
          folder: email.status,
          subject: email.subject,
          from: email.from_email ? formatAddress({ name: email.from_name, address: email.from_email }) : null,
          to: email.recipients.to.slice(0, 5).map(formatAddress),
          date: email.provider_internal_date ? new Date(email.provider_internal_date).toISOString() : null,
          is_read: email.is_read,
          is_replied: email.is_replied,
          important: email.important,
          attachments: email.attachments.length,
          preview: (email.text_body ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
        })),
      });
    },
  });

  app.post<{ Body: unknown }>("/email/test", {
    schema: { tags: ["email"], summary: "Try a mailbox's settings: one connection, nothing read (this computer's app only)", security, body: accountBody },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (!capabilityOn(auth.userId, "email")) return reply.code(403).send({ error: "email_off" });
      const read = readAccountInput(auth.userId, req.body);
      if (!read.ok) return reply.code(statusFor(read.error)).send({ error: read.error });
      const tested = await testMailbox(auth.userId, read.input);
      if (!tested.ok) return reply.code(statusFor(tested.error)).send({ error: tested.error });
      reply.send({ ok: true, folders: tested.folders, warnings: accountWarnings(read.input) });
    },
  });

  app.post<{ Body: unknown }>("/email/account", {
    schema: { tags: ["email"], summary: "Set up the mailbox: tried, then kept, then read (this computer's app only)", security, body: accountBody },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (!capabilityOn(auth.userId, "email")) return reply.code(403).send({ error: "email_off" });
      const done = await setUpMailbox(auth.userId, req.body);
      if (!done.ok) return reply.code(statusFor(done.error)).send({ error: done.error });
      reply.send({ ok: true, folders: done.folders, warnings: done.warnings, status: mailboxStatus(auth.userId) });
    },
  });

  app.post<{ Querystring: { id?: string } }>("/email/sync", {
    schema: { tags: ["email"], summary: "Read what is new in a mailbox (?id=), or in each of them, now (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (!capabilityOn(auth.userId, "email")) return reply.code(403).send({ error: "email_off" });
      const id = typeof req.query.id === "string" && req.query.id ? req.query.id : null;
      const named = id ? sourceById(auth.userId, id) : null;
      if (id && (!named || named.status === "removed")) return reply.code(404).send({ error: "mailbox_not_found" });
      const source = named ?? activeSource(auth.userId);
      if (!source) return reply.code(409).send({ error: "not_configured" });
      // Answered at once: the page follows it in /email/status.
      void syncMailbox(auth.userId, id).catch(() => undefined);
      reply.code(202).send({ sync: syncProgress(source.id) });
    },
  });

  app.delete<{ Querystring: { keep_messages?: string; id?: string } }>("/email/account", {
    schema: { tags: ["email"], summary: "Remove a mailbox (?id=; the only one without): no more sync, password or sign-in forgotten, the copy kept or deleted (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      const keep = req.query.keep_messages;
      if (keep !== "true" && keep !== "false") return reply.code(422).send({ error: "keep_messages_required" });
      const removed = removeMailbox(auth.userId, typeof req.query.id === "string" && req.query.id ? req.query.id : null, keep === "true");
      if (!removed.ok) return reply.code(removed.error === "mailbox_required" ? 422 : 404).send({ error: removed.error });
      reply.send(mailboxStatus(auth.userId));
    },
  });

  app.delete<{ Params: { id: string } }>("/email/kept/:id", {
    schema: { tags: ["email"], summary: "Delete the copy kept from a mailbox removed earlier (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (!deleteKeptCopy(auth.userId, req.params.id)) return reply.code(404).send({ error: "not_found" });
      reply.send(mailboxStatus(auth.userId));
    },
  });
}
