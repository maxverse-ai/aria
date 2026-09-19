# Aria docs site

[Fumadocs](https://fumadocs.dev) (Next.js) site that publishes the markdown
documents in [`../docs`](../docs). The `docs/` directory remains the single
source of truth — `scripts/sync-docs.mjs` generates `content/docs/` and
`content/blog/` on every `dev`/`build`, rewriting in-repo links (`.md` →
`/docs/<slug>`, source files → GitHub URLs).

Publishing rules (see `docs/DOCUMENTATION_POLICY.md`):

- `/docs` shows only documents whose `> Status:` role is `current` and whose
  filename is not an internal class (ledger, delivery plan, handoff,
  implementation/phase/completion record). Withheld documents 404 on the
  public site but stay in the repo; links to them become GitHub URLs.
- `docs/releases/**` and `docs/blog/**` are published under `/changelog` as the
  release-notes section, newest first. `/blog` 308-redirects to `/changelog`.
- `NAME.md` is the English source, `NAME.<locale>.md` its translation
  (e.g. `STEERING.zh.md` → `/zh/docs/steering`). English is the default
  locale and stays unprefixed; Chinese lives under `/zh`. Pages without a
  translation fall back to English content.

Sidebar navigation is generated, not hand-maintained: the `SECTIONS` table at
the top of `scripts/sync-docs.mjs` maps published slugs to the
Getting started / Guides / Reference / Internals separators written into
`meta.json` (and the localized `meta.zh.json`). A published doc that is not
listed in `SECTIONS` lands under Internals through the `...` rest marker, so
engineering specifications need no entry; user-facing docs should be added to
their section explicitly. Listing an unpublished slug emits a build warning.

`docs/CLI_REFERENCE{,.zh}.md` are generated from `src/cli/index.ts` by
`scripts/gen-cli-reference.mjs` (`pnpm gen:cli-reference`, or `--check` to
verify freshness — `tests/unit/docs/cli-reference.test.ts` runs it in CI).
Never hand-edit those two files.

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

## ai.***REMOVED***dev.com deployment

The site is served at `https://ai.***REMOVED***dev.com/docs` on the ***REMOVED***
host. The Cloudflare tunnel sends `ai.***REMOVED***dev.com` to the `chord`
container's nginx (port 4173, formerly the `***REMOVED***` container — it carries the
`***REMOVED***` network alias), which proxies the docs routes to the `aria-docs`
container on the `***REMOVED***-net` docker network.

Redeploy after `docs/` or site changes:

```bash
pnpm install && pnpm build
docker build -t aria-docs .
docker rm -f aria-docs
docker run -d --name aria-docs --network ***REMOVED***-net --restart unless-stopped aria-docs
```

The front-door nginx must keep these proxy blocks pointing at
`http://aria-docs:3000` (public paths mirror the app's own routes — no
`basePath` is used): `=/docs`, `/docs/`, `/_next/`, `=/api/search`, `/og/`,
`=/llms.txt`, `=/llms-full.txt`, `/llms.mdx/`. They live in
`/etc/nginx/conf.d/default.conf` inside the `chord` container today; if that
container is rebuilt from scratch, re-add the blocks (or bake them into its
image config) or the docs go dark. `=/api/search` is an exact match so it
does not shadow the app's own `/api/` proxy.

Do not edit `content/docs/` or `lib/generated/` — both are generated and
gitignored.
