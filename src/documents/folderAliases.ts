import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

// The usual folders a person names in a message (« mes téléchargements »,
// « sur le Bureau », « my iCloud Drive »), and where each one is on this
// computer. The ids and the places are those of the one-click shortcuts of
// the Documents screen (twoody-desktop src/main/folderShortcuts.ts), so
// that « Téléchargements » here is the folder the « Téléchargements »
// shortcut grants there — never a folder that merely has that name inside
// an archive. The places come from the system (the home folder, the
// environment, Linux's user-dirs.dirs), never from the message.

export type FolderAliasId =
  | "downloads"
  | "desktop"
  | "documents"
  | "pictures"
  | "icloud"
  | "onedrive"
  | "googledrive"
  | "dropbox"
  | "home";

export const FOLDER_ALIAS_IDS: readonly FolderAliasId[] = ["downloads", "desktop", "documents", "pictures", "icloud", "onedrive", "googledrive", "dropbox", "home"];

/// How the person calls each folder, accents and case removed (see `plain`),
/// in each language of the app — the names macOS, Windows and Linux give
/// them there (« Schreibtisch », « Escritorio », « 桌面 », 10/10/2026).
/// « Documents » and « Images » alone are too common as plain words: only
/// « dossier Documents », « Documents folder », « ~/Documents » name the folder.
const FOLDER = String.raw`(?:dossier|repertoire|folder|ordner|carpeta|cartella|pasta|map)`;
const PATTERNS: Array<[FolderAliasId, RegExp]> = [
  ["downloads", /\b(telechargements?|telecharges|downloads?|downloaded|descargas?|descargados)\b|ダウンロード|下载|下載|다운로드/],
  // « bureau » in Dutch is a desk; their Desktop is « bureaublad ».
  ["desktop", /\b(bureau|desktop|schreibtisch|escritorio|scrivania|area de trabalho|bureaublad)\b|デスクトップ|桌面|데스크탑|데스크톱|바탕\s?화면/],
  ["documents", new RegExp(String.raw`(\b${FOLDER}s? (de |des |der |")?(documents|dokumente|documentos|documenti|documenten)\b|\b(documents|dokumente|documentos|documenti|documenten) (folder|directory|ordner)\b|\bdokumentenordner\b|~\/documents\b)|書類フォルダ|ドキュメントフォルダ|文稿|文档文件夹|문서\s?폴더`)],
  ["pictures", new RegExp(String.raw`(\b${FOLDER}s? (d'|de |des |")?(images|photos|bilder|imagenes|immagini|imagens|afbeeldingen)\b|\bpictures\b|\bbilderordner\b|~\/pictures\b)|ピクチャ|图片文件夹|사진\s?폴더`)],
  ["icloud", /\bicloud( drive)?\b/],
  ["onedrive", /\bone ?drive\b/],
  ["googledrive", /\bgoogle drive\b/],
  ["dropbox", /\bdropbox\b/],
  ["home", /\b(dossier (personnel|utilisateur|maison)|home (folder|directory)|repertoire personnel|home-?ordner|benutzerordner|personlicher ordner|carpeta (personal|de inicio|de usuario)|cartella (home|personale|utente)|pasta (pessoal|de inicio|do usuario)|thuismap|gebruikersmap|persoonlijke map)\b|ホームフォルダ|主文件夹|个人文件夹|홈\s?폴더/],
];

/// Accents of the Latin script removed, lower case, curly quotes made
/// straight. Kana and hangul are kept whole (NFKC): removing every mark
/// made « デスクトップ » « テスクトッフ » (10/10/2026).
export function plain(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFKC").replace(/[’‘]/g, "'").toLowerCase();
}

/// The folder a message names, if it names one of the usual ones.
export function folderAliasIn(text: string): FolderAliasId | null {
  const said = plain(text);
  for (const [id, pattern] of PATTERNS) if (pattern.test(said)) return id;
  return null;
}

/// How a folder is said to the model: « Downloads (~/Downloads) ».
export function aliasLabel(id: FolderAliasId): string {
  return {
    downloads: "Downloads (~/Downloads)",
    desktop: "Desktop (~/Desktop)",
    documents: "Documents (~/Documents)",
    pictures: "Pictures (~/Pictures)",
    icloud: "iCloud Drive",
    onedrive: "OneDrive",
    googledrive: "Google Drive",
    dropbox: "Dropbox",
    home: "the home folder (~)",
  }[id];
}

export interface AliasSystem {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  /// The folder's real path when it is a folder that exists, else null.
  realDirectory(path: string): string | null;
  /// The names in a folder, [] when it cannot be read.
  listDirectory(path: string): string[];
  /// A text file's content, null when it cannot be read.
  readText(path: string): string | null;
}

export function nodeAliasSystem(home: string): AliasSystem {
  return {
    platform: process.platform,
    home,
    env: process.env,
    realDirectory(path) {
      try {
        const real = realpathSync(path);
        return statSync(real).isDirectory() ? real : null;
      } catch {
        return null;
      }
    },
    listDirectory(path) {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    readText(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/// Linux: the XDG folder the desktop names (« Téléchargements » on a
/// French Ubuntu), from ~/.config/user-dirs.dirs.
function xdgDirectory(system: AliasSystem, key: string): string | null {
  const text = system.readText(posix.join(system.home, ".config", "user-dirs.dirs"));
  const match = text ? new RegExp(`^${key}="([^"]+)"`, "m").exec(text) : null;
  if (!match) return null;
  const value = match[1]!.replace(/^\$HOME/, system.home);
  return posix.isAbsolute(value) ? value : null;
}

/// Where a usual folder is on this computer, real paths, the first that
/// exists first. Empty when it is not there.
export function aliasPaths(id: FolderAliasId, system: AliasSystem): string[] {
  const path = system.platform === "win32" ? win32 : posix;
  const candidates: string[] = [];
  const standard: Partial<Record<FolderAliasId, [string, string]>> = {
    downloads: ["Downloads", "XDG_DOWNLOAD_DIR"],
    desktop: ["Desktop", "XDG_DESKTOP_DIR"],
    documents: ["Documents", "XDG_DOCUMENTS_DIR"],
    pictures: ["Pictures", "XDG_PICTURES_DIR"],
  };
  const known = standard[id];
  if (known) {
    if (system.platform === "linux") {
      const xdg = xdgDirectory(system, known[1]);
      if (xdg) candidates.push(xdg);
    }
    candidates.push(path.join(system.home, known[0]));
  } else if (id === "home") {
    candidates.push(system.home);
  } else if (id === "icloud" && system.platform === "darwin") {
    candidates.push(path.join(system.home, "Library", "Mobile Documents", "com~apple~CloudDocs"));
  } else if (id === "onedrive" || id === "googledrive" || id === "dropbox") {
    if (system.platform === "darwin") {
      const prefix = { onedrive: "OneDrive", googledrive: "GoogleDrive", dropbox: "Dropbox" }[id];
      const storage = path.join(system.home, "Library", "CloudStorage");
      for (const name of system.listDirectory(storage).sort()) {
        if (name === prefix || name.startsWith(`${prefix}-`)) candidates.push(path.join(storage, name));
      }
    }
    if (id === "dropbox") candidates.push(path.join(system.home, "Dropbox"));
    if (id === "onedrive") {
      const env = system.env.OneDrive || system.env.OneDriveConsumer || system.env.OneDriveCommercial;
      if (env) candidates.push(env);
      candidates.push(path.join(system.home, "OneDrive"));
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    const real = system.realDirectory(candidate);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

/// The Desktop and Documents in iCloud Drive, when macOS « Bureau et
/// Documents » is synced (Jimmy, 08/10/2026: « Bureau est le dossier
/// desktop sur iCloud Drive »): iCloud Drive/Desktop is then a link to
/// ~/Desktop — the same folder, left out here — or, on some Macs, a folder
/// of its own, listed when ~/Desktop is not granted but iCloud Drive is.
/// Real paths, those aliasPaths already gives left out.
export function cloudAliasPaths(id: FolderAliasId, system: AliasSystem): string[] {
  if (system.platform !== "darwin" || (id !== "desktop" && id !== "documents")) return [];
  const local = new Set(aliasPaths(id, system));
  const real = system.realDirectory(posix.join(system.home, "Library", "Mobile Documents", "com~apple~CloudDocs", id === "desktop" ? "Desktop" : "Documents"));
  return real && !local.has(real) ? [real] : [];
}
