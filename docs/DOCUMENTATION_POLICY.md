# Documentation policy

> Status: current — governs every document under `docs/` and the two READMEs.

Documentation drifts because nothing distinguishes a description of the present
from a record of the past, and because the same fact is restated in several
places. These rules exist to make the difference visible and the drift
detectable.

## Roles

A document has exactly one role, expressed by its filename.

| Role | Filename | Rule |
| --- | --- | --- |
| Current specification | `*-ARCHITECTURE.md`, `*-POLICY.md`, `*_POLICY.md`, `PLUGINS.md`, `TOOLCHAIN.md`, a channel or runtime guide | Must describe what is true today. Update it with the change that invalidates it. |
| Active runbook | `*_HANDOFF.md`, `*-DELIVERY_PLAN.md` while it still has open items | Kept current while work remains; names the exact command or commit to run next. |
| Historical record | `*-DELIVERY_PLAN.md` once complete, `*-IMPLEMENTATION.md`, `*-PHASE*.md`, `*-COMPLETION.md`, `release-linux-*`, `releases/**` | Frozen. Never edited to match later reality. |
| Ledger | `bug-ledger.md` | Append-only. Entries are not rewritten; corrections are new entries. |
| Archived | any file titled `Archived: …` | Superseded. Kept for provenance only. |

## Status header

Every document except a release note carries one status line directly under its
title:

```markdown
> Status: <role> — <evidence>
```

`<role>` is one of `current`, `in progress`, `historical`, `archived`. For a
current specification the role is the whole claim: it asserts that the document
describes the present, and it is falsified by the change that invalidates it.

Every other role carries an `<evidence>` that must be checkable: a version, a
commit, a command, or a test that passes. "Working on it" and "mostly done" are
not evidence.

Do not write a status the reader cannot verify. If a claim cannot be checked,
say what would check it.

## Single sources of truth

Restating a fact that changes is how documents come to contradict each other.
Each of these facts is defined in exactly one place; documents reference the
definition instead of copying it.

| Fact | Defined by |
| --- | --- |
| Package version | `package.json` |
| Authorized release line, patch policy | `.release-policy.json` |
| Build and CI runtime | `.node-version` |
| Supported runtime floor | `package.json#engines.node` |
| Supported CLI surface | `src/cli/index.ts` (and `aria <command> --help`) |
| Required validation gates | `package.json` scripts, run by `.github/workflows/ci.yml` |

When a document must state one of these, state it as a reference — for example
"the runtime pinned in `.node-version`" — or name the version and note that the
file is authoritative.

## Localization

`NAME.md` is the English source; `NAME.zh.md` is its Chinese translation, and
the pair is linked by the header pointer lines (`> 中文版:` /
`> 本文是 … 的中文版` / `> English version:`), which the site strips from
rendered output.

User-facing documents — the Getting started, Guides, and Reference sections
of the site, plus every release note under `docs/releases/**` — carry a
Chinese translation; the contract test fails on a release note that lacks
one. Engineering specifications under Internals are English-only by policy:
they address maintainers, and translating them costs more than it returns.

## Reachability

Every document under `docs/`, except a release note, is reachable: linked from
the README documentation table, from `AGENTS.md`, or from another document.
An unreachable document is either linked or removed.

## Enforcement

`tests/unit/docs/documentation-contract.test.ts` holds the mechanical part of
this policy: status headers, reachability, internal links, and README
structure. A rule that is not enforced here will drift again.
