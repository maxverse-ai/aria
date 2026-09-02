import { Lexer, type Token, type Tokens } from 'marked';

export interface WechatKfMarkdownImage {
  raw: string;
  text: string;
  href: string;
}

export interface WechatKfPlainTextRenderOptions {
  imageLabel?: string;
}

/**
 * Render Markdown-shaped agent output for WeChat KF's text-only send_msg API.
 *
 * This is deliberately presentation-only: it never fetches links, evaluates
 * HTML, or mutates the agent/session copy of the answer.
 */
export function renderWechatKfPlainText(
  input: string,
  options: Readonly<WechatKfPlainTextRenderOptions> = {},
): string {
  if (!input) return '';
  const tokens = Lexer.lex(input.replace(/\r\n?/g, '\n'), {
    async: false,
    breaks: false,
    gfm: true,
  });
  return normalizeOutput(renderBlocks(tokens, 0, options.imageLabel ?? '图片'));
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

function renderBlocks(tokens: readonly Token[], depth = 0, imageLabel = '图片'): string {
  const blocks: string[] = [];
  for (const token of tokens) {
    const rendered = renderBlock(token, depth, imageLabel);
    if (rendered.trim()) blocks.push(rendered);
  }
  return blocks.join('\n\n');
}

function renderBlock(token: Token, depth: number, imageLabel: string): string {
  switch (token.type) {
    case 'space':
    case 'hr':
    case 'def':
      return '';
    case 'heading':
    case 'paragraph':
      return renderInline((token as Tokens.Heading | Tokens.Paragraph).tokens, imageLabel);
    case 'text': {
      const text = token as Tokens.Text;
      return text.tokens ? renderInline(text.tokens, imageLabel) : decodeHtmlEntities(text.text);
    }
    case 'checkbox':
      return (token as Tokens.Checkbox).checked ? '☑ ' : '☐ ';
    case 'code':
      return decodeHtmlEntities((token as Tokens.Code).text);
    case 'blockquote':
      return renderBlocks((token as Tokens.Blockquote).tokens, depth, imageLabel);
    case 'list':
      return renderList(token as Tokens.List, depth, imageLabel);
    case 'table':
      return renderTable(token as Tokens.Table, imageLabel);
    case 'html':
      return visibleHtmlText((token as Tokens.HTML).text);
    default:
      return renderUnknownToken(token, imageLabel);
  }
}

function renderList(list: Tokens.List, depth: number, imageLabel: string): string {
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
        nestedLists.push(renderList(token as Tokens.List, depth + 1, imageLabel));
        continue;
      }
      const rendered = renderBlock(token, depth, imageLabel).trim();
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

function renderTable(table: Tokens.Table, imageLabel: string): string {
  return [table.header, ...table.rows]
    .map((row) => row
      .map((cell) => renderInline(cell.tokens, imageLabel).replace(/\s*\n\s*/g, ' ').trim())
      .join(' ｜ '))
    .filter((row) => row.length > 0)
    .join('\n');
}

function renderInline(tokens: readonly Token[], imageLabel = '图片'): string {
  return tokens.map((token) => {
    switch (token.type) {
      case 'text': {
        const text = token as Tokens.Text;
        return text.tokens ? renderInline(text.tokens, imageLabel) : decodeHtmlEntities(text.text);
      }
      case 'escape':
        return decodeHtmlEntities((token as Tokens.Escape).text);
      case 'strong':
      case 'em':
      case 'del':
        return renderInline((token as Tokens.Strong | Tokens.Em | Tokens.Del).tokens, imageLabel);
      case 'codespan':
        return decodeHtmlEntities((token as Tokens.Codespan).text);
      case 'br':
        return '\n';
      case 'checkbox':
        return (token as Tokens.Checkbox).checked ? '☑ ' : '☐ ';
      case 'link':
        return renderLink(token as Tokens.Link, imageLabel);
      case 'image':
        return renderImage(token as Tokens.Image, imageLabel);
      case 'html':
        return visibleHtmlText((token as Tokens.HTML | Tokens.Tag).text);
      default:
        return renderUnknownToken(token, imageLabel);
    }
  }).join('');
}

function renderLink(link: Tokens.Link, imageLabel: string): string {
  const label = normalizeInline(renderInline(link.tokens, imageLabel));
  const href = decodeHtmlEntities(link.href).trim();
  if (!href || label === href) return label || href;
  return label ? `${label}：${href}` : href;
}

function renderImage(image: Tokens.Image, imageLabel: string): string {
  const label = normalizeInline(renderInline(image.tokens, imageLabel) || image.text);
  const href = decodeHtmlEntities(image.href).trim();
  if (isLocalResourceReference(href)) return label ? `${imageLabel}：${label}` : imageLabel;
  if (label && href) return `${imageLabel}：${label}（${href}）`;
  if (label) return `${imageLabel}：${label}`;
  return href ? `${imageLabel}：${href}` : imageLabel;
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

function renderUnknownToken(token: Token, imageLabel = '图片'): string {
  const generic = token as Tokens.Generic & { text?: unknown };
  if (generic.tokens) return renderInline(generic.tokens, imageLabel);
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
