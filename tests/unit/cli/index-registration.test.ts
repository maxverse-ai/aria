import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI command registration', () => {
  it('does not register the removed legacy migrate command', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).not.toMatch(/\.command\(['"]migrate['"]\)/);
    expect(source).not.toContain('runMigrate');
  });

  it('registers app-secret options for non-interactive app bootstrap commands', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    const appSecretOptions = source.match(/--app-secret <secret>/g) ?? [];
    expect(appSecretOptions.length).toBeGreaterThanOrEqual(3);
  });

  it('warns on stderr every time --app-secret is supplied', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    // One call per action that accepts --app-secret (run, profile create,
    // profile import, start) plus the helper definition itself.
    const callSites = source.match(/warnAppSecretOnCommandLine\(opts\.appSecret\)/g) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('process.stderr.write');
  });

  it('exposes a top-level capabilities command and keeps control hidden', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toContain(".command('capabilities')");
    expect(source).toContain(".command('control', { hidden: true })");
  });

  it('hides machine-facing commands from normal help', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toContain(".command('inbox', { hidden: true })");
    expect(source).toContain(".command('worker', { hidden: true })");
    expect(source).toContain(".command('get', { hidden: true })");
    expect(source).toContain(".command('agent <command>', { hidden: true })");
  });

  it('registers the stop --keep-autostart flag and the completion command', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toContain("--keep-autostart");
    expect(source).toContain(".command('completion <shell>')");
    expect(source).toContain('emitCompletion');
  });

  it('registers the versioned read-only control-plane commands', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toContain(".command('control', { hidden: true })");
    expect(source).toContain(".command('capabilities')");
    expect(source).toContain(".command('show [name]')");
    expect(source).toContain(".command('config')");
    expect(source).toContain(".command('runtime')");
    expect(source.match(/stable machine-readable JSON/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('registers the staged configuration change protocol commands', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toContain(".command('settings')");
    expect(source).toContain(".command('plan <setting> <value>')");
    expect(source).toContain(".command('plan-show <plan-id>')");
    expect(source).toContain(".command('confirm <plan-id>')");
    expect(source).toContain(".command('apply <plan-id>')");
  });

  it('registers versioned trigger contract discovery without mutation commands', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toContain(".command('trigger')");
    expect(source).toContain(".command('schema <name>')");
    expect(source).toContain('List shipped trigger-platform capabilities');
    expect(source).not.toContain(".command('create-schedule')");
  });
});
