// Generates site/content/docs/ from ../docs/*.md so the repository's docs
// directory stays the single source of truth. Re-run on every dev/build via
// the chained `sync-docs` step in package.json scripts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(siteDir, '..');
const docsDir = path.join(repoRoot, 'docs');
const outDir = path.join(siteDir, 'content', 'docs');
const generatedDir = path.join(siteDir, 'lib', 'generated');
const GITHUB = 'https://github.com/maxverse-ai/aria';

function slugSegment(name) {
  return name
    .toLowerCase()
    .replace(/[_.\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function slugPath(rel) {
  return rel
    .split('/')
    .map((seg) => slugSegment(seg))
    .join('/');
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else if (entry.isFile() && entry.name.endsWith('.md'))
      out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function statusRole(statusLine) {
  if (!statusLine) return 'current';
  return statusLine.split(/\s+[—–-]\s+/)[0].trim().toLowerCase();
}

// Fence languages that the bundled Shiki config cannot highlight.
const UNSUPPORTED_FENCE_LANGS = new Set(['caddyfile']);

function rewriteLinks(body, srcAbs, warnings) {
  // Transform only outside fenced code blocks.
  const parts = body.split(/(^```[\s\S]*?^```\s*$)/m);
  const srcDir = path.dirname(srcAbs);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        // Inside a fence: only normalize the info-string language.
        return part.replace(/^```([a-zA-Z0-9_-]+)/m, (full, lang) =>
          UNSUPPORTED_FENCE_LANGS.has(lang) ? '```text' : full,
        );
      }
      return part.replace(/\]\(([^)\s]+)\)/g, (full, target) => {
        if (/^(https?:|mailto:|#|<)/.test(target)) return full;
        const [rawPath, frag = ''] = target.split('#');
        let decoded;
        try {
          decoded = decodeURIComponent(rawPath);
        } catch {
          return full;
        }
        const abs = path.resolve(srcDir, decoded);
        const relToDocs = path.relative(docsDir, abs).split(path.sep).join('/');
        if (!relToDocs.startsWith('..') && decoded.endsWith('.md')) {
          const slug = slugPath(relToDocs.replace(/\.md$/, ''));
          return `](/docs/${slug}${frag ? `#${frag}` : ''})`;
        }
        if (fs.existsSync(abs)) {
          const relToRepo = path.relative(repoRoot, abs).split(path.sep).join('/');
          const kind = fs.statSync(abs).isDirectory() ? 'tree' : 'blob';
          return `](${GITHUB}/${kind}/main/${relToRepo}${frag ? `#${frag}` : ''})`;
        }
        warnings.push(`unresolved link ${target} in ${path.relative(docsDir, srcAbs)}`);
        return full;
      });
    })
    .join('');
}

const files = walk(docsDir);
const warnings = [];
const pages = []; // { rel, outRel, slug, title, role }
const sourceMap = {}; // slugs.join('/') -> repo-relative source path

fs.rmSync(outDir, { recursive: true, force: true });

for (const rel of files) {
  const srcAbs = path.join(docsDir, rel);
  const raw = fs.readFileSync(srcAbs, 'utf8');

  let title = firstMatch(raw, /^#\s+(.+)$/m) ?? rel.replace(/\.md$/, '');
  title = title.replace(/^Archived:\s*/i, '');
  const statusLine = firstMatch(raw, /^>\s*Status:\s*(.+)$/m);
  const role = statusRole(statusLine);

  // Drop the first H1 — DocsTitle renders the frontmatter title instead.
  const body = raw.replace(/^#\s+.+\n+/, '');
  const transformed = rewriteLinks(body, srcAbs, warnings);

  const outRel = slugPath(rel.replace(/\.md$/, '')) + '.mdx';
  const slug = outRel.replace(/\.mdx$/, '');
  const description = statusLine
    ? statusLine.length <= 140
      ? statusLine
      : statusLine.slice(0, 140).replace(/\s\S*$/, '') + '…'
    : null;

  const frontmatter =
    [
      '---',
      `title: ${JSON.stringify(title)}`,
      description ? `description: ${JSON.stringify(`Status: ${description}`)}` : null,
      '---',
    ]
      .filter(Boolean)
      .join('\n') + '\n\n';

  const outAbs = path.join(outDir, outRel);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, frontmatter + transformed);
  pages.push({ rel, outRel, slug, title, role });
  sourceMap[slug] = `docs/${rel}`;
}

// Landing page for /docs.
const landing = `---
title: Aria Documentation
description: A local-first control plane for coding agents — chat is the remote control, not the compute plane.
---

Aria turns a chat surface into the interaction surface for coding agents that
run on your own machine. These pages are generated from
[\`docs/\`](${GITHUB}/tree/main/docs) in the Aria repository, which remains the
single source of truth.

<Cards>
  <Card title="Management Control Plane" href="/docs/control-plane" />
  <Card title="Agent Runtime Architecture" href="/docs/agent-runtime-architecture" />
  <Card title="Channel Plugin ABI" href="/docs/channel-plugin-abi-v1" />
  <Card title="Steering" href="/docs/steering" />
</Cards>
`;
fs.writeFileSync(path.join(outDir, 'index.mdx'), landing);
sourceMap['index'] = 'docs';

// Navigation: group pages by documentation role (see docs/DOCUMENTATION_POLICY.md).
const top = pages.filter((p) => !p.slug.includes('/'));
const releases = pages.filter((p) => p.slug.startsWith('releases/'));
const byTitle = (a, b) => a.title.localeCompare(b.title);
const bucket = (role) => top.filter((p) => p.role === role).sort(byTitle);

const pageList = ['index'];
const groups = [
  ['---Guides & Specs---', top.filter((p) => !['in progress', 'historical', 'archived'].includes(p.role)).sort(byTitle)],
  ['---Active Plans---', bucket('in progress')],
  ['---History---', top.filter((p) => ['historical', 'archived'].includes(p.role)).sort(byTitle)],
];
for (const [sep, group] of groups) {
  if (group.length === 0) continue;
  pageList.push(sep, ...group.map((p) => p.slug));
}
if (releases.length > 0) pageList.push('releases');

fs.writeFileSync(
  path.join(outDir, 'meta.json'),
  JSON.stringify({ title: 'Aria Docs', pages: pageList }, null, 2) + '\n',
);

if (releases.length > 0) {
  const relPages = releases
    .map((p) => p.slug.split('/').pop())
    .sort()
    .reverse();
  fs.writeFileSync(
    path.join(outDir, 'releases', 'meta.json'),
    JSON.stringify({ title: 'Release Notes', pages: relPages }, null, 2) + '\n',
  );
}

fs.mkdirSync(generatedDir, { recursive: true });
fs.writeFileSync(
  path.join(generatedDir, 'source-map.json'),
  JSON.stringify(sourceMap, null, 2) + '\n',
);

console.log(`sync-docs: ${files.length} docs -> ${path.relative(siteDir, outDir)}`);
for (const w of warnings) console.warn(`  warn: ${w}`);
