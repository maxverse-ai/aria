import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter } from '../../src/agent/engines/dsh/adapter.js';
import { DshProgress } from '../../src/agent/engines/dsh/progress.js';
import { consumeCotEvents, type CotPublisher } from '../../src/bot/cot.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface RecordPayload {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

describe('DshAdapter process contract', () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanups.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('runs one headless task and emits the final answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-adapter-'));
    cleanups.push(dir);
    const binary = await createFakeDsh(dir, 'answer from dsh', 0);
    const cwd = await realpath(dir);

    const run = new DshAdapter({ binary, profileStateDir: dir }).run({
      runId: 'run-dsh',
      scopeId: 'scope-dsh',
      prompt: 'hello',
      cwd,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'final_text', content: 'answer from dsh' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const record = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8')) as RecordPayload;
    expect(record.argv).toEqual(['--profile', 'headless', '--patch', expect.any(String), expect.stringContaining('hello')]);
    expect(record.argv[4]).toContain('Aria 运行约定');
    expect(record.argv[4]).toContain('hello');
  });

  it('emits an error when dsh exits nonzero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-adapter-'));
    cleanups.push(dir);
    const binary = await createFakeDsh(dir, '', 1);
    const cwd = await realpath(dir);

    const run = new DshAdapter({ binary, profileStateDir: dir }).run({
      runId: 'run-dsh-fail',
      scopeId: 'scope-dsh',
      prompt: 'boom',
      cwd,
    });

    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });
  it('delivers tool progress before process exit, separates final output and cleans extensions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-progress-'));
    cleanups.push(dir);
    const binary = join(dir, 'dsh');
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
(async () => {
  const patchPath = process.argv[process.argv.indexOf('--patch')+1];
  const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  const plugin = await import(patch[0].insert[0].name);
  let listener;
  plugin.apply({on: (_, fn) => {listener=fn}, provide: () => {}});
  const session = {id:'owned', header:{}};
  const emit = (type, data) => listener(session, {type,data});
  emit('turn/start', {turn:0});
  emit('step/start', {step:0});
  emit('assistant/message', {message:{content:[{type:'reasoning',text:'private reasoning'}]}});
  listener({id:'other',header:{parentSession:'owned'}}, {type:'tool/call',data:{callId:'other',name:'bash',arguments:'{}'}});
  emit('tool/call', {callId:'call-1',name:'bash',arguments:'{"command":"pwd"}'});
  // The test must explicitly acknowledge progress before the process can finish.
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(join(dir, 'continue'))})) return;
    clearInterval(timer);
    emit('tool/result', {message:{content:[{type:'tool-result',toolCallId:'call-1',isError:false,content:[{type:'text',text:'ok'}]}]}});
    console.log('final answer');
  }, 10);
})();
`, { mode: 0o755 });
    const run = new DshAdapter({binary, profileStateDir:dir}).run({runId:'progress',scopeId:'scope',prompt:'test',cwd:dir});
    const events: AgentEvent[] = [];
    const cotEvents: string[] = [];
    const publisher = {
      runId: 'progress', scope: 'scope',
      enqueue(type: string) { cotEvents.push(type); },
      async finish() {},
    } as unknown as CotPublisher;
    let cotUpdatedBeforeExit = false;
    async function* observed(): AsyncGenerator<AgentEvent> {
      for await (const event of run.events) {
        events.push(event);
        yield event;
        if (event.type === 'tool_use') {
          cotUpdatedBeforeExit = cotEvents.includes('TOOL_CALL_ARGS') && !(await run.waitForExit(0));
          await writeFile(join(dir, 'continue'), 'yes');
        }
      }
    }
    await consumeCotEvents(observed(), publisher, {detail:'detailed',showToolCalls:true});
    expect(cotUpdatedBeforeExit).toBe(true);
    expect(cotEvents).toContain('TOOL_CALL_RESULT');
    expect(cotEvents).not.toContain('REASONING_MESSAGE_CONTENT');
    expect(events).toEqual([
      {type:'system',sessionId:'owned'},
      {type:'text',delta:'DSH 正在执行第 1 轮处理。'},
      {type:'tool_use',id:'call-1',name:'bash',input:{command:'pwd'}},
      {type:'tool_result',id:'call-1',output:'ok',isError:false},
      {type:'final_text',content:'final answer'},
      {type:'done',terminationReason:'normal'},
    ]);
    const {readdir} = await import('node:fs/promises');
    expect((await readdir(dir)).filter(name => name.startsWith('dsh-progress-'))).toEqual([]);
  });

  it('rejects a final-only binary instead of silently claiming working progress', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-no-progress-'));
    cleanups.push(dir);
    const binary = join(dir, 'dsh');
    await writeFile(binary, `#!${process.execPath}\nconsole.log('answer without progress');`, {mode:0o755});
    const run = new DshAdapter({binary,profileStateDir:dir}).run({runId:'missing',scopeId:'scope',prompt:'test',cwd:dir});
    expect(await collect(run.events)).toEqual([{type:'error',message:'dsh runtime error: DSH progress plugin did not initialize',terminationReason:'failed'}]);
  });

  it('stops an active child and cleans progress files even when SIGTERM is ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-stop-'));
    cleanups.push(dir);
    const binary = join(dir, 'dsh');
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM',()=>{});
fs.writeSync(3, JSON.stringify({type:'ready',version:1})+String.fromCharCode(10));
fs.writeSync(3, JSON.stringify({type:'text',delta:'running'})+String.fromCharCode(10));
setInterval(()=>{},1000);
`, {mode:0o755});
    const run = new DshAdapter({binary,profileStateDir:dir,stopGraceMs:10}).run({runId:'stop',scopeId:'scope',prompt:'test',cwd:dir});
    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text') await run.stop();
    }
    expect(events.at(-1)).toMatchObject({type:'error'});
    expect(await run.waitForExit(0)).toBe(true);
    const {readdir} = await import('node:fs/promises');
    expect((await readdir(dir)).filter(name=>name.startsWith('dsh-progress-'))).toEqual([]);
  });

  it('decodes split UTF-8 frames and fails closed on a missing handshake or truncated frame', async () => {
    const progress = new DshProgress();
    const bytes = Buffer.from(JSON.stringify({type:'ready',version:1})+'\n'+JSON.stringify({type:'text',delta:'正在运行'})+'\n');
    for (const byte of bytes) progress.push(Buffer.from([byte]));
    progress.close();
    expect(await collect(progress.events())).toEqual([{type:'text',delta:'正在运行'}]);
    expect(progress.error).toBeUndefined();
    const missing = new DshProgress();
    missing.push(Buffer.from('{"type":"text","delta":"bad"}\n'));
    expect(missing.error?.message).toContain('handshake');
    const truncated = new DshProgress();
    truncated.push(Buffer.from('{'));
    truncated.close();
    expect(truncated.error?.message).toContain('Truncated');
  });

});

async function createFakeDsh(dir: string, answer: string, exitCode: number): Promise<string> {
  const file = join(dir, 'dsh');
  await writeFile(
    file,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'fs.writeFileSync(',
      "  require('node:path').join(process.env.FAKE_DSH_DIR, 'record.json'),",
      '  JSON.stringify({ argv: process.argv.slice(2), env: process.env }),',
      ');',
      `fs.writeSync(3, JSON.stringify({type:'ready', version:1})+'\\n');`,
      `if (${JSON.stringify(answer)}) console.log(${JSON.stringify(answer)});`,
      `process.exit(${exitCode});`,
    ].join('\n'),
    { mode: 0o755 },
  );
  await chmod(file, 0o755);
  process.env.FAKE_DSH_DIR = dir;
  return file;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
