import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertConfinedPath, type SpacePaths } from './paths';

/** Templates seed only newly created native configuration. Native-owned changes
 * are retained across idle eviction and process restart. */
export async function seedNativeTemplates(paths: SpacePaths, templates: readonly { target: string; contents: string }[]): Promise<void> {
  for (const template of templates) {
    const file = await assertConfinedPath(paths.engine, join(paths.engine, template.target));
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try { await writeFile(file, template.contents, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
