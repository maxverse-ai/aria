/** An optional terminal protocol. Ordinary replies remain plain text. */
export type CooperativeReply =
  | { action: 'reply'; text: string }
  | { action: 'wait' }
  | { action: 'handoff'; recipient: string; text: string }
  | { action: 'invalid' };

export const COOPERATIVE_REPLY_INSTRUCTION =
  '多人协作时只完成自己当前的一步；轮流任务按用户指定顺序等待前一位的实际结果，不代替他人发言。' +
  '需等待时最终仅输出 <aria_reply>{"action":"wait"}</aria_reply>；' +
  '需交接时最终仅输出 <aria_reply>{"action":"handoff","recipient":"下一位的身份ID","text":"本步结果"}</aria_reply>，由宿主发布并寻址，勿另用工具重复发送。' +
  '不需交接则直接回答；达到用户的结束条件就停止交接。';

export function parseCooperativeReply(text: string): CooperativeReply {
  const value = text.trim();
  if (!value.startsWith('<aria_reply>')) return { action: 'reply', text };
  if (!value.endsWith('</aria_reply>') || value.length > 64_000) return { action: 'invalid' };
  try {
    const data: unknown = JSON.parse(value.slice(12, -13));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { action: 'invalid' };
    const d = data as Record<string, unknown>;
    if (d.action === 'wait' && Object.keys(d).length === 1) return { action: 'wait' };
    if (d.action === 'handoff' && Object.keys(d).length === 3 &&
      typeof d.recipient === 'string' && /^[\w:.-]{1,256}$/.test(d.recipient) &&
      typeof d.text === 'string' && d.text.trim()) {
      return { action: 'handoff', recipient: d.recipient, text: d.text };
    }
  } catch { /* Invalid terminal protocol must not leak into the conversation. */ }
  return { action: 'invalid' };
}
