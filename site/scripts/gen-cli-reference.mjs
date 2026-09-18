// Generates docs/CLI_REFERENCE.md and docs/CLI_REFERENCE.zh.md from the
// Commander declarations in src/cli/index.ts, so the published CLI reference
// can never drift from the supported command surface.
//
//   node site/scripts/gen-cli-reference.mjs         # regenerate both files
//   node site/scripts/gen-cli-reference.mjs --check # fail if files are stale
//
// The parser is deliberately narrow: it understands the declaration style used
// in src/cli/index.ts (`<subject>\n  .command('name')`, `const <v> =
// <parent>.command('name')`, and `for (... of [...])` loop-expanded commands).
// Loop-expanded commands (inbox check/pull, space status/rollback) have their
// text supplied by OVERRIDES below because their descriptions are computed.
// If the CLI file adopts a new declaration style, update the parser — never
// hand-edit the generated documents.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(siteDir, '..');
const cliSourcePath = path.join(repoRoot, 'src', 'cli', 'index.ts');
const docsDir = path.join(repoRoot, 'docs');

// Loop-expanded commands whose text the source computes (a ternary) or omits.
// Values are copied verbatim from the corresponding commander calls where they
// exist; `space status` / `space rollback` carry no description in the CLI, so
// the doc text is defined here.
const OVERRIDES = {
  'inbox check': {
    description: 'Report the unread steering count for this scope',
    options: [
      ['--scope <scope>', 'conversation scope (defaults to ARIA_INBOX_SCOPE)'],
      ['--dir <path>', 'mailbox directory (defaults to the profile inbox layout)'],
      ['--json', 'print machine-readable JSON'],
    ],
  },
  'inbox pull': {
    description: 'Print every unread steering body and mark it pulled',
    options: [
      ['--scope <scope>', 'conversation scope (defaults to ARIA_INBOX_SCOPE)'],
      ['--dir <path>', 'mailbox directory (defaults to the profile inbox layout)'],
      ['--json', 'print machine-readable JSON'],
    ],
  },
  'space status': {
    description: 'Show execution-space status, retained preparations, and legacy inventory',
    options: [
      ['--profile <name>', 'profile name'],
      ['--json', 'print machine-readable metadata'],
    ],
  },
  'space rollback': {
    description: 'Roll back the active execution-space preparation',
    options: [
      ['--profile <name>', 'profile name'],
      ['--json', 'print machine-readable metadata'],
    ],
  },
};

function parseCli(source) {
  const lines = source.split('\n');
  const varPath = { program: '' }; // commander variable -> full command path
  const commands = []; // { path, parent, depth, name, description, options }
  const groups = new Map(); // group path -> description
  let current = null;

  const joinPath = (parent, name) => (parent ? `${parent} ${name}` : name);
  const addCommand = (fullPath, parentPath, nameLiteral) => {
    const entry = {
      path: fullPath,
      parent: parentPath,
      depth: parentPath ? parentPath.split(' ').length + 1 : 1,
      name: nameLiteral ?? fullPath,
      description: '',
      options: [],
    };
    commands.push(entry);
    return entry;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // `for (const action of ['a', 'b'] as const) {` — loop-expanded commands.
    const loop = line.match(/^for \(const \w+ of \[([^\]]+)\] as const\)/);
    if (loop) {
      const names = loop[1].split(',').map((s) => s.trim().replace(/'/g, ''));
      // Find the `<v>.command(action)` subject inside the loop body, which ends
      // at a column-0 `}`.
      let subject = null;
      let j = i + 1;
      for (; j < lines.length && !/^}/.test(lines[j]); j++) {
        const subj = lines[j].match(/^ {2}(\w+)$/);
        if (subj && varPath[subj[1]] !== undefined) subject = subj[1];
        const inline = lines[j].match(/(\w+)\.command\(\w+\)/);
        if (inline && varPath[inline[1]] !== undefined) subject = inline[1];
      }
      if (!subject) throw new Error(`gen-cli-reference: loop at line ${i + 1} has no command subject`);
      for (const name of names) {
        const p = joinPath(varPath[subject], name);
        const override = OVERRIDES[p];
        if (!override) throw new Error(`gen-cli-reference: loop-expanded ${p} needs an OVERRIDES entry`);
        const entry = addCommand(p, varPath[subject], name);
        entry.description = override.description;
        entry.options = override.options;
      }
      i = j; // skip the loop body; OVERRIDES supplies the text
      current = null;
      continue;
    }

    // `const <v> = <parent>` optionally followed by `  .command('name')`.
    let m = line.match(/^const (\w+) = (\w+)$/);
    if (m && varPath[m[2]] !== undefined) {
      const next = lines[i + 1]?.match(/^ {2}\.command\('([^']+)'\)/);
      if (next) {
        const p = joinPath(varPath[m[2]], next[1]);
        varPath[m[1]] = p;
        groups.set(p, '');
        current = addCommand(p, varPath[m[2]], next[1]);
        i += 1;
        continue;
      }
    }
    // `const <v> = <parent>.command('name')` on one line.
    m = line.match(/^const (\w+) = (\w+)\.command\('([^']+)'\)/);
    if (m && varPath[m[2]] !== undefined) {
      const p = joinPath(varPath[m[2]], m[3]);
      varPath[m[1]] = p;
      groups.set(p, '');
      current = addCommand(p, varPath[m[2]], m[3]);
    } else {
      // `<subject>` alone on a line, followed by `  .command('name')`.
      m = line.match(/^(\w+)$/);
      if (m && varPath[m[1]] !== undefined) {
        const next = lines[i + 1]?.match(/^ {2}\.command\('([^']+)'\)/);
        if (next) {
          current = addCommand(joinPath(varPath[m[1]], next[1]), varPath[m[1]], next[1]);
          i += 1;
          continue;
        }
      }

      // `<subject>.command('name')` on one line (e.g. `space.command('prepare ...')`).
      m = line.match(/^(\w+)\.command\('([^']+)'\)/);
      if (m && varPath[m[1]] !== undefined) {
        current = addCommand(joinPath(varPath[m[1]], m[2]), varPath[m[1]], m[2]);
      }
    }

    if (!current) continue;

    // `.description`/`.option` may follow `.command(...)` on the same line, and
    // a line can chain several `.option(...)` calls.
    m = line.match(/\.description\('((?:[^'\\]|\\.)*)'/);
    if (m) {
      const desc = m[1].replace(/\\'/g, "'");
      if (groups.has(current.path)) groups.set(current.path, desc);
      current.description = desc;
    }
    if (!groups.has(current.path)) {
      for (const o of line.matchAll(/\.(requiredOption|option)\('([^']+)',\s*'((?:[^'\\]|\\.)*)'(?:,\s*'([^']*)')?\)/g)) {
        const flags = o[1] === 'requiredOption' ? `${o[2]} *(required)*` : o[2];
        const desc = o[3].replace(/\\'/g, "'");
        const def = o[4];
        current.options.push([flags, def !== undefined ? `${desc} (default: \`${def}\`)` : desc]);
      }
    }
  }

  // Assemble document order: each group heading, then its direct children
  // (recursively, so `trigger grant` nests under `trigger`).
  const byParent = new Map();
  for (const c of commands) {
    if (!byParent.has(c.parent)) byParent.set(c.parent, []);
    byParent.get(c.parent).push(c);
  }
  const ordered = [];
  const emit = (parent) => {
    for (const c of byParent.get(parent) ?? []) {
      ordered.push(c);
      if (groups.has(c.path)) emit(c.path);
    }
  };
  emit('');
  // Groups that are also commands (none today) would need explicit emit; all
  // declared commands must appear exactly once.
  if (ordered.length !== commands.length) {
    const missing = commands.filter((c) => !ordered.includes(c)).map((c) => c.path);
    throw new Error(`gen-cli-reference: unreachable commands: ${missing.join(', ')}`);
  }
  return { groups, commands: ordered };
}

function headingFor(depth) {
  return '#'.repeat(Math.min(depth + 1, 6));
}

function render(commands, groups, locale) {
  const zh = locale === 'zh';
  const lines = [];
  lines.push(zh ? '# CLI 命令参考' : '# CLI reference');
  lines.push('');
  lines.push(
    zh
      ? '> Status: current — 由 `site/scripts/gen-cli-reference.mjs` 依据 `src/cli/index.ts` 自动生成；修改 CLI 后运行 `node site/scripts/gen-cli-reference.mjs` 重新生成。请勿手工编辑。'
      : '> Status: current — auto-derived from `src/cli/index.ts` by `site/scripts/gen-cli-reference.mjs`; run `node site/scripts/gen-cli-reference.mjs` after changing the CLI surface. Do not hand-edit.',
  );
  lines.push('');
  lines.push(
    zh
      ? '> English version: [CLI_REFERENCE.md](CLI_REFERENCE.md)'
      : '> 中文版：[CLI_REFERENCE.zh.md](CLI_REFERENCE.zh.md)',
  );
  lines.push('');
  lines.push(
    zh
      ? '以下每个命令都与 `src/cli/index.ts` 中的 Commander 声明逐一对应。`aria <command> --help` 是权威用法说明；命令与选项描述保留英文原文以便与帮助输出对照。'
      : 'Every command below mirrors a Commander declaration in `src/cli/index.ts`. `aria <command> --help` is the authoritative usage surface.',
  );
  lines.push('');
  lines.push(zh ? '## 全局' : '## Global');
  lines.push('');
  lines.push(zh ? '- `aria --version`（`-v`）— 打印已安装版本。' : '- `aria --version` (`-v`) — print the installed version.');
  lines.push(zh ? '- `aria <command> --help` — 打印任意命令的用法。' : '- `aria <command> --help` — print usage for any command.');
  lines.push(zh ? '- 标记 `--json` 的读取类命令输出机器可读 JSON。' : '- Read commands marked `--json` print machine-readable JSON.');
  lines.push('');
  for (const c of commands) {
    lines.push(`${headingFor(c.depth)} \`aria ${c.path}\``);
    lines.push('');
    if (c.description) lines.push(c.description, '');
    if (c.options.length > 0) {
      lines.push(zh ? '| 选项 | 说明 |' : '| Option | Description |');
      lines.push('| --- | --- |');
      for (const [flags, desc] of c.options) lines.push(`| \`${flags}\` | ${desc} |`);
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function main() {
  const check = process.argv.includes('--check');
  const source = fs.readFileSync(cliSourcePath, 'utf8');
  const { groups, commands } = parseCli(source);
  const outputs = [
    ['CLI_REFERENCE.md', render(commands, groups, 'en')],
    ['CLI_REFERENCE.zh.md', render(commands, groups, 'zh')],
  ];
  let stale = false;
  for (const [name, text] of outputs) {
    const target = path.join(docsDir, name);
    const content = text.endsWith('\n') ? text : `${text}\n`;
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (check) {
      if (existing !== content) {
        console.error(`gen-cli-reference: ${name} is stale — run node site/scripts/gen-cli-reference.mjs`);
        stale = true;
      }
    } else if (existing !== content) {
      fs.writeFileSync(target, content);
      console.log(`gen-cli-reference: wrote docs/${name}`);
    }
  }
  if (check && stale) process.exit(1);
  if (check && !stale) console.log('gen-cli-reference: docs are up to date');
}

main();
