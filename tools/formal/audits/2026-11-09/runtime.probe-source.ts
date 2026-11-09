import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { strict as assert } from 'node:assert';
import { GrokAgentRun, GrokAgentStdioRuntime } from '../../../../src/agent/engines/grok/agent-stdio/runtime';
import { GrokAgentStdioClient } from '../../../../src/agent/engines/grok/agent-stdio/client';
import { DevinAgentRun, DevinAcpRuntime } from '../../../../src/agent/engines/devin/acp/runtime';
import { DevinAcpClient } from '../../../../src/agent/engines/devin/acp/client';
import { AppServerRun, CodexAppServerRuntime } from '../../../../src/agent/engines/codex/app-server/runtime';
import { CodexAppServerClient } from '../../../../src/agent/engines/codex/app-server/client';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function child(){return Object.assign(new EventEmitter(),{stdout:new PassThrough(),stdin:new PassThrough(),stderr:new PassThrough(),exitCode:0,signalCode:null,kill:()=>true});}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
async function stopBeforePrompt(kind:'grok'|'devin'){
 const c=child(); const wire:any[]=[]; const reached=deferred(); let pending:any;
 const client=kind==='grok'?new GrokAgentStdioClient(c as any,async()=>({})):new DevinAcpClient(c as any,async()=>({}));
 c.stdin.on('data',(chunk)=>{for(const line of chunk.toString().trim().split('\n')){const m=JSON.parse(line);wire.push(m);if(m.method==='session/new'){pending=m;reached.resolve();}if(m.method==='session/prompt')queueMicrotask(()=>c.stdout.write(JSON.stringify({id:m.id,result:{stopReason:'end_turn'}})+'\n'));}});
 const runtime:any=kind==='grok'?new GrokAgentStdioRuntime({binary:'unused',profileStateDir:process.cwd(),inheritGrokHome:true,access:'full'}):new DevinAcpRuntime({binary:'unused',profileStateDir:process.cwd(),access:'full'});
 runtime.client=async()=>client;
 const opts={runId:'probe',scopeId:'scope',cwd:process.cwd(),prompt:'isolated no effects'};
 const run=kind==='grok'?new GrokAgentRun(runtime,opts):new DevinAgentRun(runtime,opts);
 const iterator=run.events[Symbol.asyncIterator]();const first=iterator.next();await reached.promise;await run.stop();
 c.stdout.write(JSON.stringify({id:pending.id,result:{sessionId:'isolated'}})+'\n');
 await first;let next=await iterator.next();while(!next.done)next=await iterator.next();
 const methods=wire.map(m=>m.method);assert(methods.includes('session/prompt'));assert(methods.indexOf('session/prompt')<methods.indexOf('session/cancel'));
 console.log(JSON.stringify({case:kind+' stop during preparation',observed:methods,bugReproduced:true}));await client.dispose();
}
async function eof(kind:'grok'|'devin'){
 const c=child();const client=kind==='grok'?new GrokAgentStdioClient(c as any,async()=>({})):new DevinAcpClient(c as any,async()=>({}));
 let closed=false,settled=false;client.onClosed(()=>closed=true);const pending=client.request('session/prompt',{},0).then(()=>settled=true,()=>settled=true);
 c.stdout.end();await tick();await tick();assert(!closed&&!settled);
 console.log(JSON.stringify({case:kind+' stdout EOF',closed,settled,bugReproduced:true}));await client.dispose();await pending;
}
async function staleCompleted(){
 const c=child();const client=new CodexAppServerClient(c as any);let subscribed=false;
 c.stdin.on('data',(chunk)=>{for(const line of chunk.toString().trim().split('\n')){const m=JSON.parse(line);if(m.method==='thread/resume')queueMicrotask(()=>c.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:'thread'},model:'test'}})+'\n'));if(m.method==='turn/start')queueMicrotask(()=>{c.stdout.write(JSON.stringify({id:m.id,result:{turn:{id:'current'}}})+'\n');c.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'thread',turn:{id:'old',status:'completed'}}})+'\n');});}});
 const runtime:any=new CodexAppServerRuntime({binary:'unused',profileStateDir:process.cwd(),inheritCodexHome:true,sandbox:'workspace-write'});runtime.client=async()=>client;
 const run=new AppServerRun(runtime,{runId:'current-run',scopeId:'scope',cwd:process.cwd(),threadId:'thread',prompt:'isolated'});const events=[];for await(const event of run.events)events.push(event);
 assert(events.some(e=>e.type==='done'&&e.terminationReason==='normal'));
 console.log(JSON.stringify({case:'codex stale nested turn/completed',events,bugReproduced:true}));await client.dispose();
}
await stopBeforePrompt('grok');await stopBeforePrompt('devin');await eof('grok');await eof('devin');await staleCompleted();
async function replay(){
 const c=child();const client=new GrokAgentStdioClient(c as any,async()=>({}));
 c.stdin.on('data',(chunk)=>{for(const line of chunk.toString().trim().split('\n')){const m=JSON.parse(line);if(m.method==='session/load')queueMicrotask(()=>{c.stdout.write(JSON.stringify({method:'session/update',params:{sessionId:'history',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD_HISTORY'}}}})+'\n');c.stdout.write(JSON.stringify({id:m.id,result:{sessionId:'history'}})+'\n');});if(m.method==='session/prompt')queueMicrotask(()=>c.stdout.write(JSON.stringify({id:m.id,result:{stopReason:'end_turn'}})+'\n'));}});
 const runtime:any=new GrokAgentStdioRuntime({binary:'unused',profileStateDir:process.cwd(),inheritGrokHome:true,access:'full'});runtime.client=async()=>client;
 const run=new GrokAgentRun(runtime,{runId:'replay',scopeId:'scope',cwd:process.cwd(),sessionId:'history',prompt:'new'});const events=[];for await(const event of run.events)events.push(event);
 assert(events.some(e=>e.type==='final_text'&&e.content==='OLD_HISTORY'));console.log(JSON.stringify({case:'grok load history treated as current final',events,bugReproduced:true}));await client.dispose();
}
await replay();
