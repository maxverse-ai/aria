# Agent Runtime architecture

Status: accepted foundation. Native runtime migrations remain incremental.

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
profile owns the `EngineRuntime`; a run owns only its event stream and control
methods.

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

## Migration sequence

1. Keep existing adapters behind conservative `one-shot` descriptors.
2. Run Codex through the contract as the `profile-daemon` reference runtime.
3. Add native runtimes independently: Pi RPC, Kimi ACP, OpenCode Server,
   Claude streaming input, then DSH JSON-RPC.
4. Add a channel-neutral interaction broker for approval and questions.
5. Remove compatibility-only fields after every built-in engine passes the
   shared runtime contract tests.

Each migration must be independently reversible and must declare degraded
capabilities honestly. A queued next turn is preferable to pretending an
engine supports acknowledged live input.

## Contract gates

- Dynamic plugin descriptors are validated at runtime, not only by TypeScript.
- A live-input kind must also appear in the runtime's normal input kinds.
- `liveInput: none` cannot advertise live inputs.
- Plugin, runtime descriptor, and execution adapter ids must match.
- A profile switch must update descriptor and execution routing atomically.
- Every run must receive the scope reserved by `RunExecutor`.

Protocol fixtures and process tests remain the authority for native event and
control behavior. Channel tests verify only normalized semantics.
