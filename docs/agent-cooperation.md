# Cooperative replies

Aria preserves the complete incoming message and each run's own identity. A group
input explicitly addressing multiple participants, or an access-admitted bot
mention, enables a terminal reply protocol for that run. This is a transport
capability, not an assignment algorithm: the engine still interprets who should
work and when. No counter or task-specific leader is installed in the runtime.

The protocol instructions are appended to the message context, not to the stable
system/identity prefix. Ordinary single-recipient and direct conversations retain
their presentation behavior. Cooperative turns buffer terminal output, including
in Team mode, so control envelopes never stream as public messages.

* Plain text: publish a reply, without runtime telemetry in its body.
* `<aria_reply>{"action":"wait"}</aria_reply>`: finish the run without a public reply.
* `<aria_reply>{"action":"handoff","recipient":"subject-id","text":"result"}</aria_reply>`:
  the host checks freshness, then publishes the result with structured addressing.

The parser is platform-independent. The Lark adapter validates its recipient ID
format, rejects self handoffs, and uses SDK `SendOptions.mentions` to produce a real
mention. Other entrances must supply their own addressed publisher before exposing
this protocol. A protocol does not grant permission to a recipient or a sender.

## Incoming peers and freshness

The existing access and Space admission checks remain authoritative. Explicit,
admitted peer input can steer a supporting engine. Unsupported engines retain the
input in the existing queue. An unconsumed admitted peer invalidates a pending
final answer, just as an addressed human input does. Ambient bot messages retain
only conservative exact-body duplicate detection; merely appearing in REST
history is not input authority.

Cooperative replies require a complete history snapshot. Permission failure,
truncation or timeout withholds the answer and produces a pause diagnostic instead
of publishing an unverified result. Personal ordinary answers retain fail-open
behavior. API error code and missing scope are logged without credentials, with
the channel identity to distinguish profiles. This is an on-use capability check,
not a promise that application permissions can be granted by Aria.

Team history uses an explicit host-bound adapter instead of exposing rawClient to
engines. It verifies the active conversation and topic, refreshes authority before
and after reads, independently admits recovered senders, checks binding and
execution scope, and attaches the issued SpaceOperation before queueing. Revoked
or foreign contexts cannot release history into a run.

A host-local publication queue serializes final check + send for the same provider
and physical conversation/topic across profiles. Idle keys are removed and failed
publishers release the queue. This is not a distributed lock or a linearizable
view of Feishu history: eventual history visibility and sends from other processes
remain outside its guarantee. It does not enforce a counting sequence.

## Validation and remaining live prerequisites

Offline integration drives three independent bridge runtimes through 0..8 with
scripted engines. It verifies wait suppression, directed event delivery, next-run
activation, and clean result bodies. Separate tests verify real SDK mention
conversion, permission failure, admitted versus denied peers, publication
serialization, and Space audience/revocation checks. Scripted engines do not prove
that a language model will always follow the turn order.

For the Agent Team live test, each application's group-history permission and
Aria's existing group access policy must allow the operation. The September 9
trace showed CoCo and Alice missing `im:message.group_msg`. Do not weaken identity
or Space policy to compensate. Start with an explicit human request naming the
order and end condition, and verify each received event before declaring success.

The cooperative instruction asks engines to use the host terminal protocol for
handoffs. Arbitrary external tool sends are not intercepted by this patch and must
not be advertised as covered by the host's freshness gate. SDK/platform bot event
availability, language-model compliance, and long-running loop limits still need
real-environment validation. A missing live event is distinct from a queued event
or an engine refusing steering; use the intake/followup/freshness/outbound trace.
