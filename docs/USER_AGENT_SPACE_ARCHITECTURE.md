# Archived: User Agent Space proposal

> Status: archived — historical proposal, never implemented. Its design direction is superseded by the channel- and engine-neutral [Execution space architecture](EXECUTION_SPACE_ARCHITECTURE.md). [Phase 1](EXECUTION_SPACE_DELIVERY_PLAN.md) delivers the new architecture and implementation plan only; user-space routing is not shipped.

Aria currently owns one engine runtime per profile. Group and direct-message
traffic for that profile use the same profile runtime; there is no
`AgentSpaceKey`, per-user App Server registry, `agent-spaces/` storage layout,
or per-space OAuth/session routing in the codebase.

The earlier proposal explored one shared group runtime plus one isolated
runtime per direct-message user. It was archived because it introduced a new
identity, process, storage, and credential-isolation boundary unrelated to the
configuration-management work that actually shipped.

The replacement decision covers trusted routing, exclusive human-agent groups,
runtime ownership across all engines, state and credential isolation, session
keys, resource limits, migration, and rollback. It preserves personal mode as
the default and makes the new team behavior an explicit adoption.

The current management control plane and workspace layout do not themselves
implement this decision. Use the replacement architecture for target semantics
and its delivery plan for implementation status; do not resume the historical
App-Server-only phases independently.

The full historical proposal remains available in Git history.
