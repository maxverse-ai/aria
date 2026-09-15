# Deployment public capabilities

Common capability assets are additive: matching `common` bundles, then the
explicit/default business bundle, with pre-existing user edits preserved by
the existing workspace receipt/journal. `assignments[].bundle: null` opts out
of business defaults, not common capabilities. Duplicate skill/resource names
and incompatible tool revisions fail before installation. Rules select an
explicit authority and `user` or `shared` kind; they never admit a user or
change an audience binding.

`workspaces.v1.json` may declare `extensions` with `{id, revision, module,
sha256}`. These are operator-installed ES modules, not model-selected plugins.
They require the already-prepared trusted-process or execution native tool transport.
The entry must be a non-symlink, non-group/world-writable `.mjs` file with the
declared hash. Its dependencies must be pinned in the deployment image too.
It exports `spaceToolRevision` and `createSpaceTool(host)`, returning the public
`SpaceNativeTool` contract. Startup rejects missing, stale or invalid adapters.

Bundles bind instructions to exact `requiresTools: [{id, revision}]` versions.
Workspace plans report missing revisions separately from native skill
discovery. Only Spaces whose selected layers require an extension receive its
per-turn invocation entry. The existing gate checks identity, membership,
binding, cwd and ticket expiry, with no ambient-account fallback. Declarations
contain no credentials. The module hash is an integrity check, not a sandbox.

The extension host supplies a private control directory, scoped credential
invocation, and `activeGate()`. Capture the originating gate during invocation;
never store a profile-wide current user. A long job must retain the existing
operation checkpoint/ledger, recheck it at execution and before sensitive I/O,
and authorize every status/report/resume/cancel by its original Space,
conversation/execution scope, actor and audience epoch. Never persist the
ephemeral turn ticket as background authority. Tool RPC remains bounded;
deployment-owned submit/status/report jobs must return promptly. `close()`
owns cancelling/draining extension work when the profile closes. Aria does not
gain a domain job queue, artifact cache, or business-specific credential store.

Long-job adapters expose `activeWork()` for the existing runtime restart/drain
preflight; invalid counters fail busy. Tool shutdown failures still dispose
engines and flush owned state. `isAdmittedAttachment(context, path)` checks
source-admitted paths, not arbitrary model paths. Trusted host credential
requests may specify a bounded deadline (up to 15 minutes); ordinary native
RPCs remain bounded and cannot set this field.

Apply a definition only under the stopped profile's existing exclusive lock,
retain its previous version, then backfill existing persisted Spaces and
restart. Future admitted Spaces reconcile on their first authorized execution.
Neither a preparation receipt nor native history is rewritten to install a
common capability. Rollback restores the previous definition and image; local
edits are never overwritten to force convergence. Native engines re-probe the
combined skill catalog after a definition revision changes. Read-only status
does not certify provider acceptance or create artificial conversations.

Core validation covers layer selection, conflicts, revision checks, user edits,
rollback, native discovery, adapter integrity, original-user IPC, closed tickets,
and adapter shutdown. Deployment acceptance must additionally exercise its
actual domain adapter and authorized platform requests; core fixtures alone
are not that evidence.

Execution deployments can explicitly declare `readonlyResources`, absolute paths
mounted at the same path in workers. Workspace bundle declarations alone do not
grant mounts. Resources cannot overlap Space state or each other, and cannot
become subprocess working roots. Controllers and managers must see the same
paths. Existing per-Space native tool endpoints carry host extensions without
exposing the manager socket.

A customized skill index containing all current managed entries is retained
verbatim. Its local additions are not adopted as managed files or distributed
to other Spaces. Removed or edited managed entries still report a conflict.
