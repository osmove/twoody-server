import { sqlite } from "../db.js";
import { buildChatMessages } from "../chatContext.js";
import { documentAccess } from "../documents/access.js";
import { retrieveDocuments, scopedFolders } from "../documents/retrieval.js";
import { serveRawDocument } from "../peerDocuments/raw.js";
import { browseRemote, foldersOfComputers, serveRemoteBrowsedFile, serveRemoteRaw } from "../documents/remote.js";
import { browseGranted, readBrowseRequest, serveBrowsedFile, type BrowseRequest } from "../documents/browse.js";
import { isSelf, selfIdentity } from "../router/index.js";
import { relative, isAbsolute } from "node:path";
import { indexSemantic, semanticPassages, semanticStatus, setSemantic, stopSemantic } from "../documents/semantic.js";
import { fusePassages } from "../documents/vectorMath.js";
import { homedir } from "node:os";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { meshRequester } from "../sessionTrust.js";
import { meshRoster } from "../vault/roster.js";
import {
  addFolder,
  FolderRejected,
  indexStatus,
  isIndexedPath,
  listFolders,
  listDocuments,
  browseDocuments,
  reindex,
  removeFolder,
  searchPassages,
} from "../documents/library.js";
import { MAX_FILES_PER_FOLDER, SKIPPED_BUNDLES, SKIPPED_DIRECTORIES } from "../documents/walk.js";
import { setLocalCapability } from "../localCapabilities.js";

/// Adding a folder turns Documents on (Jimmy, 04/10/2026: « il faudrait les
/// activer quand on ajoute un dossier »): the person who gives Twoody a
/// folder wants the chat to read it. Turning it off stays theirs, in
/// Capabilities; the next folder turns it on again.
function documentsOnWithAFolder(userId: string): void {
  setLocalCapability(userId, "documents", true);
}

// Document library: the folders the user granted, the state of their
// index, and a search endpoint (the same one /queries uses, exposed so a
// client can show what would be retrieved).
//
// Lives under /local_documents rather than /documents: on the managed
// backend that path is the Google Drive browser, and one client code
// base talks to both.
/// Characters of document context a model with this window can be given:
/// a third of it, and room left under the 18 000 characters the account
/// passes on for one turn for the wrapper and the source list.
export const MAX_SYNCED_CONTEXT_CHARS = 15_000;
export function contextBudget(window: number): number {
  return Math.min(MAX_SYNCED_CONTEXT_CHARS, Math.floor(window * 3.5 * 0.35));
}

/// 409 for a folder already granted, 403 when the system refuses to let
/// Twoody read it (macOS privacy settings), 422 for the rest.
function rejectionStatus(err: FolderRejected): number {
  return err.reason === "already_added" ? 409 : err.reason === "not_permitted" ? 403 : 422;
}

/// A browse of this computer's granted folders, as every route answers it.
async function sendBrowse(reply: FastifyReply, userId: string, request: BrowseRequest) {
  const result = await browseGranted(userId, scopedFolders(userId, {mode: "all"}), request);
  if ("error" in result) return reply.code(result.error === "invalid_path" ? 400 : 404).send({error: result.error === "invalid_path" ? "invalid_directory" : "folder_unavailable"});
  return reply.send({computer_id: selfIdentity().id, computer_name: selfIdentity().name, ...result});
}

export async function localDocumentRoutes(app: FastifyInstance) {
  app.addHook("onClose", async () => stopSemantic());
  const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

  // A folder inside a granted folder as the file system has it (documents/
  // browse.ts): `root` and `path`, for a person's session (the owner's, or
  // a device paired with this computer; not a firmware device's token).
  // The older form, `folder_id` and `directory`, still lists what the index
  // holds (library.ts browseDocuments) for the clients that ask it so.
  app.get<{Querystring: {folder_id?: string; directory?: string; offset?: number; root?: string; path?: string; sort?: string; order?: string; limit?: number; q?: string}}>("/local_documents/browse", {
    schema: {tags: ["documents"], security, summary: "A folder inside a granted folder (root, path; sorted, paged, searched by name), or the index's view of one (folder_id, directory)", querystring: {type: "object", properties: {
      folder_id: {type: "string"}, directory: {type: "string", maxLength: 4096}, offset: {type: "integer", minimum: 0, maximum: 1000000},
      root: {type: "string", maxLength: 64}, path: {type: "string", maxLength: 4096}, sort: {type: "string", enum: ["name", "date", "size"]}, order: {type: "string", enum: ["asc", "desc"]},
      limit: {type: "integer", minimum: 1, maximum: 200}, q: {type: "string", maxLength: 200},
    }}},
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply); if (!auth) return;
      if (req.query.root !== undefined) {
        if (!auth.sessionId) return reply.code(403).send({error: "session_required"});
        const request = readBrowseRequest(req.query);
        if (!request) return reply.code(400).send({error: "invalid_directory"});
        return sendBrowse(reply, auth.userId, request);
      }
      if (!req.query.folder_id) return reply.code(400).send({error: "folder_required"});
      try {
        const result = browseDocuments(auth.userId, req.query.folder_id, req.query.directory || "", req.query.offset || 0);
        return result ? reply.send(result) : reply.code(404).send({error: "folder_unavailable"});
      } catch (error) {
        if (error instanceof Error && error.message === "invalid_directory") return reply.code(400).send({error: "invalid_directory"});
        throw error;
      }
    },
  });

  // A browsed file itself, indexed or not (peerDocuments/raw.ts: Range, caps, nosniff).
  app.get<{Querystring: {root?: string; path?: string}}>("/local_documents/browse/raw", {
    schema: {tags: ["documents"], security, summary: "A file inside a granted folder, the file itself, indexed or not (Range; 25 MB an answer through the relay, 32 MB on the local network)",
      querystring: {type: "object", required: ["root", "path"], properties: {root: {type: "string", maxLength: 64}, path: {type: "string", minLength: 1, maxLength: 4096}}}},
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply); if (!auth) return;
      if (!auth.sessionId) return reply.code(403).send({error: "session_required"});
      await serveBrowsedFile(req, reply, {userId: auth.userId, roots: scopedFolders(auth.userId, {mode: "all"}), root: req.query.root, path: req.query.path});
      return reply;
    },
  });

  // Another computer's folder, through this one (documents/remote.ts
  // browseRemote); this computer's own id browses here.
  app.get<{Params: {computer_id: string}; Querystring: Record<string, string>}>("/local_documents/remote/:computer_id/browse", {
    schema: {tags: ["documents"], security, summary: "A folder of another trusted computer of the account, through this one",
      params: {type: "object", required: ["computer_id"], properties: {computer_id: {type: "string", minLength: 1, maxLength: 64}}}},
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply); if (!auth) return;
      if (!auth.sessionId) return reply.code(403).send({error: "session_required"});
      if (isSelf(req.params.computer_id)) {
        const request = readBrowseRequest(req.query);
        if (!request) return reply.code(400).send({error: "invalid_directory"});
        return sendBrowse(reply, auth.userId, request);
      }
      const requester = await meshRequester(req, auth, () => meshRoster().get());
      const answer = await browseRemote({userId: auth.userId, client: auth.sessionId, computerId: req.params.computer_id, query: req.query, requester});
      return reply.code(answer.status).send(answer.body);
    },
  });

  app.get<{Params: {computer_id: string}; Querystring: {root?: string; path?: string}}>("/local_documents/remote/:computer_id/browse/raw", {
    schema: {tags: ["documents"], security, summary: "A file browsed on another trusted computer of the account, the file itself, through this one (Range)",
      params: {type: "object", required: ["computer_id"], properties: {computer_id: {type: "string", minLength: 1, maxLength: 64}}}},
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply); if (!auth) return;
      if (!auth.sessionId) return reply.code(403).send({error: "session_required"});
      if (isSelf(req.params.computer_id)) {
        await serveBrowsedFile(req, reply, {userId: auth.userId, roots: scopedFolders(auth.userId, {mode: "all"}), root: req.query.root, path: req.query.path});
        return reply;
      }
      const requester = await meshRequester(req, auth, () => meshRoster().get());
      await serveRemoteBrowsedFile(req, reply, {userId: auth.userId, client: auth.sessionId, computerId: req.params.computer_id, root: req.query.root, path: req.query.path, requester});
      return reply;
    },
  });

  app.get("/local_documents/folders", {
    schema: { tags: ["documents"], summary: "Granted folders and index counts", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ folders: listFolders(auth.userId), index: indexStatus(auth.userId) });
    },
  });

  // A bounded context envelope for clients whose conversation is stored elsewhere.
  // Nothing is sent upstream here. Clients must obtain consent before forwarding it.
  app.post<{Body: {question: string; document_access: unknown; context_window?: number; history?: Array<{role: string; content: string; sourcesJson?: string}>}}>("/local_documents/context", {
    schema: {tags: ["documents"], summary: "Retrieve scoped context for an external conversation", security,
      body: {type: "object", required: ["question", "document_access"], properties: {
        question: {type: "string", maxLength: 24000}, document_access: {type: "object"},
        context_window: {type: "integer", minimum: 1024, maximum: 1048576},
        history: {type: "array", maxItems: 20, items: {type: "object", required: ["role", "content"], properties: {
          role: {type: "string", enum: ["user", "assistant"]}, content: {type: "string", maxLength: 16000}, sourcesJson: {type: "string", maxLength: 16000},
        }}},
      }}},
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply); if (!auth) return;
      let access;
      try { access = documentAccess(req.body.document_access); }
      catch { return reply.code(422).send({error: "invalid_document_access"}); }
      const granted = listFolders(auth.userId);
      const selected = granted.filter(folder => access.folderIds?.includes(folder.id));
      const folders = granted.filter(folder => access.mode !== "off" && (!access.folderIds || selected.some(parent => {
        const path = relative(parent.path, folder.path);
        return path === "" || (!path.startsWith("..") && !isAbsolute(path));
      })));
      const found = await retrieveDocuments(auth.userId, req.body.question, req.body.history ?? [], folders.map(f => f.id));
      // Sized for the model that will read it: a third of its window, at most
      // what the account gives a turn's documents. The best passages are
      // kept whole; the sources list only those actually included.
      const window = req.body.context_window ?? 16384;
      const budget = contextBudget(window);
      const build = (count: number) => buildChatMessages({userName: null, content: "", history: [], memories: [], prefs: {}, local: true,
        documentScan: indexStatus(auth.userId), documentMode: access.mode, documentFolders: folders, documentFiles: found.files, documentFileTotal: found.total,
        excerpts: found.passages.slice(0, count).map(p => ({name:p.name,page:p.page,text:p.text})), contextWindow: window}).at(-1)?.content ?? "";
      let count = found.passages.length;
      let context = build(count);
      while (count > 0 && context.length > budget) context = build(--count);
      if (context.length > budget) return reply.code(413).send({error: "context_budget", budget});
      // Only document data and grounding policy, never the user's profile/memories or paths.
      reply.send({context, budget, omitted_passages: found.passages.length - count, sources: found.passages.slice(0, count).map((p,i) => ({
        n:i+1, document_id:p.document_id, name:p.name, page:p.page, snippet:p.snippet,
      }))});
    },
  });

  app.get<{Params:{id:string}; Querystring:{offset?:number}}>("/local_documents/files/:id", {
    schema: {tags:["documents"],summary:"Read indexed text by opaque ID, 20 passages per page",security,
      params:{type:"object",required:["id"],properties:{id:{type:"string",maxLength:200}}},
      querystring:{type:"object",properties:{offset:{type:"integer",minimum:0,maximum:1000000}}}},
    handler:async(req,reply)=>{
      const auth=await requireAuth(req,reply);if(!auth)return;
      const file=sqlite.prepare(`SELECT d.id,d.name,d.mtime_ms,d.status FROM documents d
        JOIN document_folders f ON f.id=d.folder_id AND f.user_id=d.user_id
        WHERE d.id=? AND d.user_id=?`).get(req.params.id,auth.userId);
      if(!file)return reply.code(404).send({error:"not_found"});
      const offset=req.query.offset ?? 0;
      const rows=sqlite.prepare(`SELECT page,text FROM document_chunks WHERE document_id=? AND user_id=?
        ORDER BY position,rowid LIMIT 21 OFFSET ?`).all(req.params.id,auth.userId,offset);
      reply.send({file,passages:rows.slice(0,20),next_offset:rows.length>20?offset+20:null});
    },
  });

  // The cited file itself, for the phone or the Desktop: a person's
  // session (not a firmware device's token), the same limits as for the
  // account's other computers (peerDocuments/raw.ts).
  app.get<{Params:{id:string}}>("/local_documents/files/:id/raw", {
    schema:{tags:["documents"],summary:"The indexed file itself by opaque ID (Range; 25 MB an answer through the relay, 32 MB on the local network)",security,
      params:{type:"object",required:["id"],properties:{id:{type:"string",minLength:1,maxLength:200}}}},
    handler:async(req,reply)=>{
      const auth=await requireAuth(req,reply);if(!auth)return;
      if(!auth.sessionId)return reply.code(403).send({error:"session_required"});
      await serveRawDocument(req,reply,{userId:auth.userId,documentId:req.params.id,folderIds:scopedFolders(auth.userId,{mode:"all"}).map(f=>f.id)});
      return reply;
    },
  });

  app.get("/local_documents/semantic", {
    schema: {tags: ["documents"], summary: "Local semantic indexing status", security},
    handler: async (req, reply) => {const auth=await requireAuth(req,reply);if(auth)reply.send(semanticStatus(auth.userId));},
  });
  app.post<{Body:{enabled:boolean}}>("/local_documents/semantic", {
    schema:{tags:["documents"],summary:"Enable or pause local semantic indexing",security,
      body:{type:"object",required:["enabled"],properties:{enabled:{type:"boolean"}}}},
    handler:async(req,reply)=>{const auth=await requireAuth(req,reply);if(auth)reply.send(setSemantic(auth.userId,req.body.enabled));},
  });
  app.post("/local_documents/semantic/reindex", {
    schema:{tags:["documents"],summary:"Resume local semantic indexing",security},
    handler:async(req,reply)=>{const auth=await requireAuth(req,reply);if(!auth)return;void indexSemantic(auth.userId);reply.code(202).send(semanticStatus(auth.userId));},
  });

  app.get("/local_documents/personal", {
    schema: {tags: ["documents"], summary: "Preview the personal-files grant", security},
    handler: async (req, reply) => {
      if (!await requireAuth(req, reply)) return;
      reply.send({path: homedir(), excludes: ["hidden files and folders", "system and application data", "caches", "developer folders", "photo and music libraries", "applications", "symlinks", "known credential filenames"],
        skipped_directories: SKIPPED_DIRECTORIES, skipped_bundles: SKIPPED_BUNDLES, file_limit: MAX_FILES_PER_FOLDER});
    },
  });
  app.post<{Body: {confirmed?: boolean}}>("/local_documents/personal", {
    schema: {tags: ["documents"], summary: "Explicitly grant personal files under the home directory", security,
      body: {type: "object", required: ["confirmed"], properties: {confirmed: {type: "boolean", const: true}}}},
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply); if (!auth) return;
      try {
        const folder = await addFolder(auth.userId, homedir(), true);
        documentsOnWithAFolder(auth.userId);
        void reindex(auth.userId).catch(err => app.log.error(err, "document indexing failed"));
        reply.code(201).send({folder});
      } catch (err) {
        if (err instanceof FolderRejected) return reply.code(rejectionStatus(err)).send({error: err.reason});
        throw err;
      }
    },
  });

  app.post<{ Body: { path?: string } }>("/local_documents/folders", {
    schema: {
      tags: ["documents"],
      summary: "Grant a folder and start indexing it",
      security,
      body: { type: "object", properties: { path: { type: "string" } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const path = req.body?.path?.trim();
      if (!path) return reply.code(422).send({ error: "path_required" });

      try {
        const folder = await addFolder(auth.userId, path);
        documentsOnWithAFolder(auth.userId);
        void reindex(auth.userId).catch((err) => app.log.error(err, "document indexing failed"));
        reply.code(201).send({ folder });
      } catch (err) {
        if (err instanceof FolderRejected) {
          return reply.code(rejectionStatus(err)).send({ error: err.reason });
        }
        throw err;
      }
    },
  });

  app.delete<{ Params: { id: string } }>("/local_documents/folders/:id", {
    schema: { tags: ["documents"], summary: "Revoke a folder and drop its index", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!removeFolder(auth.userId, req.params.id)) return reply.code(404).send({ error: "not_found" });
      reply.code(204).send();
    },
  });

  app.post("/local_documents/reindex", {
    schema: { tags: ["documents"], summary: "Re-scan the granted folders", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      void reindex(auth.userId).catch((err) => app.log.error(err, "document indexing failed"));
      reply.code(202).send({ index: indexStatus(auth.userId) });
    },
  });

  app.get<{ Querystring: { q?: string } }>("/local_documents/search", {
    schema: { tags: ["documents"], summary: "Passages the index returns for a question", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const q=req.query.q ?? "";
      const passages = fusePassages(searchPassages(auth.userId, q, 8), q.trim() ? await semanticPassages(auth.userId, q, listFolders(auth.userId).map(f=>f.id)) : [], 8);
      reply.send({
        passages: passages.map(({ text: _text, ...passage }) => passage),
      });
    },
  });

  app.get<{ Querystring: { folder_id: string; offset?: number; sort?: "name" | "modified" | "category" } }>("/local_documents/files", {
    schema: { tags: ["documents"], summary: "Files indexed in a granted folder, 100 per page", security,
      querystring: { type: "object", required: ["folder_id"], properties: { sort: {type: "string", enum: ["name", "modified", "category"]}, folder_id: { type: "string", minLength: 1, maxLength: 200 }, offset: { type: "integer", minimum: 0, maximum: 1000000 } } } },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send(listDocuments(auth.userId, req.query.folder_id, req.query.offset ?? 0, 100, req.query.sort));
    },
  });

  // The person's other trusted computers and their folders (names and
  // counts), each asked through the sealed link: the Documents screen's
  // sections, and the folders a question's document access may name
  // ("<computer_id>:<folder_id>").
  app.get("/local_documents/computers", {
    schema: { tags: ["documents"], summary: "The folders of the account's other trusted computers, names and counts", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      // The other computers' folders: only to the owner or the person's own
      // devices (sessionTrust.ts); anyone else sees none.
      reply.send({ computers: await foldersOfComputers(auth.userId, undefined, await meshRequester(req, auth, () => meshRoster().get())) });
    },
  });

  // A cited document, twoody://doc/<computer_id>/<document_id>, for a
  // client with no session on the computer that holds it: this computer
  // asks that one over their sealed tunnel (documents/remote.ts), with
  // Range; its own id serves its own file. 60 a minute per client.
  app.get<{ Params: { computer_id: string; id: string } }>("/local_documents/remote/:computer_id/files/:id/raw", {
    schema: {
      tags: ["documents"],
      summary: "A cited document, the file itself, from the computer of the account that holds it (Range)",
      security,
      params: { type: "object", required: ["computer_id", "id"], properties: { computer_id: { type: "string", minLength: 1, maxLength: 64 }, id: { type: "string", minLength: 1, maxLength: 64 } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      // A person's session, not a firmware device's token.
      if (!auth.sessionId) return reply.code(403).send({ error: "session_required" });
      const requester = await meshRequester(req, auth, () => meshRoster().get());
      await serveRemoteRaw(req, reply, { userId: auth.userId, client: auth.sessionId, computerId: req.params.computer_id, documentId: req.params.id, requester });
      return reply;
    },
  });

  // The desktop opens a cited file itself; it asks first whether the
  // path really belongs to this user's index.
  app.get<{ Querystring: { path?: string } }>("/local_documents/known", {
    schema: { tags: ["documents"], summary: "Whether a path is an indexed document of this user", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ known: isIndexedPath(auth.userId, req.query.path ?? "") });
    },
  });
}
