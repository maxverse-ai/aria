import { log } from '../core/logger';
import { normalize, type NormalizeOptions, type NormalizedMessage, type RawMessageEvent } from '@larksuite/channel';

/** All Aria-owned message reads preserve mentions, independently of addressing. */
export function normalizeMessage(event: RawMessageEvent, options: Omit<NormalizeOptions, 'stripBotMentions'>) {
  return normalize(event, { ...options, stripBotMentions: false });
}

function rawMessage(message: NormalizedMessage): RawMessageEvent | undefined {
  const raw = message.raw as Partial<RawMessageEvent> | undefined;
  return raw?.message?.message_id === message.messageId && raw.sender?.sender_id
    && typeof raw.message.content === 'string' ? raw as RawMessageEvent : undefined;
}

/**
 * SDK 0.4.1 strips self mentions in its dispatcher. Re-render self-contained
 * text/post bodies from the attached event before projection or persistence.
 * Keep SDK identity, addressing, roster and resource metadata; do not refetch
 * cards or forwarded trees merely to render an ordinary incoming message.
 */
export async function preserveMessageMentions(message: NormalizedMessage): Promise<NormalizedMessage> {
  const raw = rawMessage(message);
  if (!raw || !message.mentions.some(mention => mention.isBot)
    || !['text', 'post'].includes(raw.message.message_type)) return message;
  try {
    const body = JSON.parse(raw.message.content);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || (raw.message.message_type === 'text' && typeof body.text !== 'string')) return message;
    const rendered = await normalizeMessage(raw, { botIdentity: { openId: '', name: '' } });
    return { ...message, content: rendered.content };
  } catch {
    log.warn('intake', 'mention-normalization-failed', { messageId: message.messageId });
    return message;
  }
}

/** A command projection never modifies the message passed to the model/history. */
export async function messageCommandText(message: NormalizedMessage): Promise<string> {
  try { return await projectCommandText(message); } catch { return message.content.trim(); }
}

async function projectCommandText(message: NormalizedMessage): Promise<string> {
  const raw = rawMessage(message);
  const self = message.mentions.filter(mention => mention.isBot);
  if (!raw || self.length === 0) return message.content.trim();
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw.message.content); } catch { return message.content.trim(); }
  if (!body || typeof body !== 'object') return message.content.trim();
  let removed = false;
  if (raw.message.message_type === 'text' && typeof body.text === 'string') {
    let text = body.text.trimStart();
    for (;;) {
      const mention = self.find(item => item.key && text.startsWith(item.key)
        && !/[\w]/.test(text[item.key.length] ?? ''));
      if (!mention) break;
      text = text.slice(mention.key.length).trimStart(); removed = true;
    }
    // Trailing self mentions are invocation syntax only for slash commands.
    if (text.startsWith('/')) {
      text = text.trimEnd();
      for (;;) {
        const mention = self.find(item => item.key && text.endsWith(item.key)
          && /\s/.test(text[text.length - item.key.length - 1] ?? ''));
        if (!mention) break;
        text = text.slice(0, -mention.key.length).trimEnd(); removed = true;
      }
    }
    if (!removed) return message.content.trim();
    if (!text.trim()) return '';
    body.text = text;
  } else if (raw.message.message_type === 'post') {
    // Match the SDK's locale selection. Only actual leading `at` elements may
    // be consumed; text that happens to spell @name is never a mention.
    const locale = 'title' in body || 'content' in body ? body
      : (body.zh_cn ?? body.en_us ?? body.ja_jp ?? Object.values(body)[0]) as Record<string, unknown> | undefined;
    if (!locale || typeof locale !== 'object' || locale.title) return message.content.trim();
    const paragraphs = Array.isArray(locale.content_v2) && locale.content_v2.length ? locale.content_v2 : locale.content;
    if (!Array.isArray(paragraphs)) return message.content.trim();
    let prefix = true;
    for (const row of paragraphs) {
      if (!Array.isArray(row)) { prefix = false; break; }
      while (prefix && row.length) {
        const node = row[0];
        if (node?.tag === 'text' && typeof node.text === 'string' && !node.text.trim()) { row.shift(); continue; }
        if (node?.tag === 'at' && self.some(item => node.user_id === item.openId || node.user_id === item.key)) {
          row.shift(); removed = true; continue;
        }
        prefix = false;
      }
      if (!prefix) break;
    }
    const firstNode = paragraphs.flat().find(node => !(node?.tag === 'text' && !node.text?.trim()));
    if (firstNode?.tag === 'text' && firstNode.text.trimStart().startsWith('/')) {
      let suffix = true;
      for (const row of [...paragraphs].reverse()) {
        if (!Array.isArray(row)) break;
        while (suffix && row.length) {
          const node = row[row.length - 1];
          if (node?.tag === 'text' && typeof node.text === 'string' && !node.text.trim()) { row.pop(); continue; }
          if (node?.tag === 'at' && self.some(item => node.user_id === item.openId || node.user_id === item.key)) {
            row.pop(); removed = true; continue;
          }
          suffix = false;
        }
        if (!suffix) break;
      }
    }
    if (!removed) return message.content.trim();
    if (paragraphs.every(row => Array.isArray(row) && row.length === 0)) return '';
  } else return message.content.trim();
  const projected = await normalizeMessage({ ...raw, message: { ...raw.message, content: JSON.stringify(body) } },
    { botIdentity: { openId: '', name: '' } });
  return projected.content.trim();
}

/** Classify an actual self-only ping without discarding its canonical body. */
export function isSelfMentionPing(message: NormalizedMessage): boolean {
  if (message.resources.length) return false;
  const raw = rawMessage(message);
  const self = message.mentions.filter(mention => mention.isBot);
  if (!raw || !self.length) return false;
  try {
    const body = JSON.parse(raw.message.content);
    if (raw.message.message_type === 'text' && typeof body.text === 'string') {
      let text = body.text.trim();
      let found = false;
      while (text) {
        const mention = self.find(item => item.key && text.startsWith(item.key)
          && !/[\w]/.test(text[item.key.length] ?? ''));
        if (!mention) return false;
        found = true; text = text.slice(mention.key.length).trimStart();
      }
      return found;
    }
    if (raw.message.message_type !== 'post') return false;
    const locale = 'title' in body || 'content' in body ? body
      : body.zh_cn ?? body.en_us ?? body.ja_jp ?? Object.values(body)[0];
    if (!locale || locale.title) return false;
    const rows = Array.isArray(locale.content_v2) && locale.content_v2.length ? locale.content_v2 : locale.content;
    if (!Array.isArray(rows) || !rows.every(Array.isArray)) return false;
    let found = false;
    const onlySelf = rows.flat().every(node => {
      if (node?.tag === 'text' && typeof node.text === 'string' && !node.text.trim()) return true;
      if (node?.tag === 'at' && self.some(item => node.user_id === item.openId || node.user_id === item.key)) {
        found = true; return true;
      }
      return false;
    });
    return found && onlySelf;
  } catch { return false; }
}
