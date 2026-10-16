import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { sqlite } from "../db.js";
import { fold } from "../intentText.js";
import { extractSections, isSupported, maxBytesFor } from "../documents/extract.js";
import { nodeAliasSystem, plain } from "../documents/folderAliases.js";
import { folderAtPath } from "../documents/folderListing.js";
import { fileKind, realHome, safeRoots, walledAt, type GrantedRoot } from "../documents/fileListing.js";
import { listFolders } from "../documents/library.js";
import { skipDirectory, skipFile } from "../documents/walk.js";
import { documentDate, fromTime, isoDay, namedWithDate, type FoundDate } from "./dates.js";
import type { FileActionKind, FileIntent, SortBy } from "./intent.js";
import type { Language } from "./words.js";

// What « Agir dans vos dossiers » would do, file by file, from the folder
// as it is now (docs/agent-in-chat.md of twoody-desktop). Nothing here
// changes a file: run.ts does, once the person agrees, after checking it
// all again.

export interface PlannedMove {
  /// Relative to the folder, with "/" (« Facture EDF.pdf »).
  from: string;
  to: string;
  /// The date it is sorted or named by, and where it was read.
  date?: string;
  dateFrom?: "content" | "file";
}

export interface FileActionPlan {
  kind: FileActionKind;
  by?: SortBy;
  folder: {
    /// The granted folder (document_folders.id) that holds it.
    root: string;
    /// As the person knows it: « Documents/Factures ».
    shown: string;
    /// Its real path on this computer: never sent to a device (view.ts).
    real: string;
  };
  moves: PlannedMove[];
  /// Folders it makes, relative (« 2026-09 »).
  folders: string[];
  /// Documents read for a draft or a table, relative.
  reads: string[];
  /// The document it creates, relative, with its title.
  create: { name: string; format: "docx" | "xlsx"; title: string } | null;
  /// The person's words, for the model that writes a draft or a table.
  request: string;
  /// Files left out past MAX_MOVES.
  left: number;
}

export const MAX_MOVES = 300;
const MAX_READS_DRAFT = 12;
const MAX_READS_TABLE = 8;
/// How long reading the files' dates may take before the file's own date is used.
const DATE_BUDGET_MS = 25_000;

/// The usual document words, by what they are: « invoices » finds a
/// folder named « Factures », « 請求書 » one named « Rechnungen ».
const CONCEPTS: string[][] = [
  ["factures", "facture", "invoices", "invoice", "rechnungen", "rechnung", "facturas", "factura", "fatture", "fattura", "faturas", "fatura", "facturen", "factuur", "請求書", "发票", "發票", "청구서"],
  ["contrats", "contrat", "contracts", "contract", "vertrage", "vertrag", "contratos", "contrato", "contratti", "contratto", "contracten", "契約書", "契約", "合同", "계약서"],
  ["scans", "scan", "numerisations", "scannes", "scanned", "scansioni", "scansione", "escaneos", "escaneados", "digitalizacoes", "digitalizados", "スキャン", "扫描", "掃描", "스캔"],
  ["recus", "reçus", "tickets", "receipts", "receipt", "belege", "beleg", "quittungen", "recibos", "ricevute", "bonnetjes", "bonnen", "領収書", "收据", "收據", "영수증"],
  ["releves", "statements", "kontoauszuge", "extractos", "estratti", "extratos", "afschriften"],
  ["photos", "images", "pictures", "bilder", "fotos", "foto", "immagini", "imagens", "afbeeldingen", "写真", "照片", "사진"],
];

function variants(word: string): string[] {
  const key = plain(word).trim();
  const found = CONCEPTS.find((concept) => concept.some((each) => plain(each) === key));
  return [word, ...(found ?? []).filter((each) => plain(each) !== key)];
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function slashed(path: string): string {
  return path.split(sep).join("/").normalize("NFC");
}

/// The granted folders acting may happen in: none of a walled-off
/// project's, and the folders of walled-off projects to keep out of.
export function actionRoots(userId: string): { roots: GrantedRoot[]; walls: string[] } {
  const folders = listFolders(userId);
  const walls = folders.filter((folder) => folder.project_id !== null).map((folder) => folder.path);
  const roots = safeRoots(folders.filter((folder) => folder.project_id === null).map((folder) => ({ id: folder.id, name: folder.name, path: folder.path, walled: folder.walled })));
  return { roots, walls };
}

/// A folder that is, lies in or holds a walled-off project's folder is
/// never acted on (twoody-desktop commit a8cce6b's rule for the Agent).
export function touchesWall(path: string, walls: string[]): boolean {
  return walls.some((wall) => inside(wall, path) || inside(path, wall));
}

export type FoundFolder =
  | { status: "ok"; root: GrantedRoot; real: string; shown: string }
  | { status: "none" }
  | { status: "not_found"; word: string | null; roots: string[] };

/// The folder the request names, inside the granted folders; the folder of
/// the conversation's last action when it names none.
export async function findFolder(userId: string, words: string[], previous: string | null): Promise<FoundFolder> {
  const { roots, walls } = actionRoots(userId);
  if (!roots.length) return { status: "none" };
  const system = nodeAliasSystem(realHome());
  const tried = new Set<string>();
  for (const word of words) {
    for (const candidate of variants(word)) {
      const key = plain(candidate);
      if (tried.has(key)) continue;
      tried.add(key);
      const place = await folderAtPath(candidate, roots, system).catch(() => null);
      if (!place || touchesWall(place.real, walls) || walledAt(place.root, place.real)) continue;
      return { status: "ok", root: place.root, real: place.real, shown: shownOf(place.root, place.real) };
    }
  }
  if (!words.length && previous) {
    const real = await realpath(previous).catch(() => null);
    const root = real ? roots.filter((each) => inside(each.path, real)).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
    if (real && root && !touchesWall(real, walls) && !walledAt(root, real)) return { status: "ok", root, real, shown: shownOf(root, real) };
  }
  return { status: "not_found", word: words[0] ?? null, roots: roots.map((root) => root.name) };
}

function shownOf(root: GrantedRoot, real: string): string {
  const rel = relative(root.path, real);
  return rel ? `${root.name}/${slashed(rel)}` : root.name;
}

type Entry = { name: string; path: string; size: number; mtime: number };

/// The folder's own regular files, as the walk sees them: no hidden name,
/// no link, nothing the indexer skips.
async function ownFiles(real: string): Promise<{ files: Entry[]; folders: string[] }> {
  const files: Entry[] = [];
  const folders: string[] = [];
  for (const entry of await readdir(real, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(real, entry.name);
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      if (!skipDirectory(entry.name)) folders.push(entry.name);
      continue;
    }
    if (!info.isFile() || skipFile(entry.name)) continue;
    files.push({ name: entry.name, path, size: info.size, mtime: info.mtimeMs });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { files, folders };
}

/// A document's text: the index's when it holds it, else read now.
export async function documentText(userId: string, path: string, maxChars = 200_000): Promise<string | null> {
  const indexed = sqlite.prepare("SELECT id FROM documents WHERE user_id = ? AND path = ? AND status = 'indexed' LIMIT 1").get(userId, path) as { id: string } | undefined;
  if (indexed) {
    const rows = sqlite.prepare("SELECT text, page FROM document_chunks WHERE document_id = ? ORDER BY page, position").all(indexed.id) as Array<{ text: string; page: number | null }>;
    if (rows.length) {
      let text = "";
      let page: number | null = null;
      for (const row of rows) {
        if (row.page !== page && row.page !== null) text += `\n[page ${row.page}]\n`;
        page = row.page;
        text += `${row.text}\n`;
        if (text.length >= maxChars) break;
      }
      return text.slice(0, maxChars);
    }
  }
  if (!isSupported(path)) return null;
  const info = await stat(path).catch(() => null);
  if (!info || info.size > maxBytesFor(path)) return null;
  try {
    const sections = await extractSections(path);
    return sections.map((section) => (section.page !== null ? `[page ${section.page}]\n${section.text}` : section.text)).join("\n\n").slice(0, maxChars) || null;
  } catch {
    return null;
  }
}

/// Where each file goes: its date, read from what it says, else its own.
async function datedFiles(userId: string, files: Entry[], language: Language): Promise<Array<Entry & { date: FoundDate; from: "content" | "file" }>> {
  const started = Date.now();
  const out: Array<Entry & { date: FoundDate; from: "content" | "file" }> = [];
  for (const file of files) {
    let found: FoundDate | null = null;
    if (Date.now() - started < DATE_BUDGET_MS) {
      const text = await documentText(userId, file.path, 20_000);
      if (text) found = documentDate(text, { language });
    }
    out.push({ ...file, date: found ?? fromTime(file.mtime), from: found ? "content" : "file" });
  }
  return out;
}

const KIND_FOLDERS: Record<string, Record<Language, string>> = {
  pdf: { en: "PDF", fr: "PDF", de: "PDF", es: "PDF", it: "PDF", pt: "PDF", nl: "PDF", ja: "PDF", zh: "PDF", ko: "PDF" },
  image: { en: "Images", fr: "Images", de: "Bilder", es: "Imágenes", it: "Immagini", pt: "Imagens", nl: "Afbeeldingen", ja: "画像", zh: "图片", ko: "이미지" },
  screenshot: { en: "Screenshots", fr: "Captures d'écran", de: "Bildschirmfotos", es: "Capturas de pantalla", it: "Screenshot", pt: "Capturas de tela", nl: "Schermafbeeldingen", ja: "スクリーンショット", zh: "截图", ko: "스크린샷" },
  document: { en: "Documents", fr: "Documents", de: "Dokumente", es: "Documentos", it: "Documenti", pt: "Documentos", nl: "Documenten", ja: "文書", zh: "文档", ko: "문서" },
  spreadsheet: { en: "Spreadsheets", fr: "Tableurs", de: "Tabellen", es: "Hojas de cálculo", it: "Fogli di calcolo", pt: "Planilhas", nl: "Rekenbladen", ja: "表計算", zh: "表格", ko: "스프레드시트" },
  presentation: { en: "Presentations", fr: "Présentations", de: "Präsentationen", es: "Presentaciones", it: "Presentazioni", pt: "Apresentações", nl: "Presentaties", ja: "プレゼンテーション", zh: "演示文稿", ko: "프레젠테이션" },
  video: { en: "Videos", fr: "Vidéos", de: "Videos", es: "Vídeos", it: "Video", pt: "Vídeos", nl: "Video's", ja: "ビデオ", zh: "视频", ko: "동영상" },
  audio: { en: "Audio", fr: "Audio", de: "Audio", es: "Audio", it: "Audio", pt: "Áudio", nl: "Audio", ja: "オーディオ", zh: "音频", ko: "오디오" },
  archive: { en: "Archives", fr: "Archives", de: "Archive", es: "Archivos comprimidos", it: "Archivi", pt: "Arquivos compactados", nl: "Archieven", ja: "アーカイブ", zh: "压缩包", ko: "압축 파일" },
  installer: { en: "Installers", fr: "Installeurs", de: "Installationsprogramme", es: "Instaladores", it: "Programmi di installazione", pt: "Instaladores", nl: "Installatieprogramma's", ja: "インストーラ", zh: "安装程序", ko: "설치 프로그램" },
  other: { en: "Other", fr: "Autres", de: "Sonstige", es: "Otros", it: "Altri", pt: "Outros", nl: "Overig", ja: "その他", zh: "其他", ko: "기타" },
};

const DEFAULT_TITLES: Record<"draft" | "table", Record<Language, string>> = {
  draft: { en: "Summary", fr: "Synthèse", de: "Zusammenfassung", es: "Resumen", it: "Sintesi", pt: "Resumo", nl: "Samenvatting", ja: "まとめ", zh: "摘要", ko: "요약" },
  table: { en: "Comparison", fr: "Comparaison", de: "Vergleich", es: "Comparación", it: "Confronto", pt: "Comparação", nl: "Vergelijking", ja: "比較", zh: "比较", ko: "비교" },
};

/// A name a file can have on a Mac, a PC and Linux: no separator nor
/// character Windows refuses, not too long.
export function fileNameOf(title: string): string {
  return title.replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80).trim() || "Twoody";
}

/// A name nobody has yet in `taken` (lower case) nor on disk: « Nom (2).ext ».
async function freeName(dir: string, name: string, taken: Set<string>): Promise<string> {
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? name : `${base} (${n})${ext}`;
    if (taken.has(candidate.toLowerCase())) continue;
    const there = await lstat(join(dir, candidate)).then(() => true).catch(() => false);
    if (!there) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  throw new Error("no free name");
}

/// The documents the model may read for a draft or a table: those the
/// request names, else the folder's, at most `max`, walled-off folders and
/// links left out.
async function readableDocuments(real: string, root: GrantedRoot, walls: string[], request: string, max: number, title: string | null): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: real, depth: 0 }];
  while (queue.length && found.length < 200) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
      const path = join(dir, entry.name);
      if (walledAt(root, path) || touchesWall(path, walls)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth < 3 && !skipDirectory(entry.name)) queue.push({ dir: path, depth: depth + 1 });
      } else if (entry.isFile() && !skipFile(entry.name) && isSupported(path) && !sameTitle(entry.name, title)) found.push(path);
    }
  }
  // The documents the request names by a word of their name (« Tessane »).
  // Not the words of the document asked for (« Délais de préavis »): a file
  // of that name is an earlier one of these, not a source.
  const titled = new Set(fold(title ?? "").split(/[^\p{L}\p{N}]+/u));
  const asked = fold(request).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4 && !titled.has(word));
  const named = found.filter((path) => {
    const words = fold(basename(path, extname(path))).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4);
    return words.some((word) => asked.includes(word) && !GENERIC_NAME_WORDS.has(word));
  });
  return (named.length >= 1 ? named : found).slice(0, max);
}

/// An earlier document of the same title (« Délais de préavis (2).docx »):
/// not a source of the new one.
function sameTitle(name: string, title: string | null): boolean {
  return !!title && fold(basename(name, extname(name)).replace(/\s\(\d+\)$/, "")) === fold(fileNameOf(title));
}

/// Words in documents' names that name none of them in particular.
const GENERIC_NAME_WORDS = new Set(["contrat", "contrats", "contract", "contracts", "facture", "factures", "invoice", "invoices", "document", "documents", "vertrag", "vertrage", "contrato", "contratos", "contratto", "contratti", "contract", "scan", "scans", "rechnung", "rechnungen", "factura", "facturas", "fattura", "fatture"]);

export class PlanError extends Error {
  constructor(public readonly code: "nothing" | "no_documents" | "folder_gone") {
    super(code);
  }
}

/// The plan for the request, in the folder found.
export async function buildPlan(args: { userId: string; intent: Exclude<FileIntent, { kind: "delete" }>; folder: Extract<FoundFolder, { status: "ok" }>; request: string; language: Language }): Promise<FileActionPlan> {
  const { userId, intent, folder, language } = args;
  const { walls } = actionRoots(userId);
  const base: FileActionPlan = { kind: intent.kind, folder: { root: folder.root.id, shown: folder.shown, real: folder.real }, moves: [], folders: [], reads: [], create: null, request: args.request.slice(0, 2_000), left: 0 };
  let own: { files: Entry[]; folders: string[] };
  try {
    own = await ownFiles(folder.real);
  } catch {
    throw new PlanError("folder_gone");
  }

  if (intent.kind === "sort") {
    const files = own.files.slice(0, MAX_MOVES);
    const dated = intent.by === "type" ? files.map((file) => ({ ...file, date: fromTime(file.mtime), from: "file" as const })) : await datedFiles(userId, files, language);
    const existing = new Set(own.folders.map((name) => name.toLowerCase()));
    const made = new Set<string>();
    const taken = new Map<string, Set<string>>();
    const moves: PlannedMove[] = [];
    for (const file of dated) {
      const target = intent.by === "type"
        ? (KIND_FOLDERS[fileKind(file.name)] ?? KIND_FOLDERS.other!)[language]
        : intent.by === "year" ? String(file.date.year) : `${file.date.year}-${String(file.date.month).padStart(2, "0")}`;
      if (!existing.has(target.toLowerCase())) made.add(target);
      const names = taken.get(target) ?? new Set<string>();
      taken.set(target, names);
      const name = await freeName(join(folder.real, target), file.name, names);
      moves.push({ from: file.name.normalize("NFC"), to: `${target}/${name}`.normalize("NFC"), ...(intent.by === "type" ? {} : { date: isoDay(file.date), dateFrom: file.from }) });
    }
    if (!moves.length) throw new PlanError("nothing");
    return { ...base, by: intent.by, moves, folders: [...made].sort(), left: Math.max(0, own.files.length - MAX_MOVES) };
  }

  if (intent.kind === "rename") {
    const candidates = own.files.filter((file) => !namedWithDate(file.name));
    const files = candidates.slice(0, MAX_MOVES);
    const dated = await datedFiles(userId, files, language);
    const taken = new Set(own.files.map((file) => file.name.toLowerCase()));
    const moves: PlannedMove[] = [];
    for (const file of dated) {
      const name = await freeName(folder.real, `${isoDay(file.date)} ${file.name}`, taken);
      moves.push({ from: file.name.normalize("NFC"), to: name.normalize("NFC"), date: isoDay(file.date), dateFrom: file.from });
    }
    if (!moves.length) throw new PlanError("nothing");
    return { ...base, moves, left: Math.max(0, candidates.length - MAX_MOVES) };
  }

  // A draft or a table: the documents it reads, the one it makes.
  const reads = await readableDocuments(folder.real, folder.root, walls, args.request, intent.kind === "draft" ? MAX_READS_DRAFT : MAX_READS_TABLE, intent.title);
  if (!reads.length) throw new PlanError("no_documents");
  const format = intent.kind === "draft" ? "docx" : "xlsx";
  const fallback = `${DEFAULT_TITLES[intent.kind][language]} – ${basename(folder.real)}`;
  const title = fileNameOf(intent.title ?? fallback);
  const name = await freeName(folder.real, `${title}.${format}`, new Set());
  return { ...base, reads: reads.map((path) => slashed(relative(folder.real, path))), create: { name: name.normalize("NFC"), format, title } };
}
