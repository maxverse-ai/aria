# Aria toolchain

Aria's toolchain has two goals: make local and CI validation reproducible, and
ensure that the package being inspected is the exact package later consumed by
release or deployment automation.

## Runtime baseline

- `.node-version` pins the preferred build runtime.
- `package.json#engines` remains the supported runtime floor.
- `package.json#packageManager` pins pnpm 12.0.0; use Corepack rather than a
  separately installed global pnpm.
- `pnpm-workspace.yaml#allowBuilds` is the reviewed allowlist for dependency
  lifecycle scripts.
- CI validates the supported Node 20 floor across Linux, macOS, and Windows. The
  package artifact is built with the pinned runtime.

Run the local prerequisite check with:

```bash
corepack pnpm infra:doctor
```

The doctor fails on an unsupported Node version, a mismatched pnpm version,
missing Git or `tar`, or a missing frozen lockfile. A supported Node version that differs
from `.node-version` is reported as a warning rather than a failure so the Node
20 compatibility lane remains valid.

## Standard validation entry points

```bash
corepack pnpm check       # fast local feedback
corepack pnpm ci:local    # complete pre-integration gate
corepack pnpm ci:platform # complete CI gate
```

Agents and maintainers should call these entry points instead of reconstructing
their own command chains.

## Candidate artifact

Build one candidate tarball and its manifest with:

```bash
corepack pnpm artifact:build
corepack pnpm artifact:verify
```

`artifact:build` performs the production build once, then creates an
npm-compatible tarball from the declared package files without invoking package
lifecycle scripts, so packing cannot silently rebuild different bits. It writes
the following ignored outputs under `artifacts/`:

- the npm package tarball;
- `manifest.json`, containing package version, exact Git commit, Node and pnpm
  versions, platform, package file inventory, and SHA-256 digest.

The build refuses a dirty worktree by default. This protects the commit-to-bits
relationship. `artifact:verify` checks the manifest and digest, installs the
tarball into an isolated temporary directory, and runs the packaged `aria
--version` command. It never reads credentials or modifies an installed Aria.

CI uploads this as a candidate artifact only after the platform matrix passes.
It is not a release. The protected release workflow repeats the exact-commit
gates, builds this candidate once, verifies it, and passes the same tarball to
the guarded publisher. It never runs `npm publish` against the source directory.

The private internal-release workflow uses the same candidate format, adds a
`SHA256SUMS` file, and attaches all three files to a draft GitHub release before
publishing it as a prerelease. This records an immutable internal snapshot
without interacting with the npm registry.

## Release boundary

Version authority remains defined in `docs/RELEASE_POLICY.md`. Candidate
artifact creation does not change versions, create Git tags, publish npm
packages, install Aria, or restart a daemon.
