/**
 * Loaded by DSH's public Cordis --patch extension point, before headless-runner.
 * This isolated module has no package dependencies. Only selected session events
 * cross fd 3; provider reasoning and private session headers never cross it.
 */
export const DSH_PROGRESS_PLUGIN = String.raw`
import { writeSync } from 'node:fs';
export const name = 'aria-dsh-progress';
export function apply(ctx) {
  const send = (event) => {
    const data = Buffer.from(JSON.stringify(event) + '\n');
    let offset = 0;
    while (offset < data.length) offset += writeSync(3, data, offset, data.length - offset);
  };
  const clip = (s) => String(s ?? '').slice(0, 16000);
  let owner;
  ctx.on('session/event', (session, event) => {
    if (owner === undefined && event.type === 'turn/start' && !session.header.parentSession) {
      owner = session.id;
      send({type: 'system', sessionId: String(owner)});
    }
    if (session.id !== owner) return;
    const d = event.data;
    if (event.type === 'step/start') {
      send({type: 'text', delta: 'DSH 正在执行第 ' + (d.step + 1) + ' 轮处理。'});
    } else if (event.type === 'tool/call') {
      let input;
      try { input = JSON.parse(d.arguments); } catch { input = clip(d.arguments); }
      if (JSON.stringify(input)?.length > 16000) input = clip(d.arguments);
      send({type: 'tool_use', id: String(d.callId), name: d.name, input});
    } else if (event.type === 'tool/result') {
      const block = d.message.content[0];
      if (block?.type !== 'tool-result') return;
      const output = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      send({type: 'tool_result', id: String(block.toolCallId), output: clip(output), isError: block.isError === true});
    }
  });
  send({type: 'ready', version: 1});
  ctx.provide('ariaDshProgress', true);
}
`;
