# Aria docs site

[Fumadocs](https://fumadocs.dev) (Next.js) site that publishes the markdown
documents in [`../docs`](../docs). The `docs/` directory remains the single
source of truth — `scripts/sync-docs.mjs` generates `content/docs/` on every
`dev`/`build`, rewriting in-repo links (`.md` → `/docs/<slug>`, source files →
GitHub URLs) and grouping the sidebar by each document's `Status:` role (see
`docs/DOCUMENTATION_POLICY.md`).

## Develop

```bash
pnpm install
pnpm dev        # syncs docs, then next dev
```

## Build

```bash
pnpm build      # syncs docs, then next build
pnpm types:check
```

Deploy on Vercel with the project root set to `site/`; `pnpm build` is
self-contained.

Do not edit `content/docs/` or `lib/generated/` — both are generated and
gitignored.
