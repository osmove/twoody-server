import type { FileActionRow } from "./store.js";

// An action as the apps show it (the card under the proposal): what will
// happen or happened, file by file, relative to its folder — never an
// absolute path (a phone or another computer has no business with this
// computer's paths; « Ouvrir » on the Mac asks GET /file_actions/:id/path).

export interface Viewer {
  sessionId: string | null;
  thisComputersApp: boolean;
}

/// Whether this viewer may agree, refuse or undo: the session that asked,
/// or this computer's app (as for a connector's call, connectors.ts).
export function mayDecide(row: Pick<FileActionRow, "askerSession">, viewer: Viewer): boolean {
  return viewer.thisComputersApp || (!!row.askerSession && row.askerSession === viewer.sessionId);
}

export function actionView(row: FileActionRow, viewer: Viewer) {
  const plan = row.plan;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    ...(plan.by ? { by: plan.by } : {}),
    folder: plan.folder.shown,
    moves: plan.moves.map((move) => ({ from: move.from, to: move.to, ...(move.date ? { date: move.date, date_from: move.dateFrom ?? null } : {}) })),
    folders: plan.folders,
    reads: plan.reads,
    create: plan.create ? { name: plan.create.name, format: plan.create.format, title: plan.create.title } : null,
    left: plan.left,
    result: row.result
      ? {
          done: row.result.done,
          total: row.result.total,
          items: row.result.items,
          folders: row.result.folders,
          failure: row.result.failure ?? null,
          undo: row.result.undo ?? null,
        }
      : null,
    language: row.language,
    created_at: new Date(row.createdAt).toISOString(),
    decided_at: row.decidedAt ? new Date(row.decidedAt).toISOString() : null,
    done_at: row.doneAt ? new Date(row.doneAt).toISOString() : null,
    // Whether the one looking may answer it (the session that asked, or
    // this computer's app), and open what it made (this computer's app).
    may_decide: mayDecide(row, viewer),
    may_open: viewer.thisComputersApp,
  };
}

export type ActionView = ReturnType<typeof actionView>;
