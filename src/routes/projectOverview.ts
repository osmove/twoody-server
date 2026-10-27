import type { FastifyInstance, FastifyReply } from "fastify";
import { sqlite } from "../db.js";
import { isThisComputersApp } from "./usage.js";
import { reach, type Auth } from "./projects.js";
import { capabilityOn } from "../localCapabilities.js";
import { addFolder, canonicalFolder, FolderRejected, folderLayout, reindex } from "../documents/library.js";
import { within as sameOrInside } from "../documents/samePath.js";
import { overviewLanguage } from "../projects/overview/prompts.js";
import { decideProposal, ensureOverview, overviewFor, pendingProposal, setFolder, setLanguage, type OverviewRow, type Section } from "../projects/overview/store.js";
import { overviewFailure, overviewLastRun, overviewProgress, overviewStale, requestOverview } from "../projects/overview/run.js";
import { overviewDocument, overviewWords } from "../projects/overview/document.js";

// A project's overview (« Synthèse du projet », docs/project-overview-design.md
// §4): reached as the project is (routes/projects.ts reach — a walled-off
// one by this computer's app and the person's own devices only). A device
// never gets a path; the folder of a project and the Word export of a
// walled-off one are this computer's app's.
//   GET    /projects/:id/overview                   → { overview } (null when none was made)
//   POST   /projects/:id/overview                   { language, fresh? } → make it (202)
//   PUT    /projects/:id/overview/folder            { path } → the folder of a project that is not walled off
//   POST   /projects/:id/overview/refresh           → look for changes now (a pass, then a proposal)
//   POST   /projects/:id/overview/proposal/apply    → the proposal becomes the overview
//   POST   /projects/:id/overview/proposal/ignore   → the overview stays as it is
//   GET    /projects/:id/overview/document          → the overview as a Word document

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

function isolatedOf(userId: string, projectId: string): boolean | null {
  const row = sqlite.prepare("SELECT isolated FROM projects WHERE id = ? AND user_id = ?").get(projectId, userId) as { isolated: number } | undefined;
  return row ? row.isolated === 1 : null;
}

function withPaths(sections: Section[], auth: Auth, userId: string): Section[] {
  if (!isThisComputersApp(auth)) return sections;
  const pathOf = sqlite.prepare("SELECT path FROM documents WHERE id = ? AND user_id = ?");
  return sections.map((section) => ({
    ...section,
    lines: section.lines.map((line) => ({ ...line, sources: line.sources.map((source) => ({ ...source, path: (pathOf.get(source.document_id, userId) as { path: string } | undefined)?.path ?? null })) })),
  }));
}

function serialize(overview: OverviewRow, auth: Auth) {
  const app = isThisComputersApp(auth);
  const proposal = pendingProposal(overview.id);
  const documents = overview.documents;
  return {
    id: overview.id,
    language: overview.language,
    ...(app ? { folder: overview.folder } : {}),
    folder_name: overview.folder ? overview.folder.split(/[\\/]/).filter(Boolean).pop() ?? overview.folder : null,
    built_at: overview.builtAt ? new Date(overview.builtAt).toISOString() : null,
    sections: overview.sections ? withPaths(overview.sections, auth, overview.userId) : null,
    documents: documents ? { read: documents.read, unreadable: documents.unreadable.map(({ name, reason }) => ({ name, reason })), partial: documents.partial.map(({ name }) => ({ name })) } : null,
    proposal: proposal
      ? { id: proposal.id, created_at: new Date(proposal.createdAt).toISOString(), changes: proposal.changes, sections: withPaths(proposal.sections, auth, overview.userId) }
      : null,
    progress: overviewProgress(overview.projectId),
    error: overviewFailure(overview.projectId),
    last_run: overviewLastRun(overview.projectId),
    stale: overview.sections ? overviewStale(overview.userId, overview) : false,
  };
}

/// The project, reached from here; a walled-off one's folder and export
/// are this computer's app's.
async function project(req: Parameters<typeof reach>[0], reply: FastifyReply, id: string): Promise<{ auth: Auth; isolated: boolean } | null> {
  const auth = await reach(req, reply, id);
  if (!auth) return null;
  const isolated = isolatedOf(auth.userId, id);
  if (isolated === null) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  return { auth, isolated };
}

export async function projectOverviewRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/projects/:id/overview", {
    schema: { tags: ["projects"], summary: "A project's overview, read from its documents: sections, lines with their sources, a proposal waiting, progress", security },
    handler: async (req, reply) => {
      const reached = await project(req, reply, req.params.id);
      if (!reached) return;
      const overview = overviewFor(reached.auth.userId, req.params.id);
      reply.send({ overview: overview ? serialize(overview, reached.auth) : null });
    },
  });

  app.post<{ Params: { id: string }; Body: { language?: unknown; fresh?: unknown } | null }>("/projects/:id/overview", {
    schema: { tags: ["projects"], summary: "Make the project's overview from its documents (in the background; `fresh`: read and write everything again)", security },
    handler: async (req, reply) => {
      const reached = await project(req, reply, req.params.id);
      if (!reached) return;
      const { auth, isolated } = reached;
      if (!capabilityOn(auth.userId, "documents")) return reply.code(409).send({ error: "documents_off" });
      const language = overviewLanguage(req.body?.language);
      const fresh = req.body?.fresh === true;
      let overview = ensureOverview(auth.userId, req.params.id, language);
      if (!isolated && !overview.folder) return reply.code(409).send({ error: "no_folder", overview: serialize(overview, auth) });
      if (fresh && overview.language !== language) {
        setLanguage(overview.id, language);
        overview = overviewFor(auth.userId, req.params.id)!;
      }
      requestOverview(auth.userId, req.params.id, { fresh: fresh || !overview.sections, first: true });
      reply.code(202).send({ overview: serialize(overview, auth) });
    },
  });

  app.put<{ Params: { id: string }; Body: { path?: unknown; language?: unknown } }>("/projects/:id/overview/folder", {
    schema: {
      tags: ["projects"],
      summary: "The folder whose documents a project's overview reads (a project that is not walled off; granted now when it was not)",
      security,
      body: { type: "object", required: ["path"], properties: { path: { type: "string", minLength: 1, maxLength: 4096 }, language: { type: "string" } } },
    },
    handler: async (req, reply) => {
      const reached = await project(req, reply, req.params.id);
      if (!reached) return;
      const { auth, isolated } = reached;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (isolated) return reply.code(409).send({ error: "walled_project_folder" });
      let path: string;
      try {
        path = canonicalFolder(String(req.body.path));
      } catch (err) {
        if (err instanceof FolderRejected) return reply.code(422).send({ error: err.reason });
        throw err;
      }
      const rows = sqlite.prepare("SELECT id, path, project_id AS projectId FROM document_folders WHERE user_id = ?").all(auth.userId) as Array<{ id: string; path: string; projectId: string | null }>;
      const layout = folderLayout(rows);
      // Never a walled-off project's folder, nor a folder inside one.
      if (rows.some((row) => layout.projectOf.get(row.id) && sameOrInside(row.path, path))) return reply.code(409).send({ error: "walled_folder" });
      const granted = rows.some((row) => !layout.projectOf.get(row.id) && sameOrInside(row.path, path));
      if (!granted) {
        try {
          await addFolder(auth.userId, path);
        } catch (err) {
          if (err instanceof FolderRejected && err.reason !== "already_added") return reply.code(err.reason === "not_permitted" ? 403 : 422).send({ error: err.reason });
          if (!(err instanceof FolderRejected)) throw err;
        }
      }
      const overview = ensureOverview(auth.userId, req.params.id, overviewLanguage(req.body.language));
      setFolder(overview.id, path);
      // What is in it is read now; the overview, when the person asks.
      if (!granted) void reindex(auth.userId).catch(() => undefined);
      reply.send({ overview: serialize(overviewFor(auth.userId, req.params.id)!, auth) });
    },
  });

  app.post<{ Params: { id: string } }>("/projects/:id/overview/refresh", {
    schema: { tags: ["projects"], summary: "Look for changed documents now: a pass of the index, then a proposal when the overview would change", security },
    handler: async (req, reply) => {
      const reached = await project(req, reply, req.params.id);
      if (!reached) return;
      const { auth } = reached;
      const overview = overviewFor(auth.userId, req.params.id);
      if (!overview?.sections) return reply.code(409).send({ error: "no_overview" });
      if (!capabilityOn(auth.userId, "documents")) return reply.code(409).send({ error: "documents_off" });
      void reindex(auth.userId)
        .catch(() => undefined)
        .then(() => requestOverview(auth.userId, req.params.id, { first: true }));
      reply.code(202).send({ overview: serialize(overview, auth) });
    },
  });

  for (const [path, apply] of [["/projects/:id/overview/proposal/apply", true], ["/projects/:id/overview/proposal/ignore", false]] as const) {
    app.post<{ Params: { id: string } }>(path, {
      schema: { tags: ["projects"], summary: apply ? "The overview proposed becomes the project's overview" : "The overview proposed is set aside; the overview stays as it is", security },
      handler: async (req, reply) => {
        const reached = await project(req, reply, req.params.id);
        if (!reached) return;
        const overview = overviewFor(reached.auth.userId, req.params.id);
        if (!overview || !decideProposal(overview, apply)) return reply.code(404).send({ error: "no_proposal" });
        reply.send({ overview: serialize(overviewFor(reached.auth.userId, req.params.id)!, reached.auth) });
      },
    });
  }

  app.get<{ Params: { id: string } }>("/projects/:id/overview/document", {
    schema: { tags: ["projects"], summary: "The project's overview as a Word document (a walled-off project's: this computer's app only)", security },
    handler: async (req, reply) => {
      const reached = await project(req, reply, req.params.id);
      if (!reached) return;
      const { auth, isolated } = reached;
      if (isolated && !isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      const overview = overviewFor(auth.userId, req.params.id);
      if (!overview?.sections) return reply.code(404).send({ error: "no_overview" });
      const title = (sqlite.prepare("SELECT title FROM projects WHERE id = ?").get(req.params.id) as { title: string }).title;
      const bytes = overviewDocument(title, overview, overview.sections);
      const name = `${overviewWords(overview.language).title} - ${title}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      reply
        .header("content-type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        .header("content-disposition", `attachment; filename="overview.docx"; filename*=UTF-8''${encodeURIComponent(`${name}.docx`)}`)
        .send(Buffer.from(bytes));
    },
  });
}
