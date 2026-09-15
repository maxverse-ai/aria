# Team presentation and changing audiences

Prepared execution spaces reuse the profile's presentation preferences:
`cotMessages`, `showToolCalls`, and `messageReply`. A space owns execution data
and authorization, not a copy of these preferences. Personal mode remains the
default; only an explicitly prepared Team host uses these adapters.

For a one-human/one-bot group, private execution uses the human's UserSpace.
Their real DM uses the same UserSpace with a different conversation scope. A
second human changes the group's binding epoch and selects shared execution.
This is independent of the profile mode and of whether the engine uses a
persistent server, a session adapter, or a one-shot process.

## User-visible behavior

- Existing `off`, `brief`, and `detailed` settings survive Team activation.
  Detailed tools obey `showToolCalls`; disabling CoT can still show card progress
  when the reply mode and deployment policy allow it.
- Each CoT request and card snapshot revalidates the task's original audience,
  source message, conversation/topic, binding epoch and access ceiling.
- A member or authorization change retires old output, requests cancellation
  through the existing execution owner, and drops pending progress. Fixed
  terminal cleanup may close only an already recorded, host-owned message.
- If the new audience can be verified, a neutral notice explains that the task
  ended. The original user can explicitly use `/resume` in a real DM. This
  starts a new authorized operation; it does not replay the old output buffer
  or automatically forward results. The new shared conversation cannot resume
  the old private binding. Returning to one human does not revive old callbacks.
- The same user's DM and solo-group session candidates can be visible within
  their UserSpace. Shared-space history remains filtered by conversation scope.
- Transport failure shows a degradation notice when delivery is still
  authorized. `/status` and the management configuration snapshot expose
  configured and negotiated effective presentation. An unavailable runtime
  leaves effective state absent, rather than guessing from stored settings.

## Ownership and deployment contract

`SpaceResourceStore` persists only opaque ownership receipts, provider IDs,
card sequence and source/epoch identifiers. It does not persist progress bodies
or credentials. Pre-create tickets let the host retain a cleanup receipt when
membership changes while a provider create is in flight. Startup recovery is
limited to this source authority and instance; it never resumes old content.
Legacy unowned CoT records are not upgraded into new authority.

The outbound policy ABI remains version 2. Its optional `progress` extension
uses version 1, declares `cot`/`card` formats, and checks the complete serialized
payload plus immutable source context before each request. A legacy plugin
without this extension keeps Team progress disabled and reports the reason.
Its `streamStrategy: final-only` and excluded **legacy raw** `cot` sink retain
their old meaning. This extension does not authorize SDK streaming callbacks.
Deployment plugins decide inspection/pass-through independently of Aria's
space authorization. A constant interrupted CoT status or neutral interrupted
card is the only payload permitted through host cleanup after revocation.
Format availability governs new content; terminal cleanup still reaches the
plugin when that format is disabled, and the plugin must explicitly approve
the fixed terminal payload. This never grants permission to resume content.

Card snapshots coalesce within an owned 500 ms window, flush terminal state,
and discard their timer/buffer on close. CoT uses its existing bounded batching.
Both operate on normalized agent events, so the lifecycle applies to supported
engines without a Codex-specific runtime topology assumption.

## Limits and validation

Roster verification is mandatory at actual delivery. The current Lark channel
SDK does not expose a generic membership-change event; the existing operation
refresh is a fallback for stopping silent work. There is no atomic transaction
between a platform roster read and sending a message: a request already
accepted by the platform cannot be unsent by this fence. Already delivered
history and already completed tool side effects are not rolled back. Other
channel adapters must supply verified audience semantics before exposing
equivalent progress capabilities.

Tests cover preserved preferences, legacy-policy downgrade, tool visibility,
late buffered output, roster/policy failure, source/topic ownership, in-flight
creation, restart receipts, card terminal/coalescing/close, and Lark intake with
real space orchestration and fake network/agent ports. Real platform acceptance
must separately exercise membership changes and native CoT rendering.
