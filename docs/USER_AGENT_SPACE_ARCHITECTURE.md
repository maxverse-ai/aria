# Archived: User Agent Space proposal

> Status: never implemented, not on the active roadmap, and not a dependency of
> the management control plane or workspace layout.

Aria currently owns one engine runtime per profile. Group and direct-message
traffic for that profile use the same profile runtime; there is no
`AgentSpaceKey`, per-user App Server registry, `agent-spaces/` storage layout,
or per-space OAuth/session routing in the codebase.

The earlier proposal explored one shared group runtime plus one isolated
runtime per direct-message user. It was archived because it introduced a new
identity, process, storage, and credential-isolation boundary unrelated to the
configuration-management work that actually shipped.

Reconsidering per-user runtimes requires a new architecture decision covering
trusted routing, process ownership, state and OAuth isolation, session keys,
resource limits, migration, and rollout. It must not be inferred from
[`CONTROL_PLANE.md`](CONTROL_PLANE.md) or
[`WORKSPACE_AND_STATE_LAYOUT.md`](WORKSPACE_AND_STATE_LAYOUT.md).

The full historical proposal remains available in Git history.
