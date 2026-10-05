import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { isThisComputersApp } from "./usage.js";
import { accountWarnings, deleteKeptCopy, mailboxStatus, readAccountInput, removeMailbox, setUpMailbox, testMailbox } from "../email/account.js";
import { activeSource, foldersOf, recentEmails } from "../email/store.js";
import { syncMailbox, syncProgress } from "../email/sync.js";
import { capabilityOn } from "../localCapabilities.js";
import { formatAddress } from "../email/parse.js";

// Capacités → E-mails (src/email/), the page of this computer's app:
//   GET    /email/status      the mailbox set up (never its password or token), its sync, the copies kept
//   GET    /email/folders     INBOX, Sent and Drafts as found on the server
//   GET    /email/recent      the latest messages (?folder=inbox|sent&limit=)
//   POST   /email/test        { address, host, port, security?, username?, password } → the connection tried once;
//                             { auth: "graph", address, refresh_token?, scopes? } for an Outlook.com or Microsoft 365
//                             mailbox read through Microsoft Graph (the sign-in the Desktop's main process got, which
//                             becomes the link to Microsoft, or the link kept); { auth: "microsoft", address,
//                             refresh_token? } for one read over IMAP, as Twoody 0.13.76 linked them; { auth: "gmail",
//                             address, refresh_token?, scopes? } for a Gmail mailbox read through the Gmail API
//                             (« Se connecter avec Google »: the sign-in the Desktop's main process got, or the one kept).
//                             `warnings`: what the page says without refusing (a Gmail app password not of 16 letters)
//   POST   /email/account     the same, tried then kept; read at once
//   POST   /email/sync        read what is new, now
//   DELETE /email/account     ?keep_messages=true|false: stops, forgets the password or sign-in, keeps or deletes the copy
//   DELETE /email/kept/:id    a copy kept from a mailbox removed earlier, deleted
// What the messages say (recent) and every change: this computer's app
// only; the status and the folders: any of the person's sessions. No
// answer carries a password or a token.

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

/// How a refusal is answered.
function statusFor(error: string): number {
  if (error === "email_off") return 403;
  if (["not_configured", "signin_required", "not_linked"].includes(error)) return 409;
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

  app.get("/email/folders", {
    schema: { tags: ["email"], summary: "The folders of the mailbox Twoody reads and writes drafts to", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const source = activeSource(auth.userId);
      if (!source) return reply.send({ folders: [] });
      reply.send({
        folders: foldersOf(source.id).filter((folder) => folder.role).map((folder) => ({
          role: folder.role, path: folder.path, name: folder.name, special_use: folder.special_use,
          messages_on_server: folder.message_count, last_synced_at: folder.last_synced_at,
        })),
      });
    },
  });

  app.get<{ Querystring: { folder?: string; limit?: string } }>("/email/recent", {
    schema: { tags: ["email"], summary: "The latest messages kept on this computer (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (!capabilityOn(auth.userId, "email")) return reply.code(403).send({ error: "email_off" });
      const folder = req.query.folder === "inbox" || req.query.folder === "sent" ? req.query.folder : null;
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
      const source = activeSource(auth.userId);
      reply.send({
        messages: recentEmails(auth.userId, { sourceId: source?.id ?? null, folder, limit }).map((email) => ({
          id: email.id,
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

  app.post("/email/sync", {
    schema: { tags: ["email"], summary: "Read what is new in the mailbox, now (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (!capabilityOn(auth.userId, "email")) return reply.code(403).send({ error: "email_off" });
      const source = activeSource(auth.userId);
      if (!source) return reply.code(409).send({ error: "not_configured" });
      // Answered at once: the page follows it in /email/status.
      void syncMailbox(auth.userId).catch(() => undefined);
      reply.code(202).send({ sync: syncProgress(source.id) });
    },
  });

  app.delete<{ Querystring: { keep_messages?: string } }>("/email/account", {
    schema: { tags: ["email"], summary: "Remove the mailbox: no more sync, password or sign-in forgotten, the copy kept or deleted (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      const keep = req.query.keep_messages;
      if (keep !== "true" && keep !== "false") return reply.code(422).send({ error: "keep_messages_required" });
      if (!removeMailbox(auth.userId, keep === "true")) return reply.code(404).send({ error: "not_configured" });
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
