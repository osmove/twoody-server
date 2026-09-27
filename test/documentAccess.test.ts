import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentAccess } from '../src/documents/access.js';
test('document access preserves legacy clients and selected empty scope', () => {
 assert.deepEqual(documentAccess(undefined), {mode:'all'});
 assert.deepEqual(documentAccess('{"mode":"selected","folderIds":[]}'), {mode:'selected',folderIds:[]});
 assert.deepEqual(documentAccess({mode:'only',folderIds:['a','a']}), {mode:'only',folderIds:['a']});
});
test('invalid access fails closed, including malformed multipart values', () => {
 for(const value of [null,'bad',{}, {mode:'selected'}, {mode:'all',folderIds:[1]}, {mode:'only',folderIds:'all'}]) assert.throws(()=>documentAccess(value));
});
