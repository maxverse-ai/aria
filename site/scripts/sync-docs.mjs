// Generates site/content/docs/ and site/content/blog/ from ../docs so the
// repository's docs directory stays the single source of truth. Re-run on
// every dev/build via the chained `sync-docs` step in package.json scripts.
//
// Publishing rules (dynamic, driven by docs/DOCUMENTATION_POLICY.md):
//   - top-level docs publish only when their `> Status:` role is `current`
//     and the filename is not an internal class (ledger, plan, handoff,
//     implementation/phase/completion records, release-linux-*).
//   - `NAME.<locale>.md` is the localized variant of `NAME.md`
//     (e.g. STEERING.zh.md -> steering.zh.mdx).
//   - docs/releases/** and docs/blog/** become the /changelog collection.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(siteDir, '..');
const docsDir = path.join(repoRoot, 'docs');
const outDocsDir = path.join(siteDir, 'content', 'docs');
const outBlogDir = path.join(siteDir, 'content', 'blog');
const generatedDir = path.join(siteDir, 'lib', 'generated');
const GITHUB = 'https://github.com/maxverse-ai/aria';

// Non-default content locales. Keep in sync with site/lib/i18n.ts.
const LOCALES = ['zh'];
const DEFAULT_LOCALE = 'en';
const BLOG_DIRS = new Set(['releases', 'blog']);

// Sidebar sections, rendered as meta.json separators. The `slugs` arrays are
// the only hand-maintained ordering: a published doc not listed here falls
// into the final section through the "..." rest marker, which is why
// Internals — the engineering specifications — is the default home. Keep user
// guides in explicit sections; let specs stay unlisted.
const SECTIONS = [
  {
    en: 'Getting started',
    zh: '入门',
    slugs: ['what-is-aria', 'quickstart', 'install-and-upgrade'],
  },
  {
    en: 'Guides',
    zh: '使用指南',
    slugs: [
      'lark-channel',
      'wechat-kf-channel',
      'operate-the-bridge',
      'talk-to-your-agent',
      'scheduled-actions',
      'web-console',
      'worker-mode',
      'execution-spaces',
      'secrets-and-access',
      'troubleshooting',
    ],
  },
  {
    en: 'Reference',
    zh: '参考',
    slugs: ['cli-reference', 'plugins', 'channel-plugin-abi-v1'],
  },
  {
    en: 'Internals',
    zh: '内部设计与规范',
    rest: true,
  },
];

// Filename classes that DOCUMENTATION_POLICY.md reserves for internal or
// historical material. Matching files never reach the public site, even if
// their status header is wrong.
const INTERNAL_STEM = [
  /^bug-ledger$/i,
  /^release-linux-/i,
  /[-_](DELIVERY_PLAN|HANDOFF|IMPLEMENTATION|COMPLETION)$/i,
  /[-_]PHASE\d+$/i,
];

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

// "NAME.zh.md" -> { stem: "NAME", locale: "zh" }; "NAME.md" -> { stem, locale: null }
function splitLocale(fileName) {
  const base = fileName.replace(/\.md$/, '');
  const idx = base.lastIndexOf('.');
  if (idx > 0) {
    const candidate = base.slice(idx + 1);
    if (LOCALES.includes(candidate)) {
      return { stem: base.slice(0, idx), locale: candidate };
    }
  }
  return { stem: base, locale: null };
}

function isInternalStem(stem) {
  return INTERNAL_STEM.some((re) => re.test(stem));
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

function firstParagraph(body) {
  // Capture the whole paragraph, not just its first line: prose is
  // hard-wrapped, so a single-line match would cut sentences in half.
  const m = body.match(/^(?!#|>|\s*$)([^\n]+(?:\n(?!#|>|\s*$)[^\n]+)*)/m);
  if (!m) return null;
  return m[1]
    .replace(/\s*\n\s*/g, (match, offset, str) => {
      // CJK prose wraps without word spaces; joining with a space would
      // leave stray gaps inside Chinese text ("消息 寻址").
      const prev = str[offset - 1] ?? '';
      const next = str[offset + match.length] ?? '';
      return /[　-鿿＀-￯]/.test(prev + next) ? '' : ' ';
    })
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '');
}

// Cut page descriptions at a sentence boundary when possible so the text
// under the title, in search results, and in OG cards does not end
// mid-phrase. CJK sentence punctuation always counts; ASCII punctuation
// counts only when followed by whitespace or the end of the window.
// Otherwise fall back to a word-boundary cut with an ellipsis.
function truncateDescription(text, max = 140) {
  if (!text || text.length <= max) return text;
  const window = text.slice(0, max);
  let best = -1;
  for (const re of [/[。！？]/g, /[.!?](?=\s|$)/g]) {
    let m;
    while ((m = re.exec(window)) !== null) {
      if (m.index > best) best = m.index;
    }
  }
  if (best > max * 0.4) return text.slice(0, best + 1);
  return (
    window.replace(/\s\S*$/, '').replace(/[.,;:!?，、；：]+$/, '') + '…'
  );
}

// Fence languages that the bundled Shiki config cannot highlight.
const UNSUPPORTED_FENCE_LANGS = new Set(['caddyfile']);

// Rewritten once the publish sets below are known.
let publishedEn = new Set();
let publishedZh = new Set();

// Header metadata from DOCUMENTATION_POLICY.md: the `> Status:` blockquote
// (including its continuation lines) and the locale pointer lines
// (`> 中文版：…`, `> 本文是 … 的中文版`, `> English version: …`). These drive
// publishing and language switching, so they must not render as page content.
const STATUS_LINE = /^>\s*Status:/;
const LOCALE_POINTER = /^>\s*(中文版[:：]|本文是|English version[:：])/;
const QUOTE_LINE = /^>/;

function stripHeaderMeta(body) {
  const parts = body.split(/(^```[\s\S]*?^```\s*$)/m);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // fenced code: untouched
      const out = [];
      let inStatusBlock = false;
      for (const line of part.split(/\r?\n/)) {
        if (STATUS_LINE.test(line)) {
          inStatusBlock = true;
          continue;
        }
        if (inStatusBlock && QUOTE_LINE.test(line)) continue;
        inStatusBlock = false;
        if (LOCALE_POINTER.test(line)) continue;
        out.push(line);
      }
      return out.join('\n').replace(/\n{3,}/g, '\n\n');
    })
    .join('')
    .replace(/^\n+/, '');
}

function rewriteLinks(body, srcAbs, srcLocale, selfSlug, collection, warnings) {
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
          const top = relToDocs.split('/')[0];
          if (BLOG_DIRS.has(top)) {
            // Links into release notes / blog entries resolve to /changelog.
            const relNoExt = relToDocs.slice(top.length + 1).replace(/\.md$/, '');
            const relStem = path.join(
              path.dirname(relNoExt),
              splitLocale(path.basename(relNoExt)).stem,
            );
            const bSlug = slugPath(relStem.split(path.sep).join('/'));
            return `](/changelog/${bSlug}${frag ? `#${frag}` : ''})`;
          }
          const { stem, locale: tLocale } = splitLocale(path.basename(relToDocs));
          const tSlug = slugPath(
            path.join(path.dirname(relToDocs), stem).split(path.sep).join('/'),
          );
          const suffix = frag ? `#${frag}` : '';
          if (tLocale && tLocale !== DEFAULT_LOCALE) {
            // Explicit link to a localized file, e.g. STEERING.zh.md.
            if (publishedZh.has(tSlug)) return `](/${tLocale}/docs/${tSlug}${suffix})`;
            if (publishedEn.has(tSlug)) return `](/docs/${tSlug}${suffix})`;
          } else if (srcLocale === 'zh') {
            // A localized file referencing its own default-locale source
            // (e.g. STEERING.zh.md -> STEERING.md) means "the English
            // version", not a self-link.
            if (tSlug === selfSlug && publishedEn.has(tSlug))
              return `](/docs/${tSlug}${suffix})`;
            if (publishedZh.has(tSlug) || publishedEn.has(tSlug))
              return `](/zh/docs/${tSlug}${suffix})`;
          } else {
            if (publishedEn.has(tSlug)) return `](/docs/${tSlug}${suffix})`;
            if (publishedZh.has(tSlug)) return `](/zh/docs/${tSlug}${suffix})`;
          }
          // Unpublished doc: fall through to a GitHub link.
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

function renderFile(srcAbs, srcLocale, selfSlug, collection, warnings) {
  const raw = fs.readFileSync(srcAbs, 'utf8');
  let title = firstMatch(raw, /^#\s+(.+)$/m) ?? path.basename(srcAbs, '.md');
  title = title.replace(/^Archived:\s*/i, '');
  const statusLine = firstMatch(raw, /^>\s*Status:\s*(.+)$/m);
  const role = statusRole(statusLine);

  // Drop the first H1 — DocsTitle renders the frontmatter title instead —
  // and the policy header metadata (status, locale pointers), which is
  // build input, not page content.
  const body = stripHeaderMeta(raw.replace(/^#\s+.+\n+/, ''));
  const transformed = rewriteLinks(
    body,
    srcAbs,
    srcLocale,
    selfSlug,
    collection,
    warnings,
  );

  // Prefer the status detail ("current — <detail>") as the page description;
  // a bare "current" carries no information, so fall back to the lead
  // paragraph.
  const statusDetail =
    statusLine?.split(/\s+[—–-]\s+/).slice(1).join(' — ').trim() || null;
  const rawDescription = statusDetail ?? firstParagraph(transformed);
  const description = truncateDescription(rawDescription, 140);

  const frontmatter =
    [
      '---',
      `title: ${JSON.stringify(title)}`,
      description ? `description: ${JSON.stringify(description)}` : null,
      '---',
    ]
      .filter(Boolean)
      .join('\n') + '\n\n';

  return { title, role, statusLine, mdx: frontmatter + transformed };
}

const files = walk(docsDir);
const warnings = [];

// ---------- pass 1: classify + decide what gets published ----------
const docEntries = []; // { rel, stem, locale, slug, role, title, publish }
const blogEntries = []; // { rel, stem, locale, slug, title, sortKey, date }

function relSlug(rel) {
  // rel like "sub/dir/NAME[.<locale>].md" -> "sub/dir/name"
  const noExt = rel.replace(/\.md$/, '');
  const { stem } = splitLocale(path.basename(noExt));
  const dir = path.dirname(noExt);
  return slugPath(dir === '.' ? stem : `${dir}/${stem}`);
}

for (const rel of files) {
  const srcAbs = path.join(docsDir, rel);
  const raw = fs.readFileSync(srcAbs, 'utf8');
  const top = rel.includes('/') ? rel.split('/')[0] : null;
  const { stem, locale } = splitLocale(path.basename(rel));

  let title = firstMatch(raw, /^#\s+(.+)$/m) ?? stem;
  title = title.replace(/^Archived:\s*/i, '');
  const statusLine = firstMatch(raw, /^>\s*Status:\s*(.+)$/m);
  const role = statusRole(statusLine);

  if (top && BLOG_DIRS.has(top)) {
    // Blog slugs drop the collection dir: docs/releases/v0.4.0.md -> /changelog/v0-4-0.
    blogEntries.push({ rel, stem, locale, slug: relSlug(rel.slice(top.length + 1)), title });
    continue;
  }

  const slug = relSlug(rel);
  const archivedTitle = /^Archived:/i.test(firstMatch(raw, /^#\s+(.+)$/m) ?? '');
  const publish =
    role === 'current' && !archivedTitle && !isInternalStem(stem) && slug !== 'index';
  docEntries.push({ rel, stem, locale, slug, role, title, publish });
}

for (const e of docEntries) {
  if (!e.publish) continue;
  (e.locale === 'zh' ? publishedZh : publishedEn).add(e.slug);
}

// ---------- pass 2: emit ----------
fs.rmSync(outDocsDir, { recursive: true, force: true });
fs.rmSync(outBlogDir, { recursive: true, force: true });

// Last-commit time of the source Markdown, for the "Last updated" footer.
// The generated .mdx files are untracked, so fumadocs-mdx's own git
// lastModified cannot see the real history; resolve it from docs/ instead.
// When git is unavailable (release tarball builds) the map stays empty and
// the footer is simply not rendered.
function gitLastModified(rel) {
  try {
    return (
      execFileSync('git', ['log', '-1', '--format=%cI', '--', rel], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

const sourceMap = {}; // "<locale>:<slug>" or "<slug>" -> repo-relative source path
const lastmodMap = {}; // same keys as sourceMap -> ISO commit date
const publishedPages = []; // docEntries where publish

for (const e of docEntries) {
  if (!e.publish) continue;
  const { mdx, title } = renderFile(
    path.join(docsDir, e.rel),
    e.locale ?? DEFAULT_LOCALE,
    e.slug,
    'docs',
    warnings,
  );
  const outRel = e.locale ? `${e.slug}.${e.locale}.mdx` : `${e.slug}.mdx`;
  const outAbs = path.join(outDocsDir, outRel);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, mdx);
  publishedPages.push({ ...e, title });
  const key = e.locale ? `${e.locale}:${e.slug}` : e.slug;
  sourceMap[key] = `docs/${e.rel}`;
  const lm = gitLastModified(`docs/${e.rel}`);
  if (lm) lastmodMap[key] = lm;
  if (e.locale && !sourceMap[e.slug]) {
    sourceMap[e.slug] = `docs/${e.rel}`;
    if (lm && !lastmodMap[e.slug]) lastmodMap[e.slug] = lm;
  }
}

// Landing pages for /docs (per locale).
const landingEn = `---
title: Aria Documentation
description: A local-first control plane for coding agents — chat is the remote control, not the compute plane.
---

Aria turns a chat surface into the interaction surface for coding agents that
run on your own machine. These pages are generated from
[\`docs/\`](${GITHUB}/tree/main/docs) in the Aria repository, which remains the
single source of truth.

<Cards>
  <Card title="What is Aria" href="/docs/what-is-aria" />
  <Card title="Quickstart" href="/docs/quickstart" />
  <Card title="Install &amp; upgrade" href="/docs/install-and-upgrade" />
  <Card title="CLI reference" href="/docs/cli-reference" />
</Cards>
`;
const landingZh = `---
title: Aria 文档
description: 本地优先的编码智能体控制平面 —— 聊天是遥控器，而不是计算平面。
---

Aria 把聊天界面变成运行在你自己机器上的编码智能体的交互入口。这些页面由
Aria 仓库中的 [\`docs/\`](${GITHUB}/tree/main/docs) 生成，仓库仍是唯一事实来源。

<Cards>
  <Card title="Aria 是什么" href="/zh/docs/what-is-aria" />
  <Card title="快速上手" href="/zh/docs/quickstart" />
  <Card title="安装与升级" href="/zh/docs/install-and-upgrade" />
  <Card title="CLI 命令参考" href="/zh/docs/cli-reference" />
</Cards>
`;
fs.mkdirSync(outDocsDir, { recursive: true });
fs.writeFileSync(path.join(outDocsDir, 'index.mdx'), landingEn);
fs.writeFileSync(path.join(outDocsDir, 'index.zh.mdx'), landingZh);
sourceMap['index'] = 'docs';
sourceMap['zh:index'] = 'docs';

// Navigation: only published (current) docs, grouped into SECTIONS. A listed
// slug that was not published warns loudly — it usually means the doc was
// renamed or lost its `current` status and the map needs an edit.
const publishedSlugSet = new Set(publishedPages.filter((p) => !p.locale).map((p) => p.slug));
const sectionPages = (labelKey) => {
  const pages = ['index'];
  for (const section of SECTIONS) {
    pages.push(`---${section[labelKey]}---`);
    if (section.rest) {
      pages.push('...');
      continue;
    }
    for (const slug of section.slugs) {
      if (publishedSlugSet.has(slug)) pages.push(slug);
      else warnings.push(`section "${section.en}" lists unpublished slug "${slug}"`);
    }
  }
  return pages;
};
fs.writeFileSync(
  path.join(outDocsDir, 'meta.json'),
  JSON.stringify({ title: 'Aria Docs', pages: sectionPages('en') }, null, 2) + '\n',
);
// Localized meta inherits the same ordering; only the section labels differ.
fs.writeFileSync(
  path.join(outDocsDir, 'meta.zh.json'),
  JSON.stringify({ title: 'Aria 文档', pages: sectionPages('zh') }, null, 2) + '\n',
);

// ---------- blog ----------
function blogSortKey(stem) {
  const dateMatch = stem.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) return { date: dateMatch[0], key: Date.parse(dateMatch[0]) };
  const verMatch = stem.match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (verMatch)
    return {
      date: null,
      key:
        Number(verMatch[1]) * 1e6 +
        Number(verMatch[2]) * 1e3 +
        Number(verMatch[3] ?? 0),
    };
  return { date: null, key: 0 };
}

const blogIndex = []; // canonical (default-locale) entries, newest first
for (const e of blogEntries) {
  const { mdx, title } = renderFile(
    path.join(docsDir, e.rel),
    e.locale ?? DEFAULT_LOCALE,
    e.slug,
    'blog',
    warnings,
  );
  const outRel = e.locale ? `${e.slug}.${e.locale}.mdx` : `${e.slug}.mdx`;
  const outAbs = path.join(outBlogDir, outRel);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, mdx);
  const { date, key } = blogSortKey(e.stem);
  const slugPathArr = e.slug.split('/');
  const entry = { slug: slugPathArr, title, date, key, locale: e.locale ?? DEFAULT_LOCALE };
  blogIndex.push(entry);
  const blogKey = `blog:${e.locale ?? DEFAULT_LOCALE}:${e.slug}`;
  sourceMap[blogKey] = `docs/${e.rel}`;
  const lm = gitLastModified(`docs/${e.rel}`);
  if (lm) lastmodMap[blogKey] = lm;
  if (!e.locale) {
    sourceMap[`blog:${e.slug}`] = `docs/${e.rel}`;
    if (lm) lastmodMap[`blog:${e.slug}`] = lm;
  }
}

blogIndex.sort((a, b) => b.key - a.key || a.title.localeCompare(b.title));
const canonicalBlog = blogIndex
  .filter((e) => e.locale === DEFAULT_LOCALE)
  .map(({ slug, title, date }) => ({ slug, title, date }));

// Blog sidebar/navigation: newest first, same ordering as the index page.
if (canonicalBlog.length > 0) {
  fs.writeFileSync(
    path.join(outBlogDir, 'meta.json'),
    JSON.stringify(
      {
        title: 'Changelog',
        pages: canonicalBlog.map((e) => e.slug.join('/')),
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(outBlogDir, 'meta.zh.json'),
    JSON.stringify(
      {
        title: '更新日志',
        pages: canonicalBlog.map((e) => e.slug.join('/')),
      },
      null,
      2,
    ) + '\n',
  );
}

fs.mkdirSync(generatedDir, { recursive: true });
fs.writeFileSync(
  path.join(generatedDir, 'source-map.json'),
  JSON.stringify(sourceMap, null, 2) + '\n',
);
fs.writeFileSync(
  path.join(generatedDir, 'lastmod.json'),
  JSON.stringify(lastmodMap, null, 2) + '\n',
);
fs.writeFileSync(
  path.join(generatedDir, 'blog-index.json'),
  JSON.stringify(canonicalBlog, null, 2) + '\n',
);

const skipped = docEntries.filter((e) => !e.publish);
console.log(
  `sync-docs: ${publishedPages.length} docs -> ${path.relative(siteDir, outDocsDir)}, ` +
    `${blogIndex.length} blog entries -> ${path.relative(siteDir, outBlogDir)} ` +
    `(${skipped.length} internal docs withheld)`,
);
for (const w of warnings) console.warn(`  warn: ${w}`);
