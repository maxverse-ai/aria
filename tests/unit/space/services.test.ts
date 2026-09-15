import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, authorize } from './helpers';
import { ExecutionSpaceServices } from '../../../src/space/services';
import { SpaceStateStore } from '../../../src/space/state';
import { SpaceRuntimeRegistry } from '../../../src/space/runtime-registry';
import { ConversationRuntime } from '../../../src/conversation/runtime';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createAdapterRuntime } from '../../../src/agent/runtime/adapter-runtime';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { claudeCapability } from '../../../src/agent/capability';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

describe('common space execution', () => {
  it('exposes only exact source-admitted attachments and tears down engines after a tool close failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-space-admission-')); roots.push(root);
    const f = fixture(); const a = await authorize(f);
    const b = await authorize(f, { actorId: 'b', humans: ['b'], conversationId: 'dm-b' });
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot',
      create: async () => createAdapterRuntime(new FakeAgentAdapter({ id: 'claude' })) });
    const state = new SpaceStateStore(root, f.authorization);
    const services = new ExecutionSpaceServices(f.authorization, state, registry);
    const source = join(root, 'fixture.dmp'); await writeFile(source, 'fixture');
    expect(services.isAdmittedAttachment(a, source)).toBe(false);
    const [attachment] = await services.admitAttachments(a, [{ kind: 'file', decision: 'accepted', path: source } as never]);
    expect(services.isAdmittedAttachment(a, attachment!.path!)).toBe(true);
    expect(services.isAdmittedAttachment(b, attachment!.path!)).toBe(false);
    let disposed = false, flushed = false;
    registry.dispose = async () => { disposed = true; };
    state.flush = async () => { flushed = true; };
    services.installTools({ prepare: async () => undefined, activeWork: () => 2, close: async () => { throw new Error('fixture-close'); } });
    expect(services.runTools.activeWork?.()).toBe(2);
    await expect(services.close()).rejects.toThrow('fixture-close');
    expect(disposed && flushed).toBe(true);
    expect(() => services.isAdmittedAttachment(a, attachment!.path!)).toThrow('closed');
  });
  it('X1/D1: executes two users through one coordinator with independent runtime, cwd and session state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-space-service-')); roots.push(root);
    const f = fixture(); const a = await authorize(f);
    const b = await authorize(f, { conversationId: 'dm-b', actorId: 'b', humans: ['b'] });
    const agents: FakeAgentAdapter[] = [];
    const runtimes = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', create: async () => {
      const agent = new FakeAgentAdapter({ id: 'claude', events: [{ type: 'system', sessionId: `session-${agents.length}` }, { type: 'done', terminationReason: 'normal' }] });
      agents.push(agent); return createAdapterRuntime(agent);
    } });
    const spaces = new ExecutionSpaceServices(f.authorization, new SpaceStateStore(root, f.authorization), runtimes);
    const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'unused', secret: 'unused', tenant: 'feishu' } } });
    const conversations = new ConversationRuntime({ agent: new FakeAgentAdapter({ id: 'claude' }), spaces,
      sessions: new SessionStore(join(root, 'legacy-sessions.json')), workspaces: new WorkspaceStore(join(root, 'legacy-workspaces.json')),
      maxConcurrentRuns: () => 2 });
    for (const context of [a, b]) {
      const snapshot = f.authorization.inspect(context);
      const started = await conversations.start({ spaceContext: context, scopeId: snapshot.scopeRef,
        scope: { source: 'channel:fixture', actorId: snapshot.principal.subjectId },
        prompt: 'hello', attachments: [], access: { ok: true, reason: 'allowed-team' }, capability: claudeCapability(profile), profileConfig: profile,
        observability: { profile: 'profile', agent: 'claude', source: 'channel:fixture', stage: 'submit' } });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.rejectReason.code);
      for await (const event of started.execution.subscribe()) conversations.recordEvent({ scopeId: snapshot.scopeRef, capability: claudeCapability(profile), policy: started.policy, event });
    }
    expect(agents).toHaveLength(2);
    expect(agents[0]!.runOptions[0]!.cwd).not.toBe(agents[1]!.runOptions[0]!.cwd);
    expect(agents[1]!.runOptions[0]!.sessionId).toBeUndefined();
    await expect(conversations.start({ scopeId: 'raw', scope: { source: 'channel:fixture', actorId: 'a' }, prompt: 'x', attachments: [], access: { ok: true, reason: 'owner' }, capability: claudeCapability(profile), profileConfig: profile })).rejects.toThrow('trusted space');
    await spaces.close();
  });
});
