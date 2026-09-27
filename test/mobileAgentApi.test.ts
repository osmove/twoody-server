import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,renameSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,basename} from 'node:path';
import Fastify from 'fastify';
const dir=mkdtempSync(join(tmpdir(),'twoody-mobile-agent-api-'));process.env.TWOODY_DATA_DIR=dir;
const {sqlite}=await import('../src/db.js');
const {createAuthSession}=await import('../src/auth.js');
const {mobileAgentRoutes}=await import('../src/routes/mobileAgent.js');
sqlite.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run('owner','test@invalid.test',Date.now());
const pair=createAuthSession('owner','pair:phone');const ordinary=createAuthSession('owner');
const calls:Array<unknown>=[];
const app=Fastify();await app.register(mobileAgentRoutes,{request:async(owner,command,input)=>{calls.push({owner,command,input});return {folders:[]};}});
after(async()=>{await app.close();sqlite.close();mkdirSync(join(homedir(),'.Trash'),{recursive:true});renameSync(dir,join(homedir(),'.Trash',basename(dir)));});
test('requires pairing, derives identity from auth and validates one-shot decisions',async()=>{
 assert.equal((await app.inject({url:'/mobile_agent'})).statusCode,401);
 assert.equal((await app.inject({url:'/mobile_agent',headers:{authorization:`Bearer ${ordinary.token}`}})).statusCode,403);
 const headers={authorization:`Bearer ${pair.token}`};
 assert.equal((await app.inject({url:'/mobile_agent',headers})).statusCode,200);
 assert.deepEqual(calls[0],{owner:`owner:${pair.sessionId}`,command:'list',input:{}});
 for(const payload of [{command:'grant',path:'/etc'},{command:'approve',decision:'allow-session'},{command:'send',text:'x'.repeat(16001)}])assert.equal((await app.inject({url:'/mobile_agent',method:'POST',headers,payload})).statusCode,400);
 assert.equal(calls.length,1);
});
test('revoked pairing cannot reach the desktop again',async()=>{
 sqlite.prepare('DELETE FROM auth_sessions WHERE id=?').run(pair.sessionId);
 assert.equal((await app.inject({url:'/mobile_agent',headers:{authorization:`Bearer ${pair.token}`}})).statusCode,401);
 assert.equal(calls.length,1);
});
