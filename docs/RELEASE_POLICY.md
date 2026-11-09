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
commit message, and the local publisher fails closed without it. A statement
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
version or tag collision, stale remote state, concurrent release, or missing release authorization.

## Host-local publication

CI/CD is disabled and there is no restoration plan. All validation, builds,
packaging, publication and downloaded-asset verification run on the host with
its authenticated `gh`. GitHub hosts source, pull requests and immutable Release
assets, not the release executor. Do not enable workflows, provision runners,
impersonate Actions through environment variables, or invoke `npm publish`.

`pnpm release:plan` inspects the next version against local tags and published
GitHub Releases; `release:status` remains an alias. `pnpm release:preflight`
performs read-only checks of the toolchain, canonical origin, current GitHub
identity and push permission, release immutability, clean exact remote-main
checkout, remote target collisions and prepared bilingual notes. It does not
switch accounts, modify channel bindings, install tools or fetch refs. Use the
intended authenticated `gh` environment; missing authentication fails explicitly.
On Windows, invoke scripts through `corepack.cmd pnpm` or `pnpm.cmd` when
PowerShell execution policy blocks `.ps1` shims.

`pnpm release:prepare` prepares
exactly one patch in a clean task branch; commit version and bilingual release
notes, validate and integrate them before publication. The release line remains
controlled by `.release-policy.json`; do not change it without explicit human
authorization recorded in the release commit.

Run focused tests while editing, then form the complete commit, synchronize the
task branch with main and run the integration gates before pushing. Avoid an
extra full gate run on the same uncommitted contents. Publication still reruns
all gates on the exact merged commit; validation is not reused across commits.

`pnpm release:publish` is the supported single-writer local publication entry
point. It must:

1. Reject CI execution, validate the expected repository origin and `gh` access,
   acquire an exclusive lock shared by linked worktrees, fetch main and tags,
   and require a clean checkout at the exact latest `origin/main` commit.
2. Run `release:validate` (diff, [formal models](FORMAL_VERIFICATION_POLICY.md),
   toolchain, policy, build, full tests, typecheck,
   worker packaging and verification), then package the already-built output
   and inspect the package and standalone worker
   on that exact commit. Candidates are not releases and must not be pinned by
   consumers as if they were published assets.
3. Verify the next authorized version, bilingual notes, manifests, checksums,
   and absence of a remote tag or release collision. Recheck remote main before
   publication; never overwrite an existing version or asset.
4. Upload a draft with the complete eight-asset contract, download and compare
   every asset, then publish the verified draft as a stable release.
5. Verify the published tag resolves to the tested commit, the release is not
   draft or prerelease and reports `immutable: true`. Release immutability must
   be enabled. Consumers must not advance until downloaded assets verify.
6. Release the local lock on success or failure. Leave an incomplete draft
   explicitly identified for inspection; never represent partial publication
   as success or silently overwrite/delete it on retry.

The publisher builds once before running tests against the generated console;
it does not invoke `pretest` or the independently useful `artifact:build` script,
both of which would rebuild. The standalone scripts retain their original
behavior. Stage start, outcome and elapsed time are written to stderr and to
`<git-common-dir>/aria-releases/<version>.jsonl`. Detailed child command output
remains on the calling terminal and can be redirected to a separate log.

## Interrupted publication

After successful exact-main validation and asset preparation, the publisher
atomically saves `<git-common-dir>/aria-releases/<version>.json`. It records the
repository, version, full commit, Node/pnpm versions, platform, architecture,
rendered-notes digest, all eight asset names/sizes/digests, stage and Release ID
when known. These local records contain no credentials and survive task branches.

Use `pnpm release:resume` from the original clean checkout with the original
`artifacts/` directory to explicitly reconcile an interrupted publication. It
requires the same exact current main commit, toolchain and unchanged asset bytes;
it does not skip gates for a different commit or rebuild changed inputs.
Keep that workspace until publication and verification complete.

Recovery queries actual GitHub state before creating anything. It adopts only
the matching target commit and tag, uploads only missing assets without
overwriting, rejects unexpected or conflicting assets, downloads and hashes all
assets, rechecks main and the draft, and then publishes. A timeout after a
successful create, upload or publish is resolved by the next explicit resume,
not by blindly repeating the write. Already published releases must be stable,
immutable and complete; recovery downloads their assets and verifies the tag
without publishing again. A changed main, changed local artifact, conflicting
draft or failed gate requires inspection; never delete a session or overwrite
remote assets merely to bypass a failure.

Missing assets are uploaded in one `gh release upload` invocation. A partial
batch failure is reconciled on resume; existing assets are never overwritten.
Once the Release ID is known, inspections query that ID rather than listing all
releases. Creation-time discovery still uses the paginated list so a successful
creation followed by a client timeout can be recovered.

All assets are downloaded and hashed before publication. The verified remote
asset IDs, names, sizes, SHA-256 digests, upload states and update timestamps are
checked again before publishing. When complete identity metadata is available
and unchanged, the second download is avoided; changed identity stops publication.
Missing identity metadata retains the second full download. Verification evidence
is scoped to one invocation; resume always downloads again. Logs separately time
release inspection, batch upload, download/hash, main/tag checks, publication and
final tag verification.

The retired `internal-v*` snapshot channel remains unsupported. Public
consumption uses immutable `v*` GitHub Releases. Local npm publication is not a
supported distribution path.
