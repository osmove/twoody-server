import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, renameSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join, basename} from 'node:path';

// The documents a question names by their file's or folder's name are
// searched by what they say, beside the rest of the folder (retrieval.ts
// namedTiers, 28/10/2026). Before: a client's name in its files' names gave
// the first passage of each, alphabetically; one file named, its first six
// passages in order; several, nothing else (doc-search bench, twoody-bench).
const dir = mkdtempSync(join(tmpdir(), 'twoody-named-documents-'));
process.env.TWOODY_DATA_DIR = dir;
const {sqlite} = await import('../src/db.js');
const {retrieveDocuments} = await import('../src/documents/retrieval.js');
sqlite.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run('owner', 'owner@test.invalid', Date.now());
sqlite.prepare('INSERT INTO document_folders(id,user_id,path,created_at) VALUES(?,?,?,?)').run('folder', 'owner', '/synthetic/Agentur', Date.now());
after(() => { sqlite.close(); const trash = join(homedir(), '.Trash'); mkdirSync(trash, {recursive: true}); renameSync(dir, join(trash, basename(dir))); });

const filler = (topic: string, i: number) => `${topic}, Abschnitt ${i}: allgemeine Erläuterungen zum Ablauf des Projekts, zu Zuständigkeiten und zur Abstimmung mit dem Kunden.`;
function doc(id: string, path: string, chunks: string[]) {
  const name = path.split('/').pop()!;
  sqlite.prepare('INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'owner', 'folder', `/synthetic/Agentur/${path}`, name, `.${name.split('.').pop()}`, 100, 1_760_000_000_000, 'indexed', 100);
  chunks.forEach((text, position) => sqlite.prepare('INSERT INTO document_chunks(document_id,user_id,page,position,text) VALUES(?,?,?,?,?)').run(id, 'owner', position + 1, position, text));
}
const many = (topic: string, n: number, at: Record<number, string> = {}) => Array.from({length: n}, (_, i) => at[i] ?? filler(topic, i));

doc('v-angebot', 'Projekte/Voltrad/Angebot_Voltrad.pdf', many('Angebot Voltrad', 4));
doc('v-brief1', 'Projekte/Voltrad/Briefing_Voltrad_v1.docx', many('Briefing Voltrad', 4));
doc('v-brief2', 'Projekte/Voltrad/Briefing_Voltrad_v2.docx', many('Briefing Voltrad', 4));
doc('v-kick', 'Projekte/Voltrad/Kickoff_Voltrad.docx', many('Kick-off Voltrad', 4));
doc('v-marke', 'Projekte/Voltrad/Markenrecherche_Voltrad.pdf', many('Markenrecherche Voltrad', 4));
doc('v-liste', 'Projekte/Voltrad/Namensliste_Voltrad.xlsx', many('Namensliste Voltrad', 2));
doc('v-workshop', 'Projekte/Voltrad/Workshop_Voltrad.docx', many('Workshop Voltrad', 16, {
  11: 'Dot-Voting: Kalio erhielt 9 Punkte, Fenna 4 Punkte, Strada 2 Punkte.',
  14: 'Der Aufsichtsrat bekommt den Zwischenstand am 12.08.2026 präsentiert.',
}));
doc('h-brief', 'Projekte/Heliapharm/Briefing_Heliapharm.docx', many('Briefing Heliapharm', 4, {2: 'Abgabetermin der Shortlist für Heliapharm ist der 30.09.2026.'}));
doc('h-short', 'Projekte/Heliapharm/Shortlist_Heliapharm.xlsx', ['| Name | Silben |\n| Curalis | 3 |\n| Nevaro | 3 |']);
doc('s-marke', 'Projekte/Seegarten/Markenrecherche_Seegarten.pdf', many('Markenrecherche Seegarten', 6));
doc('handbuch', 'Agentur/Prozess-Handbuch.docx', many('Handbuch', 8, {6: 'Ein Treffer der Markenrecherche gilt bei uns als rot ab einer Ähnlichkeit von 75 % oder mehr.'}));
doc('d-mail', 'Projekte/Dubreuil/Mail_Dubreuil.txt', ['Von: Nathalie Dubreuil, Boulangerie Dubreuil. Liebe Grüße von der Boulangerie Dubreuil, Dubreuil Dubreuil.']);
doc('d-bail', 'Projekte/Dubreuil/Mietvertrag_Dubreuil.pdf', many('Mietvertrag', 6, {3: 'Artikel 4 – Miete: die monatliche Miete beträgt 2.300 € netto.'}));
for (const i of [1, 2, 3, 4]) doc(`other-${i}`, `Projekte/Andere${i}/Notizen_${i}.txt`, many(`Notizen ${i}`, 3));

const ask = async (question: string) => (await retrieveDocuments('owner', question, [], ['folder'], {semantic: false})).passages;
const holds = (passages: Array<{text: string}>, words: string) => passages.some(passage => passage.text.includes(words));

test("a client's name in its files' names does not stand for the answer: the passage that answers is found", async () => {
  const passages = await ask('Wann bekommt der Aufsichtsrat von Voltrad den Zwischenstand präsentiert?');
  assert.ok(holds(passages, 'am 12.08.2026 präsentiert'), JSON.stringify(passages.map(p => p.name)));
});

test('one file named: its passage that answers, wherever it is in the file', async () => {
  const passages = await ask('Wie viele Punkte hat Kalio im Workshop Voltrad bekommen?');
  assert.ok(holds(passages, 'Kalio erhielt 9 Punkte'));
});

test('the file naming the most words does not keep out another named file that answers', async () => {
  const passages = await ask('Abgabetermin Shortlist Heliapharm?');
  assert.ok(holds(passages, 'ist der 30.09.2026'));
});

test('a word of the question in the names of several files does not keep out the document that answers', async () => {
  const passages = await ask('Ab welcher Ähnlichkeit gilt ein Treffer in der Markenrecherche bei uns als rot?');
  assert.ok(holds(passages, '75 % oder mehr'));
});

test('in the named documents, the rest of the question is looked for, not the name they already carry', async () => {
  const passages = await ask('Monatliche Miete im Mietvertrag Dubreuil?');
  assert.ok(holds(passages, 'beträgt 2.300 €'));
  assert.equal(passages[0]?.document_id, 'd-bail');
});

test('« résume » one named file: read from its start', async () => {
  const passages = await ask('Résume Workshop_Voltrad.docx');
  assert.deepEqual(passages.map(p => p.document_id), Array(6).fill('v-workshop'));
  assert.ok(holds(passages, 'Abschnitt 0'));
});
