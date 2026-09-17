export function spaceEngineMain(input: { engine: string; envKeys: string[]; sentinelPath: string }): void {
  if (process.argv.includes('--version')) {
    process.stdout.write(input.engine + ' 1.0.0\n');
    process.exit(0);
  }
  const fs = require('node:fs') as typeof import('node:fs');
  const recordPath = require('node:path').join(process.env.XDG_STATE_HOME, 'launch.json');
  const spawnPath = require('node:path').join(process.env.XDG_STATE_HOME, 'spawns');
  fs.appendFileSync(spawnPath, String(process.pid) + '\n');
  const record: { engine: string; argv: string[]; cwd: string; env: Record<string, string | undefined>; stdin: string; systemPrompt: string; requests: Array<{ method?: string; params?: Record<string, unknown> }>; hostReadable?: boolean; workspaceWritable?: boolean } = {
    engine: input.engine, argv: process.argv.slice(2), cwd: process.cwd(),
    env: Object.fromEntries(input.envKeys.map((key) => [key, process.env[key]])),
    stdin: '', systemPrompt: '', requests: [],
  };
  try { fs.readFileSync(input.sentinelPath); record.hostReadable = true; } catch { record.hostReadable = false; }
  try { fs.writeFileSync(require('node:path').join(process.env.HOME, '..', 'workspace', 'write-probe'), 'x'); record.workspaceWritable = true; } catch { record.workspaceWritable = false; }
  const save = () => fs.writeFileSync(recordPath, JSON.stringify(record));
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const promptIndex = record.argv.indexOf('--append-system-prompt-file');
  if (promptIndex >= 0) record.systemPrompt = fs.readFileSync(record.argv[promptIndex + 1]!, 'utf8');
  save();

  if (input.engine === 'opencode' && ['session', 'models'].includes(record.argv[0]!)) { send([]); return; }
  if (input.engine === 'codex' || input.engine === 'grok' || input.engine === 'devin') {
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (line: string) => {
      const message = JSON.parse(line);
      record.requests.push(message);
      save();
      if (message.id === undefined) return;
      const reply = (result: unknown) => send({ jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'initialize') {
        reply(input.engine === 'codex'
          ? { userAgent: 'fixture' }
          : { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
      } else if (message.method === 'thread/list') {
        reply({ data: [], nextCursor: null });
      } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
        reply({ thread: { id: message.params?.threadId ?? 'thread-new' }, model: 'test-model' });
      } else if (message.method === 'turn/start') {
        reply({ turn: { id: 'turn-fixture' } });
        setImmediate(() => {
          const threadId = message.params.threadId;
          send({ method: 'item/completed', params: {
            threadId, turnId: 'turn-fixture',
            item: { id: 'answer', type: 'agentMessage', text: 'fixture answer' },
          } });
          send({ method: 'turn/completed', params: {
            threadId, turn: { id: 'turn-fixture', status: 'completed', error: null },
          } });
        });
      } else if (message.method === 'session/new' || message.method === 'session/load') {
        reply({ sessionId: message.params?.sessionId ?? 'session-new' });
      } else if (message.method === 'session/prompt') {
        send({ method: 'session/update', params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture answer' } },
        } });
        reply({ stopReason: 'end_turn' });
      } else {
        reply({});
      }
    });
    process.stdin.on('end', () => process.exit(0));
    return;
  }

  const complete = () => {
    save();
    if (input.engine === 'claude' || input.engine === 'kimi') {
      send({ type: 'result', session_id: 'session-old' });
    } else if (input.engine === 'opencode') {
      send({ type: 'text', sessionID: 'session-old', part: { type: 'text', text: 'fixture answer' } });
    } else if (input.engine === 'pi') {
      send({ type: 'session', id: 'session-old' });
      send({ type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }],
      } });
      send({ type: 'agent_end' });
    } else {
      fs.writeSync(3, JSON.stringify({ type: 'ready', version: 1 }) + '\n');
      process.stdout.write('fixture answer\n');
    }
  };
  if (input.engine === 'pi' || input.engine === 'dsh') {
    complete();
  } else {
    process.stdin.on('data', (chunk) => { record.stdin += chunk.toString(); });
    process.stdin.on('end', complete);
  }
}
