import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { requirePerson } from "./memories.js";
import { EntityError } from "../memory/entities.js";
import { createProject, deleteProject, linkToProject, listProjects, projectDetail, ProjectError, readProjectInput, updateProject } from "../projects/projects.js";

// /projects (docs/projects-design.md, lot P1): what the person is working
// towards and what hangs off it. The person's own, like the memories
// (requirePerson). Wire shape: an array on index, `{project: …}` in and out.

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ProjectError || err instanceof EntityError) return reply.code(err.status).send({ error: err.code });
  throw err;
}

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

export async function projectRoutes(app: FastifyInstance) {
  app.get("/projects", {
    schema: { tags: ["projects"], summary: "The person's projects, active first", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth || !(await requirePerson(req, reply, auth))) return;
      reply.send(listProjects(auth.userId));
    },
  });

  app.get<{ Params: { id: string } }>("/projects/:id", {
    schema: { tags: ["projects"], summary: "A project with its memories, tasks, reminders, events, conversations and documents", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth || !(await requirePerson(req, reply, auth))) return;
      try { reply.send({ project: projectDetail(auth.userId, req.params.id) }); } catch (err) { fail(reply, err); }
    },
  });

  app.post<{ Body: unknown }>("/projects", {
    schema: { tags: ["projects"], summary: "Start a project", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth || !(await requirePerson(req, reply, auth))) return;
      try {
        const id = createProject(auth.userId, readProjectInput(req.body, true));
        reply.code(201).send({ project: projectDetail(auth.userId, id) });
      } catch (err) { fail(reply, err); }
    },
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/projects/:id", {
    schema: { tags: ["projects"], summary: "Change a project: title, kind, size, status, brief, due date, budget, names", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth || !(await requirePerson(req, reply, auth))) return;
      try {
        updateProject(auth.userId, req.params.id, readProjectInput(req.body, false));
        reply.send({ project: projectDetail(auth.userId, req.params.id) });
      } catch (err) { fail(reply, err); }
    },
  });

  app.delete<{ Params: { id: string } }>("/projects/:id", {
    schema: { tags: ["projects"], summary: "Remove a project; what hung off it stays, unlinked", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth || !(await requirePerson(req, reply, auth))) return;
      try { deleteProject(auth.userId, req.params.id); reply.code(204).send(); } catch (err) { fail(reply, err); }
    },
  });

  for (const [path, unlink] of [["/projects/:id/link", false], ["/projects/:id/unlink", true]] as const) {
    app.post<{ Params: { id: string }; Body: Record<string, unknown> | null }>(path, {
      schema: { tags: ["projects"], summary: unlink ? "Untie a task, reminder, event, conversation or document from the project" : "Tie a task, reminder, event, conversation or document to the project", security },
      handler: async (req, reply) => {
        const auth = await requireAuth(req, reply);
        if (!auth || !(await requirePerson(req, reply, auth))) return;
        try {
          linkToProject(auth.userId, req.params.id, req.body ?? {}, unlink);
          reply.send({ project: projectDetail(auth.userId, req.params.id) });
        } catch (err) { fail(reply, err); }
      },
    });
  }
}
