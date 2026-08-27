# Native read API architecture

> Status: v1 contract, per-profile file repository, source projectors,
> authenticated Unix-socket HTTP adapter and explicit runtime opt-in are
> implemented. No route listed here is considered available until the running
> instance advertises it.

Aria's native read API gives control-plane consumers one agent-neutral view of
profiles, sessions, messages, runs, identities, chats and audit evidence. It
replaces consumer-side parsing of Codex, Claude Code or other engine storage;
it does not replace or relocate those stores.

## Ownership boundary

```text
Agent-native stores (source of truth for resume)
                 |
          read-only adapters
                 |
Aria per-profile read model + append-only change journal
                 |
       Unix socket / authenticated API
                 |
           Control Plane
```

- Agent engines continue to own native session/thread files, databases and
  resume semantics.
- Aria never writes to an engine-native store through this API.
- Aria owns opaque resource IDs, normalized indexes, identity resolution,
  audit events and change cursors.
- A deleted Aria index can be rebuilt without changing native sessions.
- Engine-specific values belong in allowlisted, namespaced `extensions`.
  Core consumers must not branch on them.

## Contract namespace

The existing `aria.control.*.v1` contract versions configuration and runtime
CLI operations. Native read DTOs use the independent `aria.read.*.v1`
namespace and `NATIVE_READ_API_VERSION` so either surface can evolve without
silently changing the other.

The source of truth is
`src/application/control/native-read-types.ts`. Initial resource types are:

- `profile`
- `session`
- `message`
- `run`
- `identity`
- `chat`
- `chat-member`
- `audit-event`

## IDs and revisions

- `instanceId` identifies one Aria control service installation.
- `profileId` and every resource `id` are stable, opaque Aria identifiers.
- Native session IDs, thread IDs, chat IDs and user IDs are source references,
  not public resource identities. They are not authorization evidence.
- `revision` increases whenever a mutable read-model resource changes.
- `audit-event` resources are append-only; corrections create a new event.
- Timestamps are RFC 3339 UTC strings on the wire.

## Pagination and change feed

List operations return `snapshotCursor` plus an optional `nextCursor`. A
consumer must retain the snapshot watermark while following list pagination,
then continue from `/v1/changes?after=<snapshotCursor>`.

Change delivery is at least once. Consumers deduplicate by
`(instanceId, eventId)` and apply only revisions newer than their materialized
resource. Deletes are explicit tombstones. An expired cursor returns
`CURSOR_EXPIRED` with `resnapshotRequired: true`; consumers then rebuild from
the list endpoints rather than guessing a cursor.

## Local persistence boundary

Each profile has an Aria-owned `native-read/` directory containing a mode
`0600` atomic snapshot and append-only JSONL change journal. The journal is the
durability boundary; the snapshot is a rebuildable acceleration structure.
Writes are serialized, revisions remain monotonic across deletes, and repeated
`eventId` writes are idempotent. A torn final journal write is discarded before
new entries are accepted; corruption in an earlier entry fails closed.

These files contain normalized copies and indexes only. They are never used by
an agent to resume a conversation, and neither repository initialization nor
rebuild writes to Codex, Claude Code or another engine's native storage.

## Conversation content and audit

Conversation content, governance audit and operational telemetry are separate
data classes:

- Message content is returned only when the caller has message-content scope.
  Otherwise `content.available=false`; placeholder text must not be invented.
- Audit is emitted where an action occurs. Chat transcripts must never be
  converted into inferred tool, policy or credential audit records.
- Telemetry measures latency, counts and health. It is not durable audit.
- Secrets, credentials and unrestricted tool arguments/results are never
  returned by the read API.
- Reads of sensitive content and audit data are themselves auditable actions.

`NativeAuditRecorder` is the only application-layer write entry point for
governance evidence. Its closed input type intentionally excludes arbitrary
metadata, prompts, transcripts, tool arguments/results and credentials. The
source operation ID is converted to an opaque ID before persistence, and
retries are idempotent. Audit corrections use a new source event rather than
mutating an earlier event.

`RunExecutor` emits `run.started`, `run.completed`, `run.failed`,
`run.interrupted` and `run.timeout` directly from its execution lifecycle to
an optional `RunAuditSink`. `NativeRunAuditSink` converts the executor run ID
to an Aria-owned opaque reference before calling the recorder. Agent error
messages, prompts and event payloads are deliberately excluded. Audit storage
failures are reported as operational warnings and do not strand or terminate
the already-running agent process.

Normalized IM receipt and successful message send/stream operations emit
`message.received` and `message.sent` through `MessageAuditSink` at the channel
and outbound-broker boundaries. `NativeMessageAuditSink` converts native
message, chat and sender identifiers into opaque references; message bodies
and outbound payloads are never part of this audit contract. Failed sends do
not produce success evidence, while audit-storage failures do not alter
delivery.

Message history is a separate, scope-protected read resource. Aria persists a
normalized message immediately with `associationStatus: pending`; once the
agent reports its authoritative native session/thread identifier, the same
resource is updated to `resolved` and linked to opaque session/run IDs. This
avoids inventing session relationships during intake. `GET /v1/messages`
includes pending records, while `/v1/sessions/{sessionId}/messages` contains
only resolved records for that session. Message text is returned only with
`read:message-content`; the profile-local journal and snapshot remain mode
`0600` and never modify agent-native history files.

Run resources are projected from the same `RunExecutor` lifecycle events that
produce run audit evidence. A run starts as `associationStatus: pending`; the
message/session binding resolves its opaque `sessionId`, and later terminal
events preserve that association while updating status and completion fields.
Consequently every resolved `Message.runId` points at a real `/v1/runs`
resource rather than a synthesized UI-only record.

## Transport and security

- Same-host consumers use a mode `0600` Unix-domain socket.
- `DefaultNativeReadProfileRuntime` composes the repository, session projector,
  audit recorder and socket server for one profile. Construction is inert and
  Supervisor integration requires an explicit `createNativeReadRuntime`
  factory, so the API remains disabled by default.
- The enabling composition must supply a bearer token and granted scopes. Aria
  does not silently invent a token, place one in `config.json`, or expose the
  socket during an ordinary profile start.
- Runtime start performs an initial projection from Aria's existing
  `SessionCatalog`; `refreshSessions()` updates that read model without moving
  or rewriting any agent-native session store.
- Production composition remains off by default. Set
  `ARIA_NATIVE_READ_ENABLED=true`, point `ARIA_NATIVE_READ_TOKEN_FILE` at a
  regular mode `0600` file (default `<aria-root>/native-read.token`), and list
  the exact comma-separated grants in `ARIA_NATIVE_READ_SCOPES`. Invalid or
  missing settings fail profile startup instead of silently widening access.
- Cross-host access requires HTTPS plus an authenticated service identity.
- Browsers do not connect directly to Aria; the Control Plane applies product
  authorization and exposes its own DTOs to the admin UI.
- The read API is read-only. Configuration mutations continue through the
  existing plan, confirm and apply control protocol.

## Delivery order

1. Contract and compatibility tests.
2. Per-profile read repositories and change journal.
3. Agent and channel adapters.
4. Unix-socket application adapter and capability discovery.
5. Source-side audit instrumentation.
6. Control Plane dual-read validation and eventual parser removal.
