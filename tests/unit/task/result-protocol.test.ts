import { describe, expect, it } from 'vitest';
import { parseTaskResult } from '../../../src/task/result-protocol';

describe('task result protocol', () => {
  it('keeps ordinary prose separate and parses exact structured results', () => {
    expect(parseTaskResult('普通说明')).toEqual({ kind: 'reply', text: '普通说明' });
    expect(parseTaskResult('<aria_task>{"taskId":"task-1","baseVersion":2,"action":"update","nextTarget":"alice","summary":"ready"}</aria_task>'))
      .toEqual({ kind: 'result', result: {
        taskId: 'task-1', baseVersion: 2, action: 'update', nextTarget: 'alice', summary: 'ready',
      } });
    expect(parseTaskResult('<aria_task>{"taskId":"task-1","baseVersion":4,"action":"review","status":"approved"}</aria_task>'))
      .toEqual({ kind: 'result', result: { taskId: 'task-1', baseVersion: 4, action: 'review', status: 'approved' } });
  });

  it.each([
    '<aria_task>{"taskId":"task-1","baseVersion":2,"action":"update"}</aria_task>',
    '<aria_task>{"taskId":"task-1","baseVersion":2,"action":"review","status":"revise"}</aria_task>',
    '<aria_task>{"taskId":"task-1","baseVersion":2,"action":"wait","summary":"later"}</aria_task>',
    '<aria_task>{"taskId":"task-1","baseVersion":2,"action":"review","status":"approved","extra":true}</aria_task>',
  ])('rejects unsafe or incomplete control payloads: %s', (text) => {
    expect(parseTaskResult(text)).toEqual({ kind: 'invalid' });
  });
});
