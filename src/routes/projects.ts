import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../auth.js";
import { requirePerson } from "./memories.js";
import { isThisComputersApp } from "./usage.js";
import { EntityError } from "../memory/entities.js";
import { FolderRejected } from "../documents/library.js";
import { createProject, deleteProject, linkToProject, listProjects, projectDetail, ProjectError, projectIsolated, readProjectInput, updateProject } from "../projects/projects.js";
import {
  addProjectNote, exportIsolatedProject, linkProjectFolder, listProjectNotes, readNoteContent, removeProjectNote, unlinkProjectFolder, updateProjectNote,
} from "../projects/isolation.js";

// /projects (docs/projects-design.md, lot P1): what the person is working
// towards and what hangs off it. The person's own, like the memories
// (requirePerson). Wire shape: an array on index, `{project: …}` in and out.
//
// An isolated project (a client file, src/projects/isolation.ts) is this
// computer's app's only, reading as writing: to anyone else it does not
// exist (the phone: later). Its own routes:
//   POST   /projects/:id/folders             { path } → the folder of its documents
//   DELETE /projects/:id/folders/:folder_id  → no longer its (the files stay)
//   GET    /projects/:id/export              → everything of it, for the app to write where the person says
// and, for any project, its notes:
//   GET    /projects/:id/notes               → { notes }
//   POST   /projects/:id/notes               { content } → { note } (200 with note: null when it holds it already)
//   PATCH  /projects/:id/notes/:note_id      { content?, pinned? } → { note }
//   DELETE /projects/:id/notes/:note_id      → 204

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ProjectError || err instanceof EntityError) return reply.code(err.status).send({ error: err.code });
  if (err instanceof FolderRejected) return reply.code(err.reason === "not_permitted" ? 403 : 422).send({ error: err.reason });
  throw err;
}

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

type Auth = NonNullable<Awaited<ReturnType<typeof requireAuth>>>;

/// The person, and a project they may reach from here: an isolated one
/// from this computer's app only — to anyone else it is « not found ».
async function reach(req: FastifyRequest, reply: FastifyReply, id: string | null = null): Promise<Auth | null> {
  const auth = await requireAuth(req, reply);
  if (!auth || !(await requirePerson(req, reply, auth))) return null;
  if (id !== null && projectIsolated(auth.userId, id) === true && !isThisComputersApp(auth)) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  return auth;
}

/// An isolated project's own routes: this computer's app only.
async function reachIsolated(req: FastifyRequest, reply: FastifyReply, id: string): Promise<Auth | null> {
  const auth = await reach(req, reply, id);
  if (!auth) return null;
  if (!isThisComputersApp(auth)) {
    reply.code(403).send({ error: "desktop_app_only" });
    return null;
  }
  return auth;
}

export async function projectRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { isolated?: string } }>("/projects", {
    schema: {
      tags: ["projects"], summary: "The person's projects, active first", security,
      querystring: { type: "object", properties: { isolated: { type: "string", enum: ["0", "1"], description: "« 1 »: the client files only; « 0 »: the others" } } },
    },
    handler: async (req, reply) => {
      const auth = await reach(req, reply);
      if (!auth) return;
      const wanted = req.query.isolated === "1" ? true : req.query.isolated === "0" ? false : null;
      if (!isThisComputersApp(auth)) {
        reply.send(wanted === true ? [] : listProjects(auth.userId, false));
        return;
      }
      reply.send(listProjects(auth.userId, wanted));
    },
  });

  app.get<{ Params: { id: string } }>("/projects/:id", {
    schema: { tags: ["projects"], summary: "A project with its memories, tasks, reminders, events, conversations, documents and notes", security },
    handler: async (req, reply) => {
      const auth = await reach(req, reply, req.params.id);
      if (!auth) return;
      try { reply.send({ project: projectDetail(auth.userId, req.params.id) }); } catch (err) { fail(reply, err); }
    },
  });

  app.post<{ Body: Record<string, unknown> | null }>("/projects", {
    schema: { tags: ["projects"], summary: "Start a project; an isolated one (a client file) with the folder of its documents (`folder_path`)", security },
    handler: async (req, reply) => {
      const auth = await reach(req, reply);
      if (!auth) return;
      try {
        const input = readProjectInput(req.body, true);
        if (input.isolated && !isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
        const id = createProject(auth.userId, input);
        const path = input.isolated && typeof req.body?.folder_path === "string" ? req.body.folder_path.trim() : "";
        // Made even when its folder cannot be: said, to choose another.
        let folderError: string | null = null;
        if (path) {
          try {
            await linkProjectFolder(auth.userId, id, path);
          } catch (err) {
            folderError = err instanceof ProjectError ? err.code : err instanceof FolderRejected ? err.reason : null;
            if (!folderError) throw err;
          }
        }
        reply.code(201).send({ project: projectDetail(auth.userId, id), ...(folderError ? { folder_error: folderError } : {}) });
      } catch (err) { fail(reply, err); }
    },
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/projects/:id", {
    schema: { tags: ["projects"], summary: "Change a project: title, kind, size, status, brief, due date, budget, names, reference", security },
    handler: async (req, reply) => {
      const auth = await reach(req, reply, req.params.id);
      if (!auth) return;
      try {
        updateProject(auth.userId, req.params.id, readProjectInput(req.body, false));
        reply.send({ project: projectDetail(auth.userId, req.params.id) });
      } catch (err) { fail(reply, err); }
    },
  });

  app.delete<{ Params: { id: string } }>("/projects/:id", {
    schema: { tags: ["projects"], summary: "Remove a project; what hung off it stays, unlinked (an isolated one only while empty)", security },
    handler: async (req, reply) => {
      const auth = await reach(req, reply, req.params.id);
      if (!auth) return;
      try { deleteProject(auth.userId, req.params.id); reply.code(204).send(); } catch (err) { fail(reply, err); }
    },
  });

  for (const [path, unlink] of [["/projects/:id/link", false], ["/projects/:id/unlink", true]] as const) {
    app.post<{ Params: { id: string }; Body: Record<string, unknown> | null }>(path, {
      schema: { tags: ["projects"], summary: unlink ? "Untie a task, reminder, event, conversation or document from the project" : "Tie a task, reminder, event, conversation or document to the project", security },
      handler: async (req, reply) => {
        const auth = await reach(req, reply, req.params.id);
        if (!auth) return;
        try {
          linkToProject(auth.userId, req.params.id, req.body ?? {}, unlink);
          reply.send({ project: projectDetail(auth.userId, req.params.id) });
        } catch (err) { fail(reply, err); }
      },
    });
  }

  app.post<{ Params: { id: string }; Body: { path?: unknown } }>("/projects/:id/folders", {
    schema: { tags: ["projects"], summary: "The folder of an isolated project's documents", security, body: { type: "object", required: ["path"], properties: { path: { type: "string", minLength: 1, maxLength: 4096 } } } },
    handler: async (req, reply) => {
      const auth = await reachIsolated(req, reply, req.params.id);
      if (!auth) return;
      try {
        await linkProjectFolder(auth.userId, req.params.id, String(req.body.path));
        reply.send({ project: projectDetail(auth.userId, req.params.id) });
      } catch (err) { fail(reply, err); }
    },
  });

  app.delete<{ Params: { id: string; folder_id: string } }>("/projects/:id/folders/:folder_id", {
    schema: { tags: ["projects"], summary: "A folder no longer an isolated project's (its files are not touched)", security },
    handler: async (req, reply) => {
      const auth = await reachIsolated(req, reply, req.params.id);
      if (!auth) return;
      try {
        unlinkProjectFolder(auth.userId, req.params.id, req.params.folder_id);
        reply.send({ project: projectDetail(auth.userId, req.params.id) });
      } catch (err) { fail(reply, err); }
    },
  });

  app.get<{ Params: { id: string } }>("/projects/:id/export", {
    schema: { tags: ["projects"], summary: "Everything of an isolated project, for the app to write where the person chooses", security },
    handler: async (req, reply) => {
      const auth = await reachIsolated(req, reply, req.params.id);
      if (!auth) return;
      try { reply.send(exportIsolatedProject(auth.userId, req.params.id)); } catch (err) { fail(reply, err); }
    },
  });

  app.get<{ Params: { id: string } }>("/projects/:id/notes", {
    schema: { tags: ["projects"], summary: "A project's notes, pinned first", security },
    handler: async (req, reply) => {
      const auth = await reach(req, reply, req.params.id);
      if (!auth) return;
      if (projectIsolated(auth.userId, req.params.id) === null) return reply.code(404).send({ error: "not_found" });
      reply.send({ notes: listProjectNotes(auth.userId, req.params.id) });
    },
  });

  app.post<{ Params: { id: string }; Body: { content?: unknown } }>("/projects/:id/notes", {
    schema: { tags: ["projects"], summary: "A note kept in a project", security, body: { type: "object", required: ["content"], properties: { content: { type: "string" } } } },
    handler: async (req, reply) => {
      const auth = await reach(req, reply, req.params.id);
      if (!auth) return;
      try {
        const note = addProjectNote(auth.userId, req.params.id, readNoteContent(req.body.content));
        reply.code(note ? 201 : 200).send({ note });
      } catch (err) { fail(reply, err); }
    },
  });

  app.patch<{ Params: { id: string; note_id: string }; Body: { content?: unknown; pinned?: unknown } }>("/projects/:id/notes/:note_id", {
    schema: { tags: ["projects"], summary: "Change or pin a note of a project", security, body: { type: "object", minProperties: 1, properties: { content: { type: "string" }, pinned: { type: "boolean" } } } },
    handler: async (req, reply) => {
      const auth = await reach(req, reply, req.params.id);
      if (!auth) return;
      try {
        reply.send({ note: updateProjectNote(auth.userId, req.params.id, req.params.note_id, {
          ...(req.body.content !== undefined ? { content: readNoteContent(req.body.content) } : {}),
          ...(typeof req.body.pinned === "boolean" ? { pinned: req.body.pinned } : {}),
        }) });
      } catch (err) { fail(reply, err); }
    },
  });

  app.delete<{ Params: { id: string; note_id: string } }>("/projects/:id/notes/:note_id", {
    schema: { tags: ["projects"], summary: "Remove a note of a project", security },
    handler: async (req, reply) => {
      const auth = await reach(req, reply, req.params.id);
      if (!auth) return;
      return removeProjectNote(auth.userId, req.params.id, req.params.note_id) ? reply.code(204).send() : reply.code(404).send({ error: "note_not_found" });
    },
  });
}
