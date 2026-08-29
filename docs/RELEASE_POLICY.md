# Aria release policy

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

Human authorization must be durable: a reviewed change to
`.release-policy.json` and, for a publishing workflow, approval through a
protected GitHub Environment. A statement copied from chat is not a durable
authorization record.

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

For MINOR, MAJOR, or stable-promotion verification, the protected release job
must inject `ARIA_RELEASE_HUMAN_AUTHORIZED=true` after human approval. Agents
must not set that variable to manufacture authorization.

## Publishing architecture

When package publication is enabled, it must be implemented as a single-writer
GitHub Actions job with a concurrency group. The job must fetch full history and
tags, rerun all gates, call `release:verify`, build from the merged `origin/main`
commit, ensure the tag and registry version are unused, publish, then verify the
published artifact. npm credentials must exist only in the protected workflow.

Repository settings must require human review for changes to
`.release-policy.json` and for the protected environment used by MINOR, MAJOR,
and stable-promotion releases.

## Private internal GitHub snapshots

Internal snapshots are private repository records, not npm publications. They
use the package version already reviewed on `main`, an `internal-v<VERSION>` tag,
and an immutable GitHub prerelease with a verified tarball, artifact manifest,
checksum file, release contract, and standalone installer.

`.github/workflows/internal-release.yml` is the only supported entry point. It
accepts only the exact current `origin/main` commit, reruns all gates, builds and
verifies the candidate, creates a draft release, verifies all assets, and only
then publishes it as a prerelease. It has no npm credentials or OIDC permission
and never invokes `npm publish`.

Repository-level Release immutability is mandatory. The workflow verifies the
published release's `immutable` API field and fails closed when the protection
is not enabled. Consumers ignore drafts, mutable releases, incomplete asset
sets, and tags outside `internal-v*`.

Internal tags deliberately do not match `v*`, so they remain outside the npm
tag/registry consistency checks. Internal versions are immutable: corrections
advance the package PATCH version and create a new internal snapshot rather than
overwriting a tag or release.

## Trusted npm release workflow

`.github/workflows/release.yml` is the only supported npm publication entry point.
It exposes two explicit operations:

- `prepare_patch` queries Git tags and npm, calculates exactly one PATCH, updates
  only `package.json`, and opens an auto-merge release pull request. For the
  first publication it keeps the already committed version and reports that it
  is ready instead of inventing another version.
- `publish_current` runs in the protected `npm-production` environment. It
  accepts only the exact `origin/main` commit, reruns every gate, builds and
  verifies the candidate, rejects tag or registry collisions, publishes with
  npm trusted publishing, verifies the registry result, and finally creates the
  matching annotated Git tag. It refuses the first-ever package publication
  because npm cannot configure a trusted publisher until the package exists.

The first publication is a one-time bootstrap. A human maintainer must run the
release gate against the exact `origin/main` artifact, publish that tarball
interactively with 2FA, verify it in the registry, and create the matching
annotated tag. Only then should the maintainer configure trusted publishing and
enable `publish_current`. Do not store a bootstrap token in GitHub Actions.

The npm trusted publisher must be configured for repository
`maxverse-ai/aria`, workflow filename `release.yml`, environment
`npm-production`, and the `npm publish` action. The environment should require
review for the initial publication and any human-authorized release-line
change. After trusted publishing works, revoke legacy automation publish tokens.

The workflow uses a single non-cancelling concurrency group. Local
`npm publish` is rejected by `prepublishOnly`; the release command additionally
checks the repository, branch, workflow identity, protected-job marker, and
GitHub OIDC availability. These checks are defense in depth—the registry's OIDC
trust policy remains the actual credential boundary.
