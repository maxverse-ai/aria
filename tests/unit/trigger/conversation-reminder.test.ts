import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TriggerManagementApi } from '../../../src/trigger/operations';
import {
  ConversationReminderService,
  FileConversationAnchorStore,
} from '../../../src/trigger/reminder';
import { InMemoryTriggerStateStore } from '../../../src/trigger/state';

const directories: string[] = [];
const now = Date.parse('2026-09-03T10:00:00.000Z');
const owner = { source: 'card' as const, principal: 'user-a' };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-conversation-reminder-'));
  directories.push(rootDir);
  const state = new InMemoryTriggerStateStore();
  const anchorPath = join(rootDir, 'triggers', 'conversation-anchors.v1.json');
  const anchors = new FileConversationAnchorStore(anchorPath);
  let request = 0;
  const api = new TriggerManagementApi({
    rootDir,
    store: state,
    now: () => now,
    createId: () => 'definition-a',
  });
  const reminders = new ConversationReminderService({
    api,
    anchors,
    now: () => now,
    createId: () => request++ === 0 ? 'anchor-a' : `request-${request}`,
  });
  return { rootDir, state, anchorPath, anchors, reminders };
}

describe('ConversationReminderService', () => {
  it('keeps channel coordinates in a private anchor and only stores its opaque id in the schedule', async () => {
    const { state, anchorPath, anchors, reminders } = await fixture();
    const created = await reminders.create({
      profileId: 'profile-a',
      endpoint: {
        pluginId: 'lark-channel',
        instanceId: 'lark-primary',
        scopeId: 'chat-secret',
        sourceMessageId: 'message-secret',
      },
      at: '2026-09-03T11:00:00.000Z',
      timeZone: 'Asia/Singapore',
      prompt: 'Send the private report',
      label: 'Private report',
    }, owner);

    expect(created).toMatchObject({ id: 'definition-a', profileId: 'profile-a', state: 'active' });
    const definition = await state.getDefinition('definition-a');
    expect(definition?.intentTemplate.resultRoutes).toEqual([
      { kind: 'conversation', routeId: 'conversation', conversationRef: 'anchor-a' },
    ]);
    expect(JSON.stringify(definition)).not.toContain('chat-secret');
    expect(JSON.stringify(definition)).not.toContain('message-secret');
    expect(JSON.stringify(definition)).not.toContain('lark-primary');

    expect(await anchors.resolve('profile-a', 'anchor-a')).toEqual({
      profileId: 'profile-a',
      pluginId: 'lark-channel',
      instanceId: 'lark-primary',
      scopeId: 'chat-secret',
      sourceMessageId: 'message-secret',
    });
    if (process.platform !== 'win32') {
      expect((await stat(anchorPath)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(anchorPath, 'utf8')).toContain('chat-secret');
  });

  it('supports owner-scoped list, update, snooze, history and cancel operations', async () => {
    const { state, reminders } = await fixture();
    await reminders.create({
      profileId: 'profile-a',
      endpoint: { pluginId: 'lark', instanceId: 'primary', scopeId: 'chat-a' },
      at: '2026-09-03T11:00:00.000Z',
      prompt: 'First prompt',
    }, owner);

    expect(await reminders.list('profile-a', owner)).toHaveLength(1);
    expect(await reminders.list('profile-a', { source: 'card', principal: 'user-b' })).toHaveLength(0);
    await expect(reminders.update('profile-b', 'definition-a', 'cross profile', owner)).rejects.toMatchObject({
      code: 'reminder-forbidden',
    });
    await expect(reminders.cancel('profile-a', 'definition-a', { source: 'card', principal: 'user-b' })).rejects.toMatchObject({
      code: 'reminder-forbidden',
    });

    await reminders.update('profile-a', 'definition-a', 'Updated prompt', owner);
    expect((await state.getDefinition('definition-a'))?.intentTemplate.input.prompt).toBe('Updated prompt');
    const snoozed = await reminders.snooze('profile-a', 'definition-a', '2026-09-03T12:00:00.000Z', owner);
    expect(snoozed.nextFireAt).toBe(Date.parse('2026-09-03T12:00:00.000Z'));
    expect((await reminders.history('profile-a', 'definition-a', owner)).occurrences).toEqual([]);
    expect((await reminders.cancel('profile-a', 'definition-a', owner)).state).toBe('canceled');
  });

  it('rejects agent callers, past times and invalid creations without leaking anchors', async () => {
    const { anchors, reminders } = await fixture();
    const input = {
      profileId: 'profile-a',
      endpoint: { pluginId: 'lark', instanceId: 'primary', scopeId: 'chat-a' },
      at: '2026-09-03T11:00:00.000Z',
      prompt: 'Work',
    };
    await expect(reminders.create(input, { source: 'agent', principal: 'agent-a' })).rejects.toMatchObject({
      code: 'reminder-forbidden',
    });
    await expect(reminders.create({ ...input, at: '2026-09-03T09:00:00.000Z' }, owner)).rejects.toMatchObject({
      code: 'invalid-reminder-time',
    });
    await expect(reminders.create({ ...input, prompt: ' ' }, owner)).rejects.toMatchObject({
      code: 'invalid-reminder',
    });
    expect(await anchors.list()).toEqual([]);
  });
});
