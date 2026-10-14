import type { FastifyRequest } from "fastify";
import { sqlite } from "../db.js";
import { isThisComputersApp } from "../routes/usage.js";
import { meshRequester } from "../sessionTrust.js";
import { meshRoster } from "../vault/roster.js";

// Who reaches a walled-off project (an isolated one, src/projects/isolation.ts:
// its documents, conversations, notes, tasks and reminders), and what is
// hidden from everyone else. One place, so that every route asks the same
// question (docs/walled-projects-phone-review.md):
//
//   - this computer's own app (routes/usage.ts isThisComputersApp: the
//     owner's session, from this machine, not through a tunnel or a proxy);
//   - the person's own device (14/10/2026, their iPhone): exactly whom
//     sessionTrust.ts meshRequester names — a device session holding a
//     device-access/v2 signed by a person device of the verified roster, not
//     expired, asking through the tunnel from its own key; or the owner's
//     session where ownerHere holds. Never a household member's device, a
//     device paired by code that is no member of the history, another
//     computer's peer session, a firmware device's token, the account.
//
// To anyone else a walled-off project does not exist: not listed, « not
// found » when named. What only this computer's app may do with one —
// make one, its folder, its export, rename, archive or delete it, switch on
// for a message what reaches outside it — asks isThisComputersApp itself.

type Auth = { userId: string; sessionId?: string; deviceId?: string; thisMachine?: boolean };

/// Whether this request may see and use the person's walled-off projects.
export async function reachesWalledProjects(req: FastifyRequest, auth: Auth): Promise<boolean> {
  if (isThisComputersApp(auth)) return true;
  if (auth.deviceId || !auth.sessionId) return false;
  return (await meshRequester(req, auth, () => meshRoster().get())) !== null;
}

/// The person's walled-off projects, by id.
export function walledProjectIds(userId: string): Set<string> {
  return new Set((sqlite.prepare("SELECT id FROM projects WHERE user_id = ? AND isolated = 1").all(userId) as Array<{ id: string }>).map((row) => row.id));
}

/// What a request must not see: the ids of the walled-off projects, or none
/// when it reaches them.
export async function hiddenWalledProjects(req: FastifyRequest, auth: Auth): Promise<Set<string>> {
  return (await reachesWalledProjects(req, auth)) ? new Set() : walledProjectIds(auth.userId);
}

/// Whether a conversation is in a walled-off project.
export function walledConversation(discussionId: string | null | undefined): boolean {
  if (!discussionId) return false;
  return !!sqlite.prepare("SELECT 1 FROM discussions d JOIN projects p ON p.id = d.project_id AND p.user_id = d.user_id WHERE d.id = ? AND p.isolated = 1").get(discussionId);
}
