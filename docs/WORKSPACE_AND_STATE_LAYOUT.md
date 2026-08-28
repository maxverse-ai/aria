# Workspace and state layout architecture

> Status: implementation in progress. The independent-root resolver, typed
> target path contracts, and identity-neutral managed-workspace scaffold are
> implemented. Existing state still uses the compatibility layout; physical
> migration remains an explicit later phase.

## Purpose

Aria needs two different kinds of local storage:

1. control-plane data owned by Aria, such as configuration, credentials,
   sessions, logs, locks, and runtime discovery records;
2. working directories in which agents read and modify user-owned files.

These concerns must remain separate. A working directory must not become the
implicit home of Aria runtime state, and Aria's state directory must not become
the default container for source repositories or other user projects.

This document defines a generic layout. It must not be derived from, populated
from, or coupled to the runtime data of the repository used to develop Aria.

## Goals

- Give every path a clear owner and lifecycle.
- Keep Aria state independent from agent working files.
- Make first-run initialization deterministic, idempotent, and safe.
- Support custom roots without relying on string-concatenated directory names.
- Keep the core layout independent of Claude, Codex, OpenCode, or any future
  engine.
- Preserve profile and identity isolation.
- Allow the layout to evolve through explicit, recoverable migrations.
- Make caches and ephemeral runtime files safely disposable.

## Non-goals

- Initializing Git repositories, Git identities, remotes, or credentials.
- Copying an existing project into a managed workspace.
- Pre-populating sessions, logs, caches, OAuth state, or runtime sidecars.
- Changing the user-agent-space design described in
  `USER_AGENT_SPACE_ARCHITECTURE.md`.
- Adopting platform-specific XDG directories in the first implementation. The
  logical boundaries in this document can be mapped to platform-specific roots
  later.

## Root boundary

Aria should resolve two independent roots:

```text
ARIA_HOME             control-plane configuration and state
ARIA_WORKSPACE_HOME   Aria-managed agent working directories
```

Default locations:

```text
~/.aria/
~/.aria-workspaces/
```

Resolution precedence should be explicit and consistent:

```text
CLI option > environment variable > platform default
```

`ARIA_WORKSPACE_HOME` must not be inferred by appending a suffix to the
resolved `ARIA_HOME`. A caller may place the roots on different filesystems,
back them up independently, or apply different access policies.

## Target logical layout

```text
<aria-home>/
+-- config.json
+-- active-profile
+-- layout.json
+-- helpers/
|   `-- secrets-getter[.cmd]
+-- profiles/
|   `-- <profile>/
|       +-- identity/
|       |   +-- secrets.enc
|       |   +-- keystore.salt
|       |   +-- lark-cli-source/
|       |   `-- lark-cli/
|       +-- state/
|       |   +-- sessions.json
|       |   +-- session-catalog.json
|       |   +-- workspaces.json
|       |   `-- native-read/
|       +-- engines/
|       |   `-- <engine-id>/
|       +-- cache/
|       |   `-- media/
|       +-- logs/
|       `-- run/
|           +-- runtime-control.json
|           +-- runtime-control.sock
|           `-- ui.json
+-- host/
|   +-- registry/
|   |   `-- processes.json
|   +-- locks/
|   +-- logs/
|   `-- run/
|       `-- ui.json
`-- trash/

<aria-workspace-home>/
`-- <profile>/
    `-- default/
        +-- AGENTS.md
        +-- README.md
        `-- scratch/
```

The tree is logical rather than a requirement to eagerly create every entry.
Most state, cache, log, and runtime paths should be created by their owning
component only when first used.

## Ownership and lifecycle

| Area | Owner | Lifecycle | Backup expectation |
|---|---|---|---|
| Root configuration | configuration layer | persistent | back up |
| Profile identity | credential and identity adapters | persistent, sensitive | protected backup |
| Profile state | state stores | persistent | back up when conversation continuity matters |
| Engine state | engine plugin | engine-defined | plugin-defined |
| Cache | cache owner | disposable | do not back up by default |
| Logs | logging subsystem | retention-managed | optional |
| Profile `run/` | live profile runtime | process-scoped | never back up |
| Host locks and registry | supervisor | host-runtime-scoped | never back up |
| Managed workspace | user and agent | persistent user data | back up independently |

No component may write into another component's area through an ad hoc path.
All physical paths must come from the layout resolver.

## Managed workspace contract

There are two distinct workspace modes.

### Aria-managed default workspace

When the user does not supply a working directory, Aria creates a default
workspace beneath `ARIA_WORKSPACE_HOME`. A newly created workspace receives a
small, identity-neutral scaffold:

```text
AGENTS.md
README.md
scratch/
```

The scaffold must follow these rules:

- create files only when Aria created the managed workspace;
- never overwrite an existing file;
- contain no username, profile name, app id, tenant id, absolute path, Git
  identity, repository reference, or credential;
- keep `scratch/` for disposable, non-secret material;
- remain useful for every supported engine;
- fail closed when an expected directory is a file or an unsafe symbolic link.

### User-supplied workspace

When the user passes `--workspace` or switches with `/cd`, Aria validates and
records that directory but does not scaffold, rewrite, migrate, or otherwise
modify it. Repository-local instructions remain entirely user-owned.

## Initialization contract

Initialization should be an explicit orchestration, not incidental side
effects spread across unrelated stores.

For a new installation, initialization performs only the following durable
operations:

1. resolve and validate both roots;
2. create private root and profile directories with restrictive permissions;
3. create or update root configuration atomically;
4. persist the selected active profile atomically;
5. create the profile keystore only when a secret is first stored;
6. create and scaffold a managed default workspace when no workspace was
   supplied;
7. create engine-owned directories only when requested by the selected engine
   plugin.

Initialization must not create empty session stores, logs, media caches,
registries, locks, sockets, sidecars, or native-read files. Their owners create
them lazily.

Every operation must be idempotent. Retrying after interruption must either
complete the same layout or return a precise conflict without destroying
pre-existing data.

## Path API design

The current all-in-one path object should evolve into composable typed groups:

```ts
interface AriaRoots {
  stateRoot: string;
  workspaceRoot: string;
}

interface RootPaths {
  configFile: string;
  activeProfileFile: string;
  layoutFile: string;
  helpersDir: string;
  profilesDir: string;
  hostDir: string;
  trashDir: string;
}

interface ProfilePaths {
  root: string;
  identity: ProfileIdentityPaths;
  state: ProfileStatePaths;
  enginesDir: string;
  cacheDir: string;
  logsDir: string;
  runDir: string;
}

interface ManagedWorkspacePaths {
  root: string;
  instructionsFile: string;
  readmeFile: string;
  scratchDir: string;
}
```

Path resolution must be pure: it computes paths but performs no filesystem
I/O. Creation belongs to named initializers or to the component that owns the
path.

The public resolver should accept both roots explicitly. Compatibility wrappers
may continue accepting the existing `rootDir` option while migration is in
progress, but new code must not introduce further uses of an implicitly derived
workspace root.

The compatibility `resolveAppPaths({ rootDir })` adapter intentionally preserves
the historical sibling-workspace behavior for old callers. New code should use
`resolveAriaRoots` / `resolveAriaLayoutPaths`, or pass both `rootDir` and
`workspaceRoot` explicitly.

## Engine extensibility

Core bootstrap code must not create `codex-home` or any other engine-specific
directory by name. An engine plugin should optionally declare its state needs:

```ts
interface EngineStateLayout {
  engineId: string;
  initialize(root: string): Promise<void>;
}
```

The core gives the plugin a confined root such as
`profiles/<profile>/engines/<engine-id>/`. The plugin owns everything below
that root and cannot redirect other profile state implicitly.

If user-agent spaces are implemented, an agent-space resolver can compose the
same identity, state, engine, cache, logs, and runtime categories beneath the
space root. The lifecycle categories remain unchanged.

## Security requirements

- State and workspace roots must resolve to directories and must reject `/`, a
  home-directory root, system roots, and unsafe temporary-directory roots.
- Sensitive directories use mode `0700`; secret-bearing files use `0600`.
- Atomic writes are required for configuration, identity state, and persistent
  stores.
- Initializers must not follow an attacker-controlled final-component symlink.
- Runtime tokens and socket discovery records live only under `run/` and are
  removed by the owning process when possible.
- Generated manifests and backup checksums should use relative paths so a
  directory can be restored at a different absolute location.
- No initialization log may contain secret values or private identity data.

## Layout version and migration

Filesystem layout versioning is separate from configuration schema versioning.
`layout.json` records only product-owned migration metadata, for example:

```json
{
  "schemaVersion": 1
}
```

A migration follows this sequence:

1. inspect without mutation;
2. build and validate a migration plan;
3. acquire the host and affected profile locks;
4. stage moves on the same filesystem where possible;
5. atomically update configuration and the layout marker;
6. verify every destination and critical file permission;
7. remove empty legacy directories only after verification;
8. roll back staged moves if any required step fails.

Migration must never move user-supplied workspaces. Existing managed
workspaces may remain at their configured absolute path; adopting the new
workspace root is an explicit operation, not a startup side effect.

The first release containing the new resolver should preserve reads from the
legacy flat profile layout. Removal of legacy support requires a later release
and explicit migration coverage.

## Implementation sequence

### Phase 1: contracts and behavior-preserving path refactor

- [x] Introduce `AriaRoots` and the typed path groups.
- [x] Add explicit workspace-root resolution.
- [x] Keep all existing physical paths unchanged through compatibility mapping.
- [x] Add path contract tests for Linux, macOS-compatible POSIX, and Windows forms.

### Phase 2: managed workspace initializer

- [x] Add static, identity-neutral templates to the compiled package.
- [x] Add an idempotent initializer with no-overwrite semantics.
- [x] Invoke it only for newly created Aria-managed default workspaces.
- [x] Keep explicit user workspaces unchanged during bootstrap.

### Phase 3: lifecycle separation

- Move engine-specific initialization behind engine plugins.
- Group persistent state, cache, logs, and ephemeral runtime paths in the API.
- Ensure every store lazily creates only its own parent directories.

### Phase 4: physical layout migration

- Add `layout.json` and the legacy-layout detector.
- Implement plan, lock, stage, verify, commit, and rollback behavior.
- Migrate profile data only; do not relocate user project directories.

### Phase 5: documentation and compatibility cleanup

- Update the data-directory tables and environment-variable reference.
- Correct stale keystore path comments and CLI help.
- Document backup, restore, and rollback behavior.
- Remove compatibility code only after the supported migration window.

## Test requirements

The implementation is not complete without tests for:

- an exact fresh-install tree in a temporary root;
- separate custom state and workspace roots;
- repeated initialization producing no changes;
- preservation of pre-existing files;
- file, permission, and symbolic-link conflicts;
- explicit workspaces receiving no scaffold files;
- atomic-write failure and retry behavior;
- all registered engine plugins using confined engine state roots;
- legacy-layout detection, successful migration, and rollback;
- runtime cleanup without deletion of persistent state;
- absence of machine-specific paths and identities in templates.

Tests must use isolated temporary roots. They must never inspect, copy, mutate,
or infer defaults from the developer's live `~/.aria` or workspace contents.

## Acceptance criteria

The architecture is ready to leave compatibility mode when all of the
following are true:

- state and workspace roots are independently configurable;
- core path resolution contains no engine-specific directory names;
- managed workspace initialization is safe and idempotent;
- explicit user workspaces are never modified by initialization;
- every path has one documented owner and lifecycle;
- runtime-only data can be deleted without losing configuration, credentials,
  sessions, or user files;
- migration is tested with rollback and preserves existing configured
  workspace paths;
- documentation and CLI help describe the physical layout accurately.
