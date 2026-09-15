# Deployment-selected Space navigation

Additive deployment-wide capabilities and versioned host adapters are described
in [space-public-capabilities.md](space-public-capabilities.md). Common rules
preserve existing business selection, opt-outs, user edits and native history.

Business navigation, resource locations and skill files belong to the deployment.
Aria installs a short entry and lazy indexes before an authorized run. Status and
queries do not install anything. The entry is limited to 20 lines / 2048 bytes.

`space-control/workspaces.v1.json` supports optional `defaults` alongside existing
`bundles` and exact `assignments`. Each default names one `authorityId`, one Space
kind (`user` or `shared`) and a bundle. Unknown authorities and personal/default
Spaces do not match. Duplicate selectors are rejected. An exact assignment wins;
`bundle: null` explicitly opts a Space out of defaults. Defaults never admit users,
grant filesystem access, copy private histories, or infer policy from AGENTS.md.
Keep a common project bundle separate from a user's explicit skill bundle.

Definitions are immutable for a running profile. Change them only through the
deployment's stopped-profile lock, retain the prior definition and restart the
profile. Existing authorized Spaces then reconcile before their next run; future
matching Spaces initialize before their first run. Native skill discovery remains
an engine responsibility. Provisioned files alone are not native discovery proof.

For explicit operator backfill, `prepareSelectedSpaceWorkspaces` acquires the same
exclusive profile lock as the runtime. It uses persisted Space keys and only
physically existing workspaces. It preflights all plans, then reconciles each Space
through its existing transaction journal. A filesystem failure can leave some
Spaces completed; inspect status and repeat after resolving the failure. It never
starts an engine, creates synthetic user authorization, or sends a message.
It does not create an unused future Space just because its assignment exists.

User AGENTS.md edits, historical reports, native sessions, and pre-existing skills
are preserved by the normal managed-file rules. Rollback installs the previous
definition under the same lock and runs backfill again; only managed unchanged
files are reverted, and originally adopted files retain their baseline contents.
