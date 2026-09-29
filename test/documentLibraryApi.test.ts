import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, renameSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join, basename} from 'node:path';
import Fastify from 'fastify';
const dir=mkdtempSync(join(tmpdir(),'twoody-document-api-'));
process.env.TWOODY_DATA_DIR=dir;
const {sqlite}=await import('../src/db.js');
const {createAuthSession}=await import('../src/auth.js');
const {localDocumentRoutes}=await import('../src/routes/localDocuments.js');
const {retrieveDocuments}=await import('../src/documents/retrieval.js');
const app=Fastify();
await app.register(localDocumentRoutes);
for(const id of ['owner','other']) sqlite.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(id,`${id}@test.invalid`,Date.now());
const headers={authorization:`Bearer ${createAuthSession('owner').token}`};
const other={authorization:`Bearer ${createAuthSession('other').token}`};
sqlite.prepare('INSERT INTO document_folders(id,user_id,path,created_at) VALUES(?,?,?,?)').run('folder','owner','/synthetic/CV_2026-09-21',Date.now());
for (const [id,name] of [['po','CV_Product_Owner_FR.pdf'],['pm','CV_Platform_Product_Manager_FR.pdf']]) {
 sqlite.prepare(`INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,'owner','folder',`/synthetic/${name}`,name,'.pdf',100,1750000000000,'indexed',100);
 for(let i=0;i<23;i++)sqlite.prepare('INSERT INTO document_chunks(document_id,user_id,page,position,text) VALUES(?,?,?,?,?)').run(id,'owner',i+1,i,`${name} passage ${i}. Synthetic experience.`);
}
after(async()=>{await app.close();sqlite.close();const trash=join(homedir(),'.Trash');mkdirSync(trash,{recursive:true});renameSync(dir,join(trash,basename(dir)));});

test('library read authenticates, paginates and isolates users',async()=>{
 assert.equal((await app.inject({url:'/local_documents/files/po'})).statusCode,401);
 assert.equal((await app.inject({url:'/local_documents/files/po',headers:other})).statusCode,404);
 const first=(await app.inject({url:'/local_documents/files/po',headers})).json();
 assert.equal(first.passages.length,20);assert.equal(first.next_offset,20);assert.equal(first.file.path,undefined);
 const next=(await app.inject({url:'/local_documents/files/po?offset=20',headers})).json();
 assert.equal(next.passages.length,3);assert.equal(next.next_offset,null);
});
test('context scopes fail closed and document context contains no filesystem paths',async()=>{
 for(const access of [{mode:'off'},{mode:'selected',folderIds:[]},{mode:'selected',folderIds:['foreign']}]) {
  const r=await app.inject({method:'POST',url:'/local_documents/context',headers,payload:{question:'CV',document_access:access}});
  assert.equal(r.statusCode,200);assert.deepEqual(r.json().sources,[]);assert.doesNotMatch(r.json().context,/CV_Product/);
 }
 const bad=await app.inject({method:'POST',url:'/local_documents/context',headers,payload:{question:'CV',document_access:{mode:'selected'}}});assert.equal(bad.statusCode,422);
 const r=await app.inject({method:'POST',url:'/local_documents/context',headers,payload:{question:'résume mon CV Product Owner',document_access:{mode:'all'}}});
 assert.equal(r.statusCode,200);assert.ok(r.json().sources.length);assert.ok(r.json().sources.every((s:any)=>s.document_id==='po'));
 assert.doesNotMatch(r.body,/\/synthetic|Platform_Product_Manager/);assert.match(r.json().context,/NOT a creation date/);
});
test('context is sized for the model that reads it, sources match what is included',async()=>{
 const full=(await app.inject({method:'POST',url:'/local_documents/context',headers,payload:{question:'résume mon CV Product Owner',document_access:{mode:'all'}}})).json();
 assert.ok(full.context.length<=full.budget);assert.equal(full.budget,15000);
 const small=await app.inject({method:'POST',url:'/local_documents/context',headers,payload:{question:'résume mon CV Product Owner',document_access:{mode:'all'},context_window:4096}});
 if(small.statusCode===200){const b=small.json();assert.ok(b.context.length<=b.budget);assert.equal(b.budget,5017);
  assert.equal(b.sources.length+b.omitted_passages,full.sources.length+full.omitted_passages);
  for(const s of b.sources)assert.match(b.context,new RegExp(`\\[${s.n}\\]`));}
 else assert.equal(small.json().error,'context_budget');
 const tiny=await app.inject({method:'POST',url:'/local_documents/context',headers,payload:{question:'CV',document_access:{mode:'all'},context_window:1024}});
 assert.ok([200,413].includes(tiny.statusCode));
 if(tiny.statusCode===413)assert.equal(tiny.json().error,'context_budget');else assert.ok(tiny.json().context.length<=1254);
 assert.equal((await app.inject({method:'POST',url:'/local_documents/context',headers,payload:{question:'CV',document_access:{mode:'all'},context_window:12}})).statusCode,400);
});
test('new variant overrides an earlier assistant filename and pronoun preserves one file',async()=>{
 const found=await retrieveDocuments('owner','résume mon CV Product Owner',[{role:'assistant',content:'CV_Platform_Product_Manager_FR.pdf'}],['folder']);
 assert.deepEqual(found.files.map(f=>f.id),['po']);assert.ok(found.passages.every(p=>p.document_id==='po'));
 const follow=await retrieveDocuments('owner','résume-le',[{role:'assistant',content:'Voici [1]',sourcesJson:'[{"n":1,"document_id":"po"}]'}],['folder']);
 assert.deepEqual(follow.files.map(f=>f.id),['po']);
});
test('directory browsing requires authentication and owns its grant',async()=>{
 assert.equal((await app.inject({url:'/local_documents/browse?folder_id=folder'})).statusCode,401);
 assert.equal((await app.inject({url:'/local_documents/browse?folder_id=folder',headers:other})).statusCode,404);
 assert.equal((await app.inject({url:'/local_documents/browse?folder_id=folder&directory=..',headers})).statusCode,400);
 const result=await app.inject({url:'/local_documents/browse?folder_id=folder',headers});
 assert.equal(result.statusCode,200);assert.deepEqual(result.json().entries,[]); // fixture paths are outside the grant
});
test('revoked grant makes saved IDs unreadable',async()=>{
 sqlite.prepare('DELETE FROM document_chunks WHERE document_id=?').run('po');
 sqlite.prepare('DELETE FROM documents WHERE folder_id=?').run('folder');
 sqlite.prepare('DELETE FROM document_folders WHERE id=?').run('folder');
 assert.equal((await app.inject({url:'/local_documents/files/po',headers})).statusCode,404);
});
test('the home-folder preview lists what the walk leaves out',async()=>{
 assert.equal((await app.inject({url:'/local_documents/personal'})).statusCode,401);
 const preview=(await app.inject({url:'/local_documents/personal',headers})).json();
 assert.equal(preview.path,homedir());
 for(const name of ['Library','AppData','node_modules','Caches'])assert.ok(preview.skipped_directories.includes(name),name);
 for(const ext of ['.app','.photoslibrary','.musiclibrary'])assert.ok(preview.skipped_bundles.includes(ext),ext);
 assert.equal(preview.file_limit,20000);
});
test('iCloud Drive is listed by its name, not its directory',async()=>{
 const {folderName}=await import('../src/documents/library.js');
 assert.equal(folderName('/Users/claire/Library/Mobile Documents/com~apple~CloudDocs'),'iCloud Drive');
 assert.equal(folderName('/Users/claire/Library/Mobile Documents/com~apple~CloudDocs/Factures'),'Factures');
 assert.equal(folderName('/Users/claire/Library/CloudStorage/GoogleDrive-claire@example.com'),'Google Drive (claire@example.com)');
 assert.equal(folderName('/Users/claire/Library/CloudStorage/Dropbox'),'Dropbox');
 assert.equal(folderName('/Users/claire/Downloads'),'Downloads');
});
