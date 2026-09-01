import { Lexer, type Token, type Tokens } from 'marked';

export interface WechatKfMarkdownImage {
  raw: string;
  text: string;
  href: string;
}

/**
 * Render Markdown-shaped agent output for WeChat KF's text-only send_msg API.
 *
 * This is deliberately presentation-only: it never fetches links, evaluates
 * HTML, or mutates the agent/session copy of the answer.
 */
export function renderWechatKfPlainText(input: string): string {
  if (!input) return '';
  const tokens = Lexer.lex(input.replace(/\r\n?/g, '\n'), {
    async: false,
    breaks: false,
    gfm: true,
  });
  return normalizeOutput(renderBlocks(tokens));
}

/** Extract syntax only. Callers remain responsible for authorizing every href. */
export function extractWechatKfMarkdownImages(input: string): WechatKfMarkdownImage[] {
  if (!input) return [];
  const tokens = Lexer.lex(input.replace(/\r\n?/g, '\n'), {
    async: false,
    breaks: false,
    gfm: true,
  });
  const images: WechatKfMarkdownImage[] = [];
  collectImages(tokens, images);
  return images;
}

function renderBlocks(tokens: readonly Token[], depth = 0): string {
  const blocks: string[] = [];
  for (const token of tokens) {
    const rendered = renderBlock(token, depth);
    if (rendered.trim()) blocks.push(rendered);
  }
  return blocks.join('\n\n');
}

function renderBlock(token: Token, depth: number): string {
  switch (token.type) {
    case 'space':
    case 'hr':
    case 'def':
      return '';
    case 'heading':
    case 'paragraph':
      return renderInline((token as Tokens.Heading | Tokens.Paragraph).tokens);
    case 'text': {
      const text = token as Tokens.Text;
      return text.tokens ? renderInline(text.tokens) : decodeHtmlEntities(text.text);
    }
    case 'checkbox':
      return (token as Tokens.Checkbox).checked ? '☑ ' : '☐ ';
    case 'code':
      return decodeHtmlEntities((token as Tokens.Code).text);
    case 'blockquote':
      return renderBlocks((token as Tokens.Blockquote).tokens, depth);
    case 'list':
      return renderList(token as Tokens.List, depth);
    case 'table':
      return renderTable(token as Tokens.Table);
    case 'html':
      return visibleHtmlText((token as Tokens.HTML).text);
    default:
      return renderUnknownToken(token);
  }
}

function renderList(list: Tokens.List, depth: number): string {
  const start = typeof list.start === 'number' ? list.start : 1;
  return list.items.map((item, index) => {
    const indent = '  '.repeat(depth);
    const continuation = `${indent}  `;
    const marker = list.ordered ? `${start + index}.` : '•';
    const bodyParts: string[] = [];
    const nestedLists: string[] = [];
    const taskPrefix = item.task ? (item.checked ? '☑ ' : '☐ ') : '';

    for (const token of item.tokens) {
      if (token.type === 'checkbox') continue;
      if (token.type === 'list') {
        nestedLists.push(renderList(token as Tokens.List, depth + 1));
        continue;
      }
      const rendered = renderBlock(token, depth).trim();
      if (rendered) bodyParts.push(rendered);
    }

    const bodyLines = bodyParts.join('\n').split('\n');
    const firstLine = `${taskPrefix}${bodyLines.shift() ?? ''}`;
    const lines = [`${indent}${marker}${firstLine ? ` ${firstLine}` : ''}`];
    lines.push(...bodyLines.map((line) => `${continuation}${line}`));
    if (nestedLists.length > 0) lines.push(...nestedLists);
    return lines.join('\n');
  }).join('\n');
}

function renderTable(table: Tokens.Table): string {
  return [table.header, ...table.rows]
    .map((row) => row
      .map((cell) => renderInline(cell.tokens).replace(/\s*\n\s*/g, ' ').trim())
      .join(' ｜ '))
    .filter((row) => row.length > 0)
    .join('\n');
}

function renderInline(tokens: readonly Token[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case 'text': {
        const text = token as Tokens.Text;
        return text.tokens ? renderInline(text.tokens) : decodeHtmlEntities(text.text);
      }
      case 'escape':
        return decodeHtmlEntities((token as Tokens.Escape).text);
      case 'strong':
      case 'em':
      case 'del':
        return renderInline((token as Tokens.Strong | Tokens.Em | Tokens.Del).tokens);
      case 'codespan':
        return decodeHtmlEntities((token as Tokens.Codespan).text);
      case 'br':
        return '\n';
      case 'checkbox':
        return (token as Tokens.Checkbox).checked ? '☑ ' : '☐ ';
      case 'link':
        return renderLink(token as Tokens.Link);
      case 'image':
        return renderImage(token as Tokens.Image);
      case 'html':
        return visibleHtmlText((token as Tokens.HTML | Tokens.Tag).text);
      default:
        return renderUnknownToken(token);
    }
  }).join('');
}

function renderLink(link: Tokens.Link): string {
  const label = normalizeInline(renderInline(link.tokens));
  const href = decodeHtmlEntities(link.href).trim();
  if (!href || label === href) return label || href;
  return label ? `${label}：${href}` : href;
}

function renderImage(image: Tokens.Image): string {
  const label = normalizeInline(renderInline(image.tokens) || image.text);
  const href = decodeHtmlEntities(image.href).trim();
  if (isLocalResourceReference(href)) return label ? `图片：${label}` : '图片';
  if (label && href) return `图片：${label}（${href}）`;
  if (label) return `图片：${label}`;
  return href ? `图片：${href}` : '图片';
}

function collectImages(tokens: readonly Token[], output: WechatKfMarkdownImage[]): void {
  for (const token of tokens) {
    if (token.type === 'image') {
      const image = token as Tokens.Image;
      output.push({
        raw: image.raw,
        text: normalizeInline(renderInline(image.tokens) || image.text),
        href: decodeHtmlEntities(image.href).trim(),
      });
      continue;
    }
    if (token.type === 'list') {
      for (const item of (token as Tokens.List).items) collectImages(item.tokens, output);
      continue;
    }
    if (token.type === 'table') {
      const table = token as Tokens.Table;
      for (const cell of [...table.header, ...table.rows.flat()]) collectImages(cell.tokens, output);
      continue;
    }
    const nested = (token as Tokens.Generic).tokens;
    if (nested) collectImages(nested, output);
  }
}

function isLocalResourceReference(href: string): boolean {
  return href.startsWith('/')
    || href.startsWith('file:')
    || href.startsWith('kb-asset:')
    || /^[A-Za-z]:[\\/]/.test(href);
}

function renderUnknownToken(token: Token): string {
  const generic = token as Tokens.Generic & { text?: unknown };
  if (generic.tokens) return renderInline(generic.tokens);
  return typeof generic.text === 'string'
    ? visibleHtmlText(generic.text)
    : '';
}

function visibleHtmlText(input: string): string {
  return decodeHtmlEntities(input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ''));
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (
    entity,
    decimal: string | undefined,
    hexadecimal: string | undefined,
    named: string | undefined,
  ) => {
    if (decimal) return safeCodePoint(Number.parseInt(decimal, 10), entity);
    if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16), entity);
    switch (named?.toLowerCase()) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default: return entity;
    }
  });
}

function safeCodePoint(value: number, fallback: string): string {
  try {
    return Number.isInteger(value) ? String.fromCodePoint(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeInline(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function normalizeOutput(input: string): string {
  return input
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
