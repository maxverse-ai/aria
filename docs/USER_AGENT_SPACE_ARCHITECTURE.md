# Archived: User Agent Space architecture

> Status: archived proposal, never implemented, not on the active roadmap.
> Aria retains one engine runtime per profile. This document is preserved only
> as historical design context; implementation requires a new architecture
> decision and must not be inferred from the management-control-plane plan.

Everything below this notice describes the historical proposal. Its decisions,
phases, rollout steps, and acceptance criteria are inactive.

## Decision summary

For a team profile, Aria should route group conversations and direct messages
to different agent spaces:

```text
Team Profile
|
+-- SharedAgentSpace
|   `-- one shared App Server
|       `-- all group and topic-group conversations, bot identity only
|
+-- UserAgentSpace(user A)
|   `-- one App Server dedicated to user A
|       `-- all direct-message conversations from user A
|
`-- UserAgentSpace(user B)
    `-- one App Server dedicated to user B
        `-- all direct-message conversations from user B
```

The initial implementation uses a strict one-to-one mapping:

```text
one AgentSpace -> at most one active App Server
one App Server -> exactly one AgentSpace for its entire lifetime
```

App Server pooling, idle eviction, capacity scheduling, cross-machine
placement, and other runtime-management optimizations are deliberately deferred.

## Why this boundary exists

The current team mode has one profile-level agent runtime and forces lark-cli
to bot-only identity. That is safe for groups, but it cannot give each person a
private runtime carrying only that person's authorization.

The proposed boundary preserves the safe group behavior while allowing direct
messages to use per-user state:

- group and topic-group traffic always stays in `SharedAgentSpace`;
- direct-message traffic always enters the sender's `UserAgentSpace`;
- an agent never chooses a space, user id, or credential;
- routing is completed from trusted Lark event metadata before an agent run;
- prompt text is explanatory context, not an authorization control;
- no App Server process can be rebound from one user to another.

An App Server process alone is not the complete isolation boundary. An
`AgentSpace` owns the process environment and all identity-bearing state:

```text
AgentSpace
+-- App Server process
+-- CODEX_HOME
+-- lark-cli config and source projection
+-- OAuth authorization state
+-- session/thread catalog
+-- logs and runtime status
`-- working state owned by the space
```

Creating separate App Server processes while sharing any of these
identity-bearing paths would not provide user isolation.

## Terminology

### SharedAgentSpace

The profile-owned shared space used by every group and topic-group
conversation. It uses application/bot identity only and must never contain a
person's user authorization.

### UserAgentSpace

A persistent space owned by one user within one profile, tenant, and bot app.
All of that user's direct-message scopes may share the space and App Server,
while retaining separate Codex threads.

### AgentSpaceRuntime

The live engine runtime associated with an agent space. For Codex this owns one
managed `codex app-server` process. The persistent space can outlive a process,
even though the first implementation does not yet perform idle eviction.

### AgentSpaceRuntimeRegistry

The profile-level owner of the shared runtime and all user runtimes. Initially
this is a keyed registry, not a reusable worker pool.

## Stable identity and routing

The domain key should make cross-profile, cross-tenant, and cross-app reuse
impossible:

```ts
type AgentSpaceKey =
  | {
      kind: 'shared';
      profile: string;
    }
  | {
      kind: 'user';
      profile: string;
      tenantKey: string;
      botAppId: string;
      userOpenId: string;
    };
```

Routing is deterministic:

```ts
if (message.chatType === 'p2p') {
  return userAgentSpace({
    profile,
    tenantKey,
    botAppId,
    userOpenId: message.senderOpenId,
  });
}

return sharedAgentSpace({ profile });
```

Only normalized, verified event fields may supply these values. Message text,
model output, tool arguments, and prompt-injected metadata are not trusted
routing inputs.

## Runtime ownership

The registry maintains a single-flight mapping:

```ts
Map<AgentSpaceId, Promise<AgentSpaceRuntime>>
```

The minimum lifecycle contract is:

1. The first run for a space creates its runtime and App Server.
2. Concurrent first runs await the same creation promise.
3. Later runs reuse the same runtime.
4. A failed creation is removed so a later request may retry.
5. Profile stop, restart, reconnect replacement, or engine switch disposes all
   runtimes.
6. A runtime can never change its `AgentSpaceKey` after construction.

The first version intentionally keeps created runtimes alive until their
profile lifecycle ends. Resource controls can be added later without changing
the routing or storage model.

## Persistent layout

Suggested profile-local layout:

```text
profiles/<profile>/
`-- agent-spaces/
    +-- shared/
    |   +-- codex-home/
    |   +-- lark-cli/
    |   +-- sessions.json
    |   `-- logs/
    |
    `-- users/
        `-- <space-hash>/
            +-- metadata.json
            +-- codex-home/
            +-- lark-cli/
            +-- sessions.json
            `-- logs/
```

`space-hash` should be a stable cryptographic hash of the complete user-space
key. Raw open ids should not be directory names. Metadata must not contain
tokens, app secrets, or other credentials.

Each App Server starts with immutable space-bound paths, including:

```text
CODEX_HOME=<space>/codex-home
LARKSUITE_CLI_CONFIG_DIR=<space>/lark-cli
LARK_CHANNEL_PROFILE=<profile>
ARIA_AGENT_SPACE_ID=<opaque-space-id>
ARIA_AGENT_SPACE_KIND=shared|user
```

## Conversation and session isolation

Codex App Server can host multiple threads. A user's direct-message scopes can
therefore share one App Server without sharing conversation history.

Session lookup must include the space id:

```text
agentSpaceId
+ scopeId
+ agentId
+ cwdRealpath
+ policyFingerprint
```

Required invariants:

- all group scopes belong to `SharedAgentSpace`;
- every direct-message scope belongs to its sender's `UserAgentSpace`;
- different spaces cannot resume the same stored thread through Aria's session
  catalog;
- a user's multiple scopes may use separate threads within the same App Server;
- legacy profile-level sessions are treated as shared-space sessions during
  migration.

## lark-cli identity behavior

`SharedAgentSpace` is permanently bot-only:

```text
application credentials: profile bot app
user authorization: prohibited
identity policy: bot-only
```

`UserAgentSpace` receives the same application identity but its own isolated
user-authorization storage:

```text
application credentials: profile bot app
user authorization: initially absent, later only the owning user
identity policy: auto after successful private authorization
```

Creating a user space must never copy another user's OAuth state. After OAuth,
the authorized Lark user must match `AgentSpaceKey.userOpenId`; a mismatch is a
failed authorization and the returned credential must not be retained.

Authorization can only be completed in a direct conversation. Group flows must
not create personal spaces, publish device-flow links, or attach personal
authorization to the shared runtime.

The first implementation may retain the existing private OAuth ceremony.
Programmatically detecting an authorization-required tool result and resuming
the original operation is a separate follow-up; it is not necessary to establish
the space and process isolation boundary.

## Implementation phases

### Phase 0: freeze contracts

- Record routing, process ownership, storage, and authorization invariants.
- Add a routing truth table and isolation threat cases.
- Keep existing behavior unchanged.

### Phase 1: agent-space domain

- Add `AgentSpaceKey`, stable ids, and deterministic routing.
- Unit-test group, direct-message, tenant, app, and spoofing cases.
- Keep the domain layer independent of filesystem and processes.

### Phase 2: isolated paths

- Resolve shared and user space paths below the profile directory.
- Hash user keys for directory names.
- Test determinism, collisions, and path traversal resistance.

### Phase 3: one-runtime-per-space registry

- Introduce `AgentSpaceRuntimeRegistry`.
- Guarantee single-flight creation and one active runtime per space.
- Dispose every runtime as part of profile shutdown and replacement.
- Do not add eviction, pooling, quotas, or scheduling configuration.

### Phase 4: bind engine runtimes to spaces

- Construct Codex runtimes from `AgentSpacePaths` instead of profile-global
  state paths.
- Fix `CODEX_HOME` and lark-cli environment at process creation.
- Reject runtime/key mismatches and prohibit rebinding.

### Phase 5: route message runs

- Resolve the space after access checks and before `startRunFlow`.
- Acquire the selected space runtime and submit through its executor.
- Keep agent prompts and tool arguments outside the routing decision.

### Phase 6: isolate sessions and threads

- Add `agentSpaceId` to session catalog identity.
- Preserve separate conversation scopes inside a user App Server.
- Add cross-space resume rejection and migration tests.

### Phase 7: isolate lark-cli authorization

- Materialize a separate lark-cli projection for every space.
- Enforce bot-only shared space behavior.
- Verify personal OAuth ownership before persisting authorization.
- Keep authorization URLs and completion flows private.

### Phase 8: diagnostics and guarded rollout

- Report space kind, opaque id, runtime health, and authorization presence.
- Never expose tokens, secrets, email addresses, or other users' conversations.
- Introduce a guarded `shared-groups-user-dms` mode.
- First validate shared-space compatibility, then enable selected user spaces,
  and finally roll out to team profiles.

## Deferred work

The following are explicit follow-ups, not hidden requirements of the first
implementation:

- App Server idle timeout and LRU eviction;
- global and per-user runtime capacity limits;
- queued startup scheduling;
- reusable capacity slots or a runtime pool;
- crash backoff and advanced health management;
- cross-machine placement;
- automatic authorization challenges and operation replay;
- delegated authorization and acting on behalf of another user;
- personal identity use inside group conversations;
- a general credential broker or tool gateway.

If runtime pooling is later introduced, only capacity slots may be reused. A
live App Server process that served one user must never be rebound to another
user; it must be fully terminated and replaced with a new space-bound process.

## Compatibility and rollout

The change should be additive and guarded:

1. Keep the current profile runtime behavior as the default.
2. Model the existing team runtime as `SharedAgentSpace` without changing group
   behavior.
3. Enable `UserAgentSpace` for selected direct-message test users.
4. Verify App Server, paths, OAuth state, sessions, and logs cannot cross users.
5. Enable `shared-groups-user-dms` for team profiles.
6. Remove the legacy single-runtime branch only after the new path is stable.

A single high-level configuration switch is preferred:

```json
{
  "agentSpaces": {
    "mode": "shared-groups-user-dms"
  }
}
```

Runtime-management settings should not be added until the deferred management
phase has concrete operational requirements.

## Acceptance criteria

The initial architecture is complete when all of the following are true:

- every group conversation uses the one shared bot App Server;
- every direct-message user has a distinct user App Server;
- one space never owns multiple simultaneous App Servers;
- one App Server never serves multiple spaces;
- user authorization, lark-cli configuration, sessions, and Codex home are
  isolated by space;
- routing does not depend on model behavior or prompt instructions;
- a profile lifecycle operation safely disposes all space runtimes;
- existing group behavior remains compatible;
- no pooling or runtime-management subsystem is required for correctness.
