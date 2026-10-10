import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

// The owner's computer of the folder-sharing tests (docs/sharing-design.md
// §8): a server with its owner's session, Documents on, and real folders
// where folderRisk lets them be granted (not under /private/var on a Mac):
//
//   Contrats/                    granted, the one shared
//     bail-appartement.txt
//     Clients/                   granted inside it: shared with it
//       contrat-client-dupont.txt
//     Secret/                    granted inside it, an isolated project's: never shared
//       dossier-isole.txt
//     .cache/note.txt            hidden: never browsed
//     Lien -> ../Factures        a symbolic link: never followed
//   Factures/                    granted, not shared
//     facture-2026-09.txt
//   /etc/twoody-grant            granted before folderRisk refused it
//
// Must be imported first: it sets TWOODY_DATA_DIR before the database opens.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-shares-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
process.env.LOG_LEVEL ??= "warn";
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

const { buildApp } = await import("../../src/app.js");
const { ensureSetupToken } = await import("../../src/auth.js");
const { ensureLocalUser, pairDevice } = await import("../../src/pairing.js");
const { sqlite } = await import("../../src/db.js");
const { folderRisk } = await import("../../src/documents/folderRisk.js");
const { setLocalCapability } = await import("../../src/localCapabilities.js");
const { setSpotlightEnabled } = await import("../../src/documents/spotlight.js");

// The host's own Spotlight is not these tests'.
setSpotlightEnabled(false);

const home = realpathSync(homedir());
const tmpBase = realpathSync(tmpdir());
const base = folderRisk(join(tmpBase, "x"), home) === null ? tmpBase : home;
export const root = realpathSync(mkdtempSync(join(base, "twoody-shares-test-")));

export const app = await buildApp();
await app.ready();

export function cleanUp(): Promise<void> {
  return app.close().then(() => {
    if (process.platform === "darwin") {
      const trash = join(homedir(), ".Trash");
      mkdirSync(trash, { recursive: true });
      renameSync(root, join(trash, basename(root)));
    } else rmSync(root, { recursive: true, force: true });
  });
}

const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
/// This computer's app: the owner.
export const ownerHeaders = { authorization: `Bearer ${paired.json().token}` };
/// A device paired by code that is no member of the person's history: a
/// household member's phone, say.
export const otherHeaders = { authorization: `Bearer ${pairDevice({ deviceName: "iPhone de Claire" }).token}` };
export const user = ensureLocalUser();
setLocalCapability(user.id, "documents", true);

export const contracts = join(root, "Contrats");
export const clients = join(contracts, "Clients");
export const secret = join(contracts, "Secret");
export const invoices = join(root, "Factures");
for (const dir of [contracts, clients, secret, invoices, join(contracts, ".cache")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(contracts, ".cache", "note.txt"), "caché");
if (!existsSync(join(contracts, "Lien"))) symlinkSync(invoices, join(contracts, "Lien"));

function grant(id: string, path: string, projectId: string | null = null) {
  sqlite.prepare("INSERT INTO document_folders(id,user_id,path,created_at,project_id) VALUES(?,?,?,?,?)").run(id, user.id, path, Date.now(), projectId);
}
function indexDoc(id: string, folderId: string, path: string, texts: string[]) {
  if (!existsSync(path)) writeFileSync(path, texts.join("\n"));
  const name = basename(path);
  sqlite
    .prepare("INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, user.id, folderId, path, name, name.slice(name.lastIndexOf(".")), 100, 1_790_000_000_000, "indexed", texts.join("").length);
  texts.forEach((text, i) => sqlite.prepare("INSERT INTO document_chunks(document_id,user_id,page,position,text) VALUES(?,?,?,?,?)").run(id, user.id, i + 1, i, text));
}

grant("f-contracts", contracts);
grant("f-clients", clients);
grant("f-secret", secret, "p-isolated");
grant("f-invoices", invoices);
grant("f-risky", "/etc/twoody-grant");

indexDoc("bail", "f-contracts", join(contracts, "bail-appartement.txt"), ["Contrat de bail : loyer mensuel de 900 euros, préavis de trois mois.", "Le locataire paie le loyer le premier du mois."]);
indexDoc("client", "f-clients", join(clients, "contrat-client-dupont.txt"), ["Contrat client Dupont : prestation de conseil, loyer du matériel inclus."]);
indexDoc("isole", "f-secret", join(secret, "dossier-isole.txt"), ["Dossier isolé : loyer confidentiel du client Martin."]);
indexDoc("facture", "f-invoices", join(invoices, "facture-2026-09.txt"), ["Facture de septembre : loyer du bureau 1200 euros."]);
sqlite
  .prepare("INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run("risky", user.id, "f-risky", "/etc/twoody-grant/passwd-loyer.txt", "passwd-loyer.txt", ".txt", 10, 1, "indexed", 10);
sqlite.prepare("INSERT INTO document_chunks(document_id,user_id,page,position,text) VALUES(?,?,?,?,?)").run("risky", user.id, 1, 0, "loyer secret du système");

/// Makes a share through the owner's route.
export async function share(payload: Record<string, unknown>): Promise<{ id: string; [key: string]: unknown }> {
  const response = await app.inject({ method: "POST", url: "/local_shares", headers: ownerHeaders, payload });
  if (response.statusCode !== 201) throw new Error(`share not made: ${response.statusCode} ${response.body}`);
  return response.json().share;
}

/// What leaves this computer must never say where its folders are.
export function noAbsolutePath(value: unknown): boolean {
  const text = JSON.stringify(value);
  return !text.includes(root) && !text.includes(home) && !text.includes("/etc/");
}
