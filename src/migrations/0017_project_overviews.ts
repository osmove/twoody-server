import type Database from "better-sqlite3-multiple-ciphers";

// Migration 17 — « Synthèse du projet » (Jimmy, 27/10/2026;
// docs/project-overview-design.md, src/projects/overview/): what a project's
// documents say, read once per document, written per section with the
// sources of each line, kept and brought up to date by proposals.
//
//   project_overviews          one per project: the overview the person sees
//                              (`sections`), the folder of a project that is not
//                              walled off (`folder`), its language, what was read
//   project_overview_versions  every version made — the first, each proposal
//                              applied or ignored —, never deleted
//   project_document_digests   what each document of a project says (`items`,
//                              with their quotes), with the size and date it was
//                              read at: read again only when they change
//
// Local only (schema/contract.json, `@local_documents`): read from the
// documents of this computer, by its model, and a walled-off project's never
// leave it (`never_leave`).

export function projectOverviews(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_overviews (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      folder TEXT,
      language TEXT NOT NULL,
      sections TEXT,
      documents TEXT,
      built_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_overviews_project ON project_overviews(project_id);
    CREATE TABLE IF NOT EXISTS project_overview_versions (
      id TEXT PRIMARY KEY,
      overview_id TEXT NOT NULL REFERENCES project_overviews(id) ON DELETE CASCADE,
      sections TEXT NOT NULL,
      documents TEXT,
      changes TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS project_overview_versions_overview ON project_overview_versions(overview_id, created_at);
    CREATE TABLE IF NOT EXISTS project_document_digests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      document_at INTEGER,
      items TEXT NOT NULL,
      pieces INTEGER NOT NULL,
      partial INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      language TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_document_digests_document ON project_document_digests(project_id, document_id);
  `);
}
