/** Deterministic native protocol fixture; separate acceptance uses real Codex. */
export function spaceMigrationEngineMain(): void {
  if (process.argv.includes('--version')) { process.stdout.write('fixture 1.0.0\n'); return; }
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const home = process.env.CODEX_HOME!;
  // Real Codex creates these outside /tmp; reproduce that container-specific
  // behavior so an importer cannot seal executable aliases into migrated state.
  const scratch = path.join(home, 'tmp', 'arg0', 'fixture');
  fs.mkdirSync(scratch, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(scratch, 'apply_patch'));
  const files = (directory: string): string[] => fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : entry.name.endsWith('.jsonl') ? [path.join(directory, entry.name)] : []) : [];
  const threads = () => files(path.join(home, 'sessions')).map(file => {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]!).payload;
    return { id: meta.id, cwd: meta.cwd, preview: 'fixture history', name: null, source: 'cli',
      createdAt: 1, updatedAt: 2, modelProvider: 'fixture' };
  });
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', (line: string) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const reply = (result: unknown) => send({ id: message.id, result });
    const params = message.params;
    if (message.method === 'initialize') reply({ userAgent: 'fixture' });
    else if (message.method === 'thread/resume') reply({ thread: { id: params.threadId }, cwd: params.cwd, model: 'fixture' });
    else if (message.method === 'thread/start') reply({ thread: { id: 'new-thread' }, cwd: params.cwd, model: 'fixture' });
    else if (message.method === 'thread/read') reply({ thread: { id: params.threadId } });
    else if (message.method === 'thread/list') {
      const cwds = params.cwd === undefined ? undefined : Array.isArray(params.cwd) ? params.cwd : [params.cwd];
      reply({ data: threads().filter(thread => !cwds || cwds.includes(thread.cwd)), nextCursor: null });
    } else if (message.method === 'turn/start') {
      reply({ turn: { id: 'turn' } });
      setImmediate(() => {
        send({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'turn',
          item: { id: 'answer', type: 'agentMessage', text: 'continued fixture' } } });
        send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn', status: 'completed', error: null } } });
      });
    } else reply({});
  });
  process.stdin.on('end', () => process.exit(0));
}
