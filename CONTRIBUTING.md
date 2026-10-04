# Contributing to Aria

Thanks for your interest in contributing. This repository has a few
conventions that keep reviews small and history clean.

## Before you start

- Open an issue using the contribution template under
  `.github/ISSUE_TEMPLATE/` before writing code. Keep one independently
  reviewable problem or change per issue.
- Read `AGENTS.md` — it is the repository's source of truth for working
  rules: worktree/branch discipline, release invariants, and documentation
  policy.

## Making changes

- Work on a branch or fork. Keep pull requests narrowly scoped — no
  unrelated refactors, formatting, generated files, or dependency updates
  unless the issue requires them.
- `site/content/` is generated; edit `docs/` instead.
- Never commit credentials, tokens, private paths, or personal data.

## Validation

Run the repository gates before opening or updating a pull request:

```bash
pnpm install
pnpm check        # diff check + infra doctor + release check + typecheck + unit tests
```

`pnpm build` compiles the CLI bundles; `pnpm test:unit` runs the unit suite
alone. The full `ci:local` script is the definitive gate.

## Pull requests

Use the pull request template, link the issue, and make sure the branch is
synchronized with the latest `origin/main` with all gates passing.

## License

By contributing, you agree that your contributions are licensed under the
repository's MIT license.
