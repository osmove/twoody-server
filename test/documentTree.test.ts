import {test} from 'node:test';
import assert from 'node:assert/strict';
import {indexedDirectory} from '../src/documents/tree.js';
const file=(id:string,path:string)=>({id,path,name:path.split('/').pop()!,status:'indexed',modified_at:1});
test('browses immediate children, counts descendants and excludes outside paths',()=>{
 const files=[file('1','/grant/Work/CV.pdf'),file('2','/grant/Work/Old/CV.pdf'),file('3','/grant/Note.txt'),file('4','/else/Secret.txt')];
 assert.deepEqual(indexedDirectory('/grant',files).map(e=>[e.type,e.name]),[['directory','Work'],['file','Note.txt']]);
 assert.deepEqual(indexedDirectory('/grant',files,'Work').map(e=>[e.type,e.name]),[['directory','Old'],['file','CV.pdf']]);
 assert.equal(indexedDirectory('/grant',files,'Missing').length,0);
});
test('rejects traversal and absolute directory paths',()=>{
 for(const path of ['../else','Work/../Old','/etc','Work\\Old','./Work','bad\0name'])assert.throws(()=>indexedDirectory('/grant',[],path),/invalid_directory/);
});
