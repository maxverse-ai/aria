import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CARD_ACTION_MODES,
  executeCardAction,
  waitForCardActions,
} from '../../../src/card/action-executor.js';

describe('Card Action Executor', () => {
  it('acknowledges background work before the task completes', async () => {
    let finish!: () => void;
    let completed = false;
    const task = vi.fn(
      () => new Promise<void>((resolve) => {
        finish = () => {
          completed = true;
          resolve();
        };
      }),
    );

    await expect(
      executeCardAction({ action: 'status', key: 'chat:card-background', task }),
    ).resolves.toBeUndefined();
    expect(completed).toBe(false);

    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    finish();
    await waitForCardActions();
  });

  it('serializes background clicks for the same carrier card', async () => {
    let finishFirst!: () => void;
    const order: string[] = [];
    const first = () =>
      new Promise<void>((resolve) => {
        order.push('first-start');
        finishFirst = () => {
          order.push('first-end');
          resolve();
        };
      });
    const second = async () => {
      order.push('second');
    };

    await executeCardAction({ action: 'models.refresh', key: 'chat:card-serial', task: first });
    await executeCardAction({ action: 'models.use', key: 'chat:card-serial', task: second });
    await vi.waitFor(() => expect(order).toEqual(['first-start']));
    finishFirst();
    await waitForCardActions();

    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('drops stale Agent-card clicks while an Agent action is already running', async () => {
    let finishFirst!: () => void;
    const first = vi.fn(
      () => new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
    );
    const duplicate = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);

    await executeCardAction({ action: 'agent.use', key: 'chat:agent-card', task: first });
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    await executeCardAction({ action: 'agent.use', key: 'chat:agent-card', task: duplicate });
    await executeCardAction({ action: 'agent.refresh', key: 'chat:agent-card', task: refresh });

    expect(duplicate).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    finishFirst();
    await waitForCardActions();
  });

  it('keeps immediate actions synchronous', async () => {
    const task = vi.fn(async () => undefined);
    await executeCardAction({ action: 'stop', key: 'chat:card-stop', task });
    expect(task).toHaveBeenCalledOnce();
  });

  it('registers every literal callback command rendered by src/card', async () => {
    const cardDir = join(process.cwd(), 'src', 'card');
    const files = (await readdir(cardDir)).filter((name) => name.endsWith('.ts'));
    const renderedCommands = new Set<string>();
    const commandPattern = /cmd:\s*['"]([^'"]+)['"]/g;

    for (const file of files) {
      const source = await readFile(join(cardDir, file), 'utf8');
      for (const match of source.matchAll(commandPattern)) renderedCommands.add(match[1]!);
    }

    expect(Object.keys(CARD_ACTION_MODES).sort()).toEqual(
      [...renderedCommands, 'agent_callback'].sort(),
    );
  });
});
