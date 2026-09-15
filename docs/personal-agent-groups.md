# Personal agent groups

> Status: current

A personal profile managed by an Aria Supervisor automatically admits explicitly
mentioned messages in a group with exactly one human and at least two agents when:

- A complete, fresh provider roster identifies every member, including this bot.
- The human is this profile's verified runtime owner or configured administrator.
- Every bot is an authenticated, currently connected channel in the same
  Supervisor and Feishu/Lark domain.
- The sender's provider identity matches that human or another participating bot.

No `/invite group` is needed for these groups. `/status` explains whether automatic
admission is available. Explicit mentions still select the responding agent; the
one-human/one-bot addressing rule is unchanged. Bot messages do not acquire
administrator privileges.

The trust registry is owned by the Supervisor, populated after channel connection,
and removed on disconnection. It never trusts display names, message text, arbitrary
roster membership, or configuration claims about external bots. Bots in another
Aria process or external platform are not automatically trusted by this first
implementation. They retain the existing manual group access workflow.

Automatic admission does not add `allowedChats` entries. Its opaque audience proof
travels with queued input, is rechecked before starting the model, and is rechecked
after the final history check immediately before publishing. New humans, unknown
bots, disconnected peers, revoked administrator/owner authority, or incomplete
roster evidence prevent continued automatic admission. Automatically admitted input
stays queued instead of steering an active run with a different audience proof.
These runs use the existing cooperative final-only reply path and structured
handoffs, so intermediate model output is not streamed to a changing audience.

Existing manually enabled groups and team execution spaces retain their current
policies. Automatic admission grants IM usage only; it does not change engine tool
permissions, user OAuth credentials, execution-space bindings, or cross-agent task
authorization. Existing cooperative reply and freshness checks still apply.

`/invite group` remains an explicit persistent group grant. `/remove group` removes
that persistent grant; it is not a deny rule and does not override automatic
eligibility (just as it does not revoke the existing owner/admin bypass).
