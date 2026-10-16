import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// Another computer of the account in its own process, for the mesh
// document tests (test/meshDocuments.test.ts): a Twoody server on loopback
// with documents of its own, which trusts the computers the test names
// (its trust check stands in for its vault roster, lot S2) and gave the
// test's computer a `peer:` session bound to that computer's tunnel key.
//
// env: TWOODY_DATA_DIR, PORT, MESH_SELF_ID, MESH_SELF_NAME, MESH_PEER_ID,
// MESH_PEER_KEY (hex), MESH_DOCS_DIR (a folder folderRisk accepts);
// MESH_DOC_ID, MESH_DOC_FILE, MESH_DOC_TEXT for another document than the
// Pi's car rental contract.
// IPC: {type:"trust", ids} → {type:"trusted"}; {type:"roster", input} →
// {type:"roster", computers}: from then on the real vault roster decides
// (vault/roster.ts on that input, peerDocuments/trust.ts), not the ids;
// {type:"session", computerId, key} → {type:"session", token}: a « mesh »
// peer session for that computer and tunnel key; {type:"searches"} →
// {type:"searches", count}; sends {type:"ready", url, token, tunnelKey}.

const { buildApp } = await import("../../src/app.js");
const { setDesktopAccount } = await import("../../src/account/service.js");
const { setTrustCheck } = await import("../../src/peerDocuments/trust.js");
const { ensureLocalUser, pairDevice } = await import("../../src/pairing.js");
const { sqlite } = await import("../../src/db.js");
const { tunnelIdentity } = await import("../../src/tunnel/identity.js");
const { setRosterSource } = await import("../../src/vault/roster.js");
type RosterInput = import("../../src/vault/roster.js").RosterInput;

const self = process.env.MESH_SELF_ID!;
setDesktopAccount({ backendUrl: "http://127.0.0.1:9", userToken: "unused", computerId: self, computerName: process.env.MESH_SELF_NAME ?? "Raspberry Pi" });
const trusted = new Set<string>();
setTrustCheck(async (id) => trusted.has(id));

const app = await buildApp();
await app.listen({ port: Number(process.env.PORT), host: "127.0.0.1" });
const user = ensureLocalUser();

const dir = process.env.MESH_DOCS_DIR!;
mkdirSync(dir, { recursive: true });
sqlite.prepare("INSERT INTO document_folders(id,user_id,path,created_at) VALUES(?,?,?,?)").run("pi-folder", user.id, dir, Date.now());
function indexDoc(id: string, file: string, texts: string[]) {
  const path = join(dir, file);
  writeFileSync(path, texts.join("\n"));
  sqlite
    .prepare("INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, user.id, "pi-folder", path, basename(path), ".txt", texts.join("\n").length, 1_790_000_000_000, "indexed", texts.join("").length);
  texts.forEach((text, i) => sqlite.prepare("INSERT INTO document_chunks(document_id,user_id,page,position,text) VALUES(?,?,?,?,?)").run(id, user.id, null, i, text));
}
indexDoc(
  process.env.MESH_DOC_ID ?? "pi-voiture",
  process.env.MESH_DOC_FILE ?? "contrat-location-voiture.txt",
  [process.env.MESH_DOC_TEXT ?? "Contrat de location de la voiture : il court jusqu'au 12 mars 2027, loyer de 310 euros par mois."],
);

const session = pairDevice({ deviceName: "Mac de Jimmy", tunnelPublicKey: process.env.MESH_PEER_KEY!, role: "peer", origin: "mesh", requesterComputerId: process.env.MESH_PEER_ID! });

process.on("message", (message: { type: string; ids?: string[]; input?: unknown; computerId?: string; key?: string }) => {
  if (message.type === "roster") {
    setTrustCheck(null);
    const input = message.input as RosterInput;
    void setRosterSource(async () => input)
      .refresh()
      .then((roster) => process.send!({ type: "roster", computers: [...(roster?.computers.keys() ?? [])].sort() }));
  } else if (message.type === "session") {
    const made = pairDevice({ deviceName: message.computerId!, tunnelPublicKey: message.key!, role: "peer", origin: "mesh", requesterComputerId: message.computerId! });
    process.send!({ type: "session", token: made.token });
  } else if (message.type === "trust") {
    trusted.clear();
    for (const id of message.ids ?? []) trusted.add(id);
    process.send!({ type: "trusted" });
  } else if (message.type === "searches") {
    const row = sqlite.prepare("SELECT count(DISTINCT occurred_at) AS n FROM peer_document_audit WHERE action = 'search'").get() as { n: number };
    process.send!({ type: "searches", count: row.n });
  }
});
process.send!({ type: "ready", url: `http://127.0.0.1:${process.env.PORT}`, token: session.token, tunnelKey: tunnelIdentity().publicKey.toString("hex") });
