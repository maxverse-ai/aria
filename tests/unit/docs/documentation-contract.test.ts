import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const docsDir = join(repoRoot, 'docs');
const ROLES = ['current', 'in progress', 'historical', 'archived'] as const;

/** Repository-relative path with forward slashes, as markdown links write them. */
function repoPath(absolute: string): string {
  return relative(repoRoot, absolute).split(sep).join('/');
}

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
      const name = repoPath(file);
      // A Windows checkout writes these files back with CRLF.
      const lines = text.split(/\r?\n/);
      if (!lines[0]!.startsWith('# ')) offenders.push(`${name}: first line is not a title`);
      const header = lines.find((line) => line.startsWith('> Status: '));
      if (!header) { offenders.push(`${name}: no '> Status: ' line`); continue; }
      const rest = header.slice('> Status: '.length);
      // A second role after the first separator is a header written over
      // itself: the role is stated once, and what follows it is evidence.
      const separator = rest.indexOf(' — ');
      const evidence = separator === -1 ? '' : rest.slice(separator + ' — '.length);
      if (ROLES.some((role) => evidence.startsWith(`${role} — `))) {
        offenders.push(`${name}: states its role twice — "${rest}"`);
        continue;
      }
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
        linked.add(repoPath(resolve(dirname(source), target)));
      }
    }
    const orphans = files
      .map((file) => repoPath(file))
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
        if (!exists) broken.push(`${repoPath(source)} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('pairs every release note with its Chinese translation', async () => {
    const names = await readdir(join(docsDir, 'releases'));
    const english = names.filter(
      (name) => name.endsWith('.md') && !name.endsWith('.zh.md'),
    );
    const missingZh = english.filter(
      (name) => !names.includes(name.replace(/\.md$/, '.zh.md')),
    );
    const orphanedZh = names
      .filter((name) => name.endsWith('.zh.md'))
      .filter((name) => !names.includes(name.replace(/\.zh\.md$/, '.md')));
    expect([...missingZh, ...orphanedZh]).toEqual([]);
  });

  it('keeps the two READMEs indexing the same documents', async () => {
    const index = async (name: string): Promise<string[]> => {
      const text = await readFile(join(repoRoot, name), 'utf8');
      return relativeLinks(text).filter((target) => target.startsWith('docs/')).sort();
    };
    expect(await index('README.zh.md')).toEqual(await index('README.md'));
  });

  it('names only files this repository has as a single source of truth', async () => {
    // A definition that names a file the repository does not carry — most often
    // a private-fork artifact that never came across — is a source of truth
    // nobody can read.
    const text = await readFile(join(docsDir, 'DOCUMENTATION_POLICY.md'), 'utf8');
    const section = text
      .split(/^## /m)
      .find((part) => part.startsWith('Single sources of truth'));
    expect(section).toBeDefined();

    const missing: string[] = [];
    for (const row of section!.split(/\r?\n/)) {
      if (!row.startsWith('|')) continue;
      const definition = row.split('|')[2] ?? '';
      for (const match of definition.matchAll(/`([^`]+)`/g)) {
        const target = match[1]!.split('#')[0]!;
        // Only backticked names that read as paths; a command is not a path.
        if (!/[./]/.test(target)) continue;
        const exists = await stat(join(repoRoot, target)).then(() => true, () => false);
        if (!exists) missing.push(`${target} — named by "${definition.trim()}"`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('lists every channel command each README promises to list', async () => {
    // The registry is the surface; the quick-reference table is how a reader
    // learns it exists. `weixin-ilink` and the meeting commands arrived without
    // the table following, so the table quietly stopped being the list.
    const source = await readFile(join(repoRoot, 'src/commands/index.ts'), 'utf8');
    const table = source.slice(source.indexOf('const handlers: Record<string, Handler>'));
    const commands = [...table.matchAll(/^ {2}'(\/[a-z-]+)':/gm)].map((match) => match[1]!);
    expect(commands.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const name of ['README.md', 'README.zh.md']) {
      const markdown = await readFile(join(repoRoot, name), 'utf8');
      const rows = markdown
        .split(/\r?\n/)
        .filter((line) => /^\| `\//.test(line))
        .map((line) => line.split('|')[1] ?? '');
      for (const command of commands) {
        const listed = rows.some((row) => new RegExp(`\`${command}(?=[\\s\`,]|$)`).test(row));
        if (!listed) offenders.push(`${name}: ${command}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
