import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, renameSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join, basename} from 'node:path';

// How far « Rechercher par le sens » has read, folder by folder and file by
// file (Jimmy, 28/10/2026: « qu'on voie pour chaque document s'il a été
// vectorisé »): /local_documents/folders and /local_documents/files say each
// one's passages and those that have their vector for the current model;
// nothing while the search by meaning is off.
const dir = mkdtempSync(join(tmpdir(), 'twoody-meaning-progress-'));
process.env.TWOODY_DATA_DIR = dir;
const {sqlite} = await import('../src/db.js');
const {listDocuments, listFolders} = await import('../src/documents/library.js');
const {EMBED_MODEL} = await import('../src/documents/semantic.js');
after(() => { sqlite.close(); const trash = join(homedir(), '.Trash'); mkdirSync(trash, {recursive: true}); renameSync(dir, join(trash, basename(dir))); });

sqlite.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run('owner', 'owner@test.invalid', Date.now());
sqlite.prepare('INSERT INTO document_folders(id,user_id,path,created_at) VALUES(?,?,?,?)').run('folder', 'owner', '/synthetic/Cabinet', Date.now());
function doc(id: string, passages: number, embedded: number, model = EMBED_MODEL) {
  sqlite.prepare('INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'owner', 'folder', `/synthetic/Cabinet/${id}.docx`, `${id}.docx`, '.docx', 100, 1_760_000_000_000, 'indexed', 100);
  for (let position = 0; position < passages; position++) {
    sqlite.prepare('INSERT INTO document_chunks(document_id,user_id,page,position,text) VALUES(?,?,?,?,?)').run(id, 'owner', 1, position, `${id} ${position}`);
    if (position < embedded) sqlite.prepare('INSERT INTO document_embeddings(user_id,document_id,position,model,hash,vector) VALUES(?,?,?,?,?,?)').run('owner', id, position, model, 'h', Buffer.alloc(4));
  }
}
doc('ready', 3, 3);
doc('partial', 4, 1);
doc('waiting', 2, 0);
// A vector of another model is none for the current one.
doc('stale', 2, 2, 'an-older-model');

const files = () => Object.fromEntries((listDocuments('owner', 'folder').files as Array<{id: string; meaning: unknown}>).map(file => [file.id, file.meaning]));

test('off: nothing is said of it', () => {
  assert.equal(listFolders('owner')[0]?.meaning, null);
  assert.deepEqual(Object.values(files()), [null, null, null, null]);
});

test('on: each folder and each file, its passages and those read for it', () => {
  sqlite.prepare('INSERT INTO document_semantic_settings(user_id,enabled) VALUES(?,1)').run('owner');
  assert.deepEqual(listFolders('owner')[0]?.meaning, {passages: 11, embedded: 4});
  assert.deepEqual(files(), {
    partial: {passages: 4, embedded: 1},
    ready: {passages: 3, embedded: 3},
    stale: {passages: 2, embedded: 0},
    waiting: {passages: 2, embedded: 0},
  });
});

test('the vectors go to the graphics chip on a Mac with Apple silicon and 24 GB or more, nowhere else', async () => {
  const {embeddingGpuLayers} = await import('../src/embeddings.js');
  const GB = 1024 ** 3;
  assert.equal(embeddingGpuLayers('darwin', 'arm64', 24 * GB), '99');
  assert.equal(embeddingGpuLayers('darwin', 'arm64', 64 * GB), '99');
  assert.equal(embeddingGpuLayers('darwin', 'arm64', 16 * GB), '0');
  assert.equal(embeddingGpuLayers('darwin', 'x64', 32 * GB), '0');
  assert.equal(embeddingGpuLayers('win32', 'x64', 64 * GB), '0');
  assert.equal(embeddingGpuLayers('linux', 'arm64', 32 * GB), '0');
});
