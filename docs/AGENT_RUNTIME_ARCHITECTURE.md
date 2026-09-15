# Agent Runtime architecture

> Status: current — accepted foundation. Native runtime migrations remain incremental.

The current v1 runtime contract is described below. The target ownership change
is defined in [Execution space architecture](EXECUTION_SPACE_ARCHITECTURE.md)
and tracked in [its delivery plan](EXECUTION_SPACE_DELIVERY_PLAN.md).
Implementation through E5.3 adds fixed-generation runtime leases and an internal
prepared-space owner. Personal and unmigrated team profiles keep one default
runtime; prepared spaces have their own runtime owners. Public v1 contracts
remain unchanged. [Evidence and activation limits](EXECUTION_SPACE_IMPLEMENTATION.md)
distinguish adapter implementation from deployment acceptance.

## Goal

Aria channels and conversation orchestration must not know an engine's native
protocol. Adding an engine should require a plugin/runtime implementation, not
new engine-name branches in Feishu handlers.

```text
Channel adapter
    -> Conversation runtime
        -> AgentAdapter execution compatibility port
            -> EngineRuntime
                -> native CLI / JSON-RPC / ACP / HTTP+SSE protocol
```

The compatibility port remains while built-in one-shot adapters migrate. The
profile currently owns the `EngineRuntime`; a run owns only its event stream
and control methods. The execution-space target retains one profile execution
coordinator while placing runtime ownership behind a space-bound provider.

## Construction preparation

`createProfileEngineRuntime` remains the shared facade used by Supervisor and
the standalone conversation host. It calls `prepareProfileEngineRuntime`, then
creates one managed instance from the returned plan.

The internal [construction context](../src/agent/runtime/construction.ts)
records the compatibility profile owner, existing state directory and legacy
tool binding. Each built-in factory resolves its own native constructor options
during preparation. The native constructor receives an owned, frozen snapshot
instead of retaining the caller's mutable configuration. Preparation performs
no filesystem, credential or process I/O.

Codex and Grok resolve their explicit/default home override before construction;
their inheritance selectors retain their previous meaning. Normalized profiles
default to home inheritance for both engines. Pi/DSH default directories and
OpenCode XDG overrides also retain existing values. Ambient environment reads,
prompt composition, preflight, native permission mapping and actual launch
timing remain at their existing boundaries.

The [registry](../src/agent/plugin/registry.ts) keeps external plugin v1 inputs
as a private snapshot and supplies an independent mutable projection on each
creation. Preparation does not mark a plugin active; creation still validates
runtime metadata and owns the active count until disposal. A prepared plan
cannot create an instance after its plugin is unloaded or replaced.

This is a construction plan, not a runtime lease or an isolation grant. Each
creation returns a new instance; there is no runtime pool or per-user routing.
[Process compatibility tests](../tests/process/engine-construction.test.ts)
exercise all seven engines and the real channel-free standalone host with fake
binaries and temporary state.

## Runtime contract

Every runtime has a versioned `EngineRuntimeDescriptor` containing:

- `engineId`, which must match both the plugin and execution adapter;
- a process topology: `one-shot`, `profile-daemon`, or `session-pool`;
- semantic capabilities for inputs, live input, sessions, controls,
  interactions, and telemetry.

Descriptors never expose transport method names. For example, Codex
`turn/steer`, Pi `steer`, and a future HTTP endpoint all project to the same
`liveInput: direct` capability. Missing features mean unsupported; consumers
must not infer them from `engineId`.

`AgentCapability` remains the static channel and policy boundary. It owns the
bridge prompt, callback marker, session identity kind, and maximum access.
`EngineRuntimeDescriptor` describes the live execution implementation. These
are separate responsibilities rather than competing sources of truth.

## Scope identity

Every `AgentRunOptions` includes a required `scopeId`. It is the stable routing
key for one conversation scope and lets future session-pooled runtimes retain
the correct worker. Engines must treat it as opaque: no runtime may parse a
Feishu chat or thread format from the value.

The execution pipeline supplies the same scope to process reservation, active
run registration, observability, and the engine. Direct adapter callers must
also provide it.

## Lifecycle ownership

`ProfileRuntimeSlot` is the stable routing point during engine switches. It
exposes the current descriptor and forwards execution, model, status, and bot
identity operations to the current runtime. Swapping a runtime increments the
slot generation and invalidates cached live status before the previous runtime
is disposed.

Runtime topology is descriptive in contract version 1. The runtime itself owns
the corresponding processes:

- `one-shot`: one child process per run;
- `profile-daemon`: one multiplexing process owned by the profile;
- `session-pool`: profile-owned workers keyed by opaque session/scope identity.

Supervisor and channel code must not implement topology-specific branches.

## Execution-space target

Personal mode resolves to one compatibility/default space. Explicitly migrated
team mode resolves trusted private or shared inputs to their owning spaces.
Each space owns a runtime generation; the runtime owns its processes or
connections. One-shot engines may run multiple scoped child processes within
that space. Codex's one-space/one-App-Server mapping is not a universal
one-process-per-space requirement.

The implementation must evolve construction, execution and query interfaces
together:

- resolve state paths, tool bindings and effective permissions before plugin
  construction; replace whole-profile and Lark-specific construction inputs
  through compatibility adapters;
- fix one runtime lease for prepare, run, steering, interruption and cleanup;
- route native history, model queries and diagnostics through the same
  authorized context; daemon history helpers cannot create an unowned second
  server on the same space state;
- compose source/tool prompts outside engines and supply self identity as
  immutable run context;
- preserve static permission ceilings separately from live capability facts;
  native permission translation stays in the engine adapter;
- version public contract changes explicitly, including any replacement for
  the profile-owned terminology in topology v1.

The [engine adoption matrix](EXECUTION_SPACE_ARCHITECTURE.md#engine-adoption-matrix)
records the current Codex, Grok, Claude, Kimi, OpenCode, Pi and DSH paths.
Isolation support must be proven per engine and deployment. Missing history,
images or live input can be reported as unavailable; missing isolation cannot
fall back to a shared personal runtime.

## Migration sequence

1. Keep existing adapters behind conservative `one-shot` descriptors.
2. Use the current Codex and Grok `profile-daemon` implementations as native
   runtime references.
3. Add native runtimes independently: Pi RPC, Kimi ACP, OpenCode Server,
   Claude streaming input, then DSH JSON-RPC.
4. Add a channel-neutral interaction broker for approval and questions.
5. Remove compatibility-only fields after every built-in engine passes the
   shared runtime contract tests.

Each migration must be independently reversible and must declare degraded
capabilities honestly. A queued next turn is preferable to pretending an
engine supports acknowledged live input.

Native protocol upgrades remain independent from execution-space adoption.
The next space task is E2.2: introduce the runtime acquisition port over the
existing default runtime, including fixed-generation control and query/disposal
contracts.

## Contract gates

- Dynamic plugin descriptors are validated at runtime, not only by TypeScript.
- A live-input kind must also appear in the runtime's normal input kinds.
- `liveInput: none` cannot advertise live inputs.
- Plugin, runtime descriptor, and execution adapter ids must match.
- A profile switch must update descriptor and execution routing atomically.
- Every run must receive the scope reserved by `RunExecutor`.

Protocol fixtures and process tests remain the authority for native event and
control behavior. Channel tests verify only normalized semantics.
