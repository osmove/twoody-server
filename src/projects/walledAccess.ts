import type { FastifyRequest } from "fastify";
import { sqlite } from "../db.js";
import { isThisComputersApp } from "../routes/usage.js";

// Who reaches a walled-off project (an isolated one, src/projects/isolation.ts:
// its documents, conversations, notes, tasks and reminders), and what is
// hidden from everyone else. One place, so that every route asks the same
// question:
//
//   this computer's own app (routes/usage.ts isThisComputersApp: the
//   owner's session, from this machine, not through a tunnel or a proxy).
//
// To anyone else — a phone, another computer of the network, a household
// member's device, a browser on the local network, the account — a walled-off
// project does not exist: not listed, « not found » when named.

type Auth = { userId: string; sessionId?: string; deviceId?: string; thisMachine?: boolean };

/// Whether this request may see and use the person's walled-off projects.
export async function reachesWalledProjects(_req: FastifyRequest, auth: Auth): Promise<boolean> {
  return isThisComputersApp(auth);
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
