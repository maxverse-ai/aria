# Aria repository rules

## Feishu/Lark cards

- All outbound cards must use CardKit 2.0 (`schema: "2.0"` and `body.elements`). Do not use legacy root `header` / `elements` cards.
- Interactive cards must update the original managed card through `idle → loading → success/failure`; never leave “正在处理” or “正在切换” as the final state.
- Keep shared card construction and update behavior under `src/card`, with focused tests for each flow.
- Every Aria-owned callback command must be declared in `src/card/action-executor.ts` with an explicit execution mode.
- A CardKit callback must return before network, filesystem, subprocess, engine, or card-update I/O. Use the shared action executor for background work; do not add ad-hoc fire-and-forget handlers.

## Parallel agent development

- Parallel agent work is allowed, but every agent task MUST use its own Git worktree and an `agent/*` branch created from the latest `origin/main`. Agents MUST NOT edit a shared root worktree.
- Each agent owns only the files and changes required for its task. Do not stage, commit, stash, reset, delete, overwrite, or otherwise modify changes owned by another task.
- Before integrating, fetch `origin/main`, rebase the task branch onto it, and run the repository's diff, test, typecheck, and build gates after rebasing.
- For repository-owned tasks, completion means integrating the validated task commit into `origin/main` and pushing it immediately; do not stop after committing only to the task branch. The only exceptions are missing write permission, branch protection, a merge conflict, or an explicit user instruction not to push.
- If the contributor has permission to update `main`, integrate after validation with a normal fast-forward push from the task branch to `origin/main`. Force-pushing `main` is forbidden.
- If `main` changes during validation or the push is rejected as non-fast-forward, fetch, rebase, rerun the required gates, and retry the normal push.
- Merge conflicts MUST stop and be reported. Do not guess through conflicts, and do not stage, commit, stash, reset, or overwrite changes owned by another task.
- Release and deployment artifacts MUST be built from the exact merged commit, never from a development worktree.

## External contributions

- Treat a contributor as external when they do not have permission to update `main`, including when a normal push is rejected by repository authorization or branch protection. Do not change remotes, borrow credentials, bypass protection, or force-push to obtain access.
- External work MUST start with an issue created from `.github/ISSUE_TEMPLATE/contribution.yml`. Keep one independently reviewable problem or change per issue.
- Implement the accepted scope on a contributor-owned branch or fork, then open a pull request using `.github/pull_request_template.md` and link the issue.
- Keep pull requests narrowly scoped. Do not include unrelated refactors, formatting, generated files, configuration, deployment changes, or dependency updates unless the issue explicitly requires them.
- Before opening or updating a pull request, synchronize with the latest `origin/main` and rerun the repository's required validation gates.
- If the agent cannot create an issue or pull request, it MUST provide ready-to-submit issue and pull-request titles and bodies, the proposed branch name, and the validated commit identifier so a maintainer can submit them without reconstructing context.
- Never include credentials, tokens, private paths, personal data, or other secrets in issues, pull requests, commits, logs, or validation evidence.

## Release invariants

- Normal development work MUST NOT change versions, create release tags, or publish packages.
- Read `docs/RELEASE_POLICY.md` before changing a version, tag, changelog, release policy, package publication, or deployment workflow.
- PATCH releases may be automated only on the release line authorized by `.release-policy.json`; MINOR, MAJOR, and stable promotion releases require explicit human authorization.
- Agents MUST NOT change `stableLine` or set `ARIA_RELEASE_HUMAN_AUTHORIZED` unless the current task contains explicit human authorization for the exact target release line.
- Never overwrite a published version or release tag. Release artifacts MUST come from the exact tested commit on `origin/main`.

## Private fork intake

- Work from the machine-private Aria fork reaches this repository only through
  [agent-skills/private-fork-intake/SKILL.md](agent-skills/private-fork-intake/SKILL.md).
  Read it before absorbing private changes, syncing `vendor/aria`, or
  re-attributing commit history.
