import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const docsDir = join(repoRoot, 'docs');
const ROLES = ['current', 'in progress', 'historical', 'archived'] as const;

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'releases') continue;
      files.push(...await markdownFiles(full));
    } else if (entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files.sort();
}

/** Relative link targets in a markdown document, excluding anchors and URLs. */
function relativeLinks(markdown: string): string[] {
  const targets = new Set<string>();
  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]!;
    if (target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    targets.add(target.split('#')[0]!);
  }
  return [...targets];
}

describe('documentation contract', () => {
  it('gives every non-release document a role-bearing status header', async () => {
    const offenders: string[] = [];
    for (const file of await markdownFiles(docsDir)) {
      const text = await readFile(file, 'utf8');
      const name = relative(repoRoot, file);
      const lines = text.split('\n');
      if (!lines[0]!.startsWith('# ')) offenders.push(`${name}: first line is not a title`);
      const header = lines.find((line) => line.startsWith('> Status: '));
      if (!header) { offenders.push(`${name}: no '> Status: ' line`); continue; }
      const rest = header.slice('> Status: '.length);
      const role = ROLES.find((candidate) => rest === candidate || rest.startsWith(`${candidate} —`));
      if (!role) { offenders.push(`${name}: role is not one of ${ROLES.join(', ')}`); continue; }
      if (role !== 'current' && !rest.startsWith(`${role} — `)) {
        offenders.push(`${name}: '${role}' needs checkable evidence after ' — '`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every document reachable from the README, AGENTS.md or another document', async () => {
    const files = await markdownFiles(docsDir);
    const roots = ['README.md', 'README.zh.md', 'AGENTS.md'].map((name) => join(repoRoot, name));
    const sources = [...roots, ...files];
    const linked = new Set<string>();
    for (const source of sources) {
      const text = await readFile(source, 'utf8');
      for (const target of relativeLinks(text)) {
        linked.add(relative(repoRoot, resolve(dirname(source), target)));
      }
    }
    const orphans = files
      .map((file) => relative(repoRoot, file))
      .filter((name) => !linked.has(name));
    expect(orphans).toEqual([]);
  });

  it('resolves every relative link', async () => {
    const sources = [
      ...['README.md', 'README.zh.md', 'AGENTS.md'].map((name) => join(repoRoot, name)),
      ...await markdownFiles(docsDir),
    ];
    const broken: string[] = [];
    for (const source of sources) {
      const text = await readFile(source, 'utf8');
      for (const target of relativeLinks(text)) {
        const resolved = resolve(dirname(source), target);
        const exists = await stat(resolved).then(() => true, () => false);
        if (!exists) broken.push(`${relative(repoRoot, source)} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('keeps the two READMEs indexing the same documents', async () => {
    const index = async (name: string): Promise<string[]> => {
      const text = await readFile(join(repoRoot, name), 'utf8');
      return relativeLinks(text).filter((target) => target.startsWith('docs/')).sort();
    };
    expect(await index('README.zh.md')).toEqual(await index('README.md'));
  });
});
