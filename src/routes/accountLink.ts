import type { FastifyInstance } from "fastify";
import { approveRequest, denyRequest, fetchPending, judge } from "../account/approvals.js";
import { BackendError } from "../account/backend.js";
import { linkState, linkView, logout, startLink } from "../account/link.js";
import { ensureAccountFile, fingerprint, linkedAccount } from "../account/store.js";
import { LocalOnlyError } from "../outbound.js";
import { isFresh } from "../pairing.js";
import { ownerRequest, requireOwner } from "../localAccess.js";

// Linking this server to an account, from its own console (`twoody-server
// login`, `twoody login`) or the admin token — and, while the server is
// fresh (no local account, no folder granted), from the network, so that
// Twoody Desktop can add a new Raspberry Pi to the account in one click
// (docs/multi-computer-design.md §2).
//
//   GET    /account/link       {state, user_code?, verification_uri?, verification_uri_complete?,
//                               expires_at?, account_computer_id?, fresh, fp, fingerprint, last_error?}
//   POST   /account/link       starts a new code (409 when already linked)
//   DELETE /account/link       leaves the account
//   GET    /account/approvals  requests waiting on this computer (console approval, rule 3)
//   POST   /account/approvals/:id {decision:"approve"|"deny"}
//
// On the network, and not fresh, GET says the state and nothing of the
// code; POST, DELETE and the approvals are this machine's (or the admin
// token's).

function failure(err: unknown): [number, { error: string; message: string }] {
  if (err instanceof LocalOnlyError) return [403, { error: "local_only", message: err.message }];
  if (err instanceof BackendError) {
    return [err.status === 429 ? 429 : 502, { error: err.code ?? "backend_error", message: err.message }];
  }
  return [502, { error: "backend_unreachable", message: err instanceof Error ? err.message : String(err) }];
}

export async function accountLinkRoutes(app: FastifyInstance) {
  const view = (owner: boolean) => {
    const fresh = isFresh();
    const current = linkView();
    const showCode = owner || fresh;
    return {
      state: current.state,
      ...(showCode && current.user_code
        ? {
            user_code: current.user_code,
            verification_uri: current.verification_uri,
            verification_uri_complete: current.verification_uri_complete ?? null,
            expires_at: current.expires_at,
          }
        : {}),
      ...(current.account_computer_id ? { account_computer_id: current.account_computer_id } : {}),
      ...(owner && current.last_error ? { last_error: current.last_error } : {}),
      fresh,
      // Eight hex characters of the pairing key, as Bonjour's `fp` says
      // and the backend's login shows: the approving screen compares them.
      fp: fingerprint(ensureAccountFile()),
      fingerprint: fingerprint(ensureAccountFile()),
    };
  };

  app.get("/account/link", {
    schema: { tags: ["session"], summary: "Whether this server is linked to a Twoody account (the code while it waits, to its console)" },
    handler: async (req, reply) => reply.send(view(ownerRequest(req))),
  });

  app.post("/account/link", {
    schema: { tags: ["session"], summary: "Start linking this server to a Twoody account: a code to type on a signed-in device" },
    handler: async (req, reply) => {
      const owner = ownerRequest(req);
      // A fresh server shows its code to the network anyway: starting one
      // from there adds nothing a neighbour could not already do.
      if (!owner && !isFresh()) {
        if (!requireOwner(req, reply)) return;
      }
      if (linkState() === "linked") return reply.code(409).send({ error: "already_linked", ...view(owner) });
      try {
        await startLink();
      } catch (err) {
        const [status, body] = failure(err);
        return reply.code(status).send(body);
      }
      return reply.code(201).send(view(owner));
    },
  });

  app.delete("/account/link", {
    schema: { tags: ["session"], summary: "Leave the Twoody account (this machine or the admin token)" },
    handler: async (req, reply) => {
      if (!requireOwner(req, reply)) return;
      await logout();
      return reply.send(view(true));
    },
  });

  app.get("/account/approvals", {
    schema: { tags: ["session"], summary: "Requests to use this server waiting for an approval (this machine or the admin token)" },
    handler: async (req, reply) => {
      if (!requireOwner(req, reply)) return;
      const account = linkedAccount();
      if (!account) return reply.code(409).send({ error: "not_linked" });
      try {
        const requests = await fetchPending(account);
        return reply.send({
          requests: requests.map((r) => ({ id: r.id, name: r.name, role: r.role, public_key: r.public_key, expires_at: r.expires_at, verdict: judge(r, account) })),
        });
      } catch (err) {
        const [status, body] = failure(err);
        return reply.code(status).send(body);
      }
    },
  });

  app.post<{ Params: { id: string }; Body: { decision?: string } }>("/account/approvals/:id", {
    schema: { tags: ["session"], summary: "Approve or deny a request on this server's console (rule 3)" },
    handler: async (req, reply) => {
      if (!requireOwner(req, reply)) return;
      const account = linkedAccount();
      if (!account) return reply.code(409).send({ error: "not_linked" });
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "deny") return reply.code(422).send({ error: "decision must be approve or deny" });
      try {
        const request = (await fetchPending(account)).find((r) => r.id === req.params.id);
        if (!request) return reply.code(404).send({ error: "not_found" });
        if (decision === "approve") await approveRequest(account, request);
        else await denyRequest(account, request);
        return reply.code(204).send();
      } catch (err) {
        const [status, body] = failure(err);
        return reply.code(status).send(body);
      }
    },
  });
}
