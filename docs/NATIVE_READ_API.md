# Native read API architecture

> Status: current — v1 contract, per-profile file repository, source projectors, authenticated Unix-socket HTTP adapter and explicit runtime opt-in are implemented. No route listed here is considered available until the running instance advertises it.

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

Message observation also lazily materializes the minimum joinable topology:
an opaque `identity` for a known sender, an opaque `chat` when the channel can
classify the conversation, and an `unknown`-role `chat-member` edge between
them. This is an identity index, not an authorization decision. It contains no
source user/chat ID or fabricated display name, and later authoritative channel
resolution can enrich it without a subsequent message downgrading that data.
When a channel receipt already includes a sender display name, Aria stores that
value as a display-only snapshot on the opaque identity. A receipt without a
name remains pending and cannot erase a newer resolved name; names never become
authorization evidence or public source identifiers.
When a message is bound to a session, its actor identity is added to the
session's deduplicated `participantIdentityIds`; catalog refreshes preserve
those observed participants and do not move session activity timestamps
backward.

For Lark intake, chat mode and any recoverable topic `threadId` are resolved
before audit, message projection, outbound policy, and session routing. Those
consumers therefore share one canonical conversation key, including for the
topic-opening events on which Lark omits `threadId` from the initial event.

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

## Host management read view

Management review is distinct from user execution and delegated Space reads.
The `/read-access` user command is removed; no browser needs a personal Space
grant. Existing Space repository authorization and revocation remain intact.

- Opt in with `ARIA_NATIVE_READ_MANAGEMENT_PUBLIC_KEY_FILE` (SPKI Ed25519 public
  PEM) and `ARIA_NATIVE_READ_MANAGEMENT_PROFILES` (explicit profile allowlist).
  Aria receives **only the public key**, mounted read-only by the deployment.
  The administrator service keeps its PKCS8 signing key outside all agent
  containers and writable mounts. A shared management bearer is not supported.
- In addition to the existing transport bearer, each GET carries
  `X-Aria-Management-Authorization` with
  `aria-management-v1:<unix-ms>:<32-lowercase-hex-nonce>:<base64url-signature>`.
  The signed UTF-8 payload is six newline-joined fields, with no trailing LF:
  scheme, profile ID, HTTP method, complete request target including query,
  Unix milliseconds, nonce. Use Ed25519 (no prehash), unpadded base64url.
- Proofs allow at most 5 seconds of clock lead and 30 seconds of age. A bounded
  nonce cache rejects reuse within the running instance and validity window.
  Different profile, method, route, query, expired or invalid signature, or a
  simultaneous personal grant fails closed. Valid responses include
  `X-Aria-Management-Read-Authorized: 1`; consumers must require this ACK so a
  rolled-back server cannot silently return its old ambient view.
- The derived view namespaces IDs and every cross-reference by profile and
  physical source partition. `aria.management.origin` identifies legacy or
  Space provenance without creating ownership/migration grants. Startup reads
  source snapshots/journals read-only, including torn-tail observation; only
  the derivative is reconciled. Source projectors remain the single writers.
- Reconciliation runs independently of Bot readiness. Until complete, or after
  a failed/overflowed mirror, management requests return 503, never false empty
  success. Mirrors are bounded asynchronous side effects. Source operations
  and running agents do not wait for management I/O. Restart replays sources.
  Derived checkpoints occur every 250 entries; each journal append is durable.
- `GET /v1/session-summaries?limit=1..200&cursor=...` is advertised only to a
  verified management caller. `aria.read.session-summaries.v1` returns `total`,
  `items` and optional `nextCursor`. Each item has a full `session`, optional
  `lastUser`, `chat`, `owner`, counts and an optional 500-character preview.
  Required scopes: sessions, messages, message-content, runs, identities, chats.
  All pages in one traversal use an immutable snapshot (60-second TTL, at most
  eight retained snapshots per profile). Invalid/expired cursors require a
  fresh traversal; never append a replacement first page to partial results.
- Sessions sort by actual `lastActivityAt` descending and opaque ID for ties.
  Message occurrence and run start/completion can advance activity; display
  metadata cannot. Choose the most recent observed human sender; only a sole
  observed human is a fallback. Do not select arbitrary group participants.
- Lark names come from authenticated inbound sender metadata and a bounded,
  per-channel chat-info cache (5-minute positive, 1-minute failed lookup TTL,
  800-ms caller deadline). Preserve last known names on transient failures.
  Names are display evidence, not identity or access-control keys. Historical
  opaque records without recorded names cannot be reverse-resolved by hashing;
  show missing metadata explicitly, never use an AI title as a group name.
- Authorized read attempts produce `read.performed`, outcome `unknown`, in a
  separate private `access-audit.journal.jsonl` via `NativeAuditRecorder` before
  reading. It records admission, not a claim of successful delivery. Failure
  to record denies this management read. HTTP completion/denial status is
  separate sanitized operational telemetry. Neither signatures, private keys,
  message contents nor query strings enter the audit. The audit is not mirrored
  into the feed it observes, avoiding a self-triggering polling loop.

The application-level Space fence is not an OS sandbox: `trusted-process`
retains host access by design. Do not place a management signing key beside
the transport token in a same-UID agent container and assume 0600 isolates it.
