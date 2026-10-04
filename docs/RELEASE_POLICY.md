# Aria release policy

> Status: current

Aria uses Semantic Versioning. Humans authorize a release line; automation may
advance only the patch component on that line.

The machine-readable policy in `.release-policy.json` is the source of truth for
the currently authorized line. This document defines how that policy is used.

## Authority

| Change | Default authority |
| --- | --- |
| `PATCH` (`0.1.1` → `0.1.2`) | Automated on the authorized release line |
| Prerelease counter (`rc.1` → `rc.2`) | Automated on the authorized release line |
| `MINOR` (`0.1.x` → `0.2.0`) | Explicit human authorization |
| `MAJOR` (`0.x` → `1.0.0`) | Explicit human authorization |
| Prerelease → stable | Explicit human authorization |

For `0.x`, a MINOR change is treated as a release-line change and therefore
requires human authorization. An agent may recommend a new line but must not
authorize it, edit `stableLine`, or publish it on its own.

Human authorization must be durable. This repository cannot use protected
branches, rulesets, or environment reviewers — the GitHub API answers "Upgrade
to GitHub Pro" for a private repository on this plan, and the required-status
check list is empty, so a failing check cannot refuse anything. The durable
record is therefore the release commit itself: a release that advances the
release line must carry `Authorized-Release-Line: <new line>` in its exact
commit message, and the release workflow fails closed without it. A statement
copied from chat is not a durable authorization record.

If the repository is ever moved to a plan with protected environments, approval
through one can be added as a second signal; it does not replace the recorded
line.

## Automatic patch eligibility

An automated patch release is eligible when all of the following are true:

1. The changes are merged into `origin/main`.
2. They are backward-compatible fixes, security fixes, performance or
   reliability improvements, or user-visible corrections.
3. The policy is not frozen and `patchMode` is `automatic`.
4. The target version is exactly the next patch on `stableLine`.
5. Diff checks, the full test suite, typecheck, build, and package inspection
   pass on the exact commit to be released.
6. The Git tag and registry version do not already exist.

Documentation-only, test-only, formatting, comment, and CI-only changes do not
normally trigger a package release. They ride with the next eligible release.

Ordinary patches use `batchWindowMinutes` to coalesce nearby changes. Security
patches may use `securityPatchMode: immediate`, but they do not bypass validation.

## Stop conditions

Automation must stop and request human direction when a change adds or removes a
public command, changes configuration semantics or defaults, changes security or
identity behavior, removes an existing capability, may break compatibility, or
cannot be classified confidently.

It must also stop on a dirty worktree, a non-main release commit, failed gates,
version or tag collision, stale remote state, concurrent release, or missing
protected-environment approval.

## Commands

The policy tools are intentionally read-only. They plan and verify versions but
do not edit files, create tags, or publish packages.

```bash
pnpm release:check
pnpm release:check -- --base-ref origin/main
pnpm release:plan -- --level patch
pnpm release:verify -- --from 0.1.1 --to 0.1.2
```

CI supplies the pull-request base or previous push commit to `release:check`.
The check compares both `package.json` and `.release-policy.json` with that base,
so an unauthorized release-line change cannot pass merely by editing both files.

For MINOR, MAJOR, or stable-promotion verification, an approved job may inject
`ARIA_RELEASE_HUMAN_AUTHORIZED=true` instead of recording the line in the commit.
Agents must not set that variable to manufacture authorization.

Both read the same rule. `ci.yml` compares against the previous commit and can
only redden a run, so it reports an unauthorized line change;
`.github/workflows/release.yml` runs the action that produces a
published artifact, so it refuses to perform one.

## Publishing architecture

When package publication is enabled, it must be implemented as a single-writer
GitHub Actions job with a concurrency group. The job must fetch full history and
tags, rerun all gates, call `release:verify`, build from the merged `origin/main`
commit, ensure the tag and registry version are unused, publish, then verify the
published artifact. npm credentials must exist only in the protected workflow.

Where the plan allows it, repository settings should require human review for
changes to `.release-policy.json` and for the environment used by MINOR, MAJOR,
and stable-promotion releases. On the current plan neither is available, so the
recorded release line is the only durable authorization signal.

## Retired internal channel

Aria previously shipped private snapshots as immutable GitHub prereleases
tagged `internal-v<VERSION>`. That channel has been retired and its releases
deleted; public distribution uses `v*` GitHub Releases through the workflow
described below. The `internal-v*` tag prefix is no longer produced and
existing installations on that channel receive no further updates.

## Trusted GitHub Release workflow

`.github/workflows/release.yml` is the only supported publication entry point.
It exposes two explicit operations:

- `prepare_patch` queries Git tags and GitHub Releases, calculates exactly one
  PATCH, updates only `package.json`, and opens an auto-merge release pull
  request. For the first publication it keeps the already committed version and
  reports that it is ready instead of inventing another version.
- `publish_current` runs in the protected `release-production` environment. It
  accepts only the exact `origin/main` commit, reruns every gate, builds and
  verifies the candidate, prepares the release contract assets (tarball,
  `manifest.json`, `SHA256SUMS`, `release.json`, `aria-install.mjs`), rejects
  tag or release collisions, and publishes a `v<VERSION>` GitHub release whose
  notes come from `docs/releases/v<VERSION>.md`. It then verifies the published
  release is non-draft, non-prerelease, complete, and marked `immutable`.

Repository-level Release immutability is mandatory: the workflow verifies the
published release's `immutable` API field and fails closed when the protection
is not enabled. Consumers ignore drafts, prereleases, incomplete asset sets,
and tags outside `v*`.

The workflow uses a single non-cancelling concurrency group. Local
`npm publish` is rejected by `prepublishOnly`; the publish command additionally
checks the repository, branch, workflow identity, and protected-job marker.
These checks are defense in depth—the `release-production` environment and the
recorded release line remain the actual authorization boundary.
