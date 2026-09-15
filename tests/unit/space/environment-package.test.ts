import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareEnvironmentPackages, validateEnvironmentPackages } from '../../../src/space/environment-package';
import { prepareSpacePaths, resolveSpacePaths } from '../../../src/space/paths';
import type { SpaceKey } from '../../../src/space/identity';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), 'aria-environment-package-')); roots.push(root);
  const module = join(root, 'package.mjs');
  const contents = `export const environmentPackageRevision='1';\nexport async function prepareSpaceEnvironment(context) { ${body} }`;
  await writeFile(module, contents, { mode: 0o600 });
  const definition = { id: 'example-cli', revision: '1', module, sha256: createHash('sha256').update(contents).digest('hex') };
  const key: SpaceKey = { kind: 'shared', profileId: 'example', authorityId: 'a'.repeat(64), trustDomain: 'group-a' };
  const paths = resolveSpacePaths(root, key); await prepareSpacePaths(paths);
  return { root, definition, context: { profileId: 'example', key, paths } };
}
describe('image-owned environment package', () => {
  it('provides stable local CLI instructions and preserves user state across preparation', async () => {
    const f = await fixture(`
      const {writeFile} = await import('node:fs/promises');
      try { await writeFile(context.paths.home + '/account', 'initial', {flag:'wx',mode:384}); }
      catch(e) { if(e.code !== 'EEXIST') throw e; }
      return {environment:{EXAMPLE_CONFIG:context.paths.home + '/account'},instructions:'Use example-cli locally.'};
    `);
    const first = await prepareEnvironmentPackages([f.definition], f.context);
    await writeFile(join(f.context.paths.home, 'account'), 'user-chosen');
    expect(await prepareEnvironmentPackages([f.definition], f.context)).toEqual(first);
    expect(await readFile(join(f.context.paths.home, 'account'), 'utf8')).toBe('user-chosen');
    const key = { ...f.context.key, trustDomain: 'group-b' } as SpaceKey;
    const paths = resolveSpacePaths(f.root, key); await prepareSpacePaths(paths);
    const second = await prepareEnvironmentPackages([f.definition], { ...f.context, key, paths });
    expect(second.environment.EXAMPLE_CONFIG).not.toBe(first.environment.EXAMPLE_CONFIG);
    expect(await readFile(second.environment.EXAMPLE_CONFIG!, 'utf8')).toBe('initial');
  });
  it('refuses a changed package, writable shared module, or mismatched Space before initialization', async () => {
    const f = await fixture('throw new Error("should not initialize");');
    await expect(prepareEnvironmentPackages([{ ...f.definition, sha256: '0'.repeat(64) }], f.context)).rejects.toThrow('integrity');
    await chmod(f.definition.module, 0o666);
    await expect(prepareEnvironmentPackages([f.definition], f.context)).rejects.toThrow('integrity');
    await expect(prepareEnvironmentPackages([f.definition], { ...f.context, profileId: 'another' })).rejects.toThrow('owner');
  });
  it('does not allow packages to replace HOME, inject startup hooks, or conflict with each other', async () => {
    for (const key of ['HOME', 'PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'CONTAINER_HOST']) {
      const f = await fixture(`return {environment:{${key}:'unsafe'},instructions:''};`);
      await expect(prepareEnvironmentPackages([f.definition], f.context)).rejects.toThrow('variable');
    }
    const f = await fixture("return {environment:{EXAMPLE:'value'},instructions:''};");
    await expect(prepareEnvironmentPackages([f.definition, { ...f.definition, id: 'other' }], f.context)).rejects.toThrow('duplicate');
  });
  it('rejects duplicate ids and aborts before invoking initialization', async () => {
    const f = await fixture('throw new Error("should not initialize");');
    expect(() => validateEnvironmentPackages([f.definition, f.definition])).toThrow();
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(prepareEnvironmentPackages([f.definition], { ...f.context, signal: controller.signal })).rejects.toThrow('cancelled');
  });
});
