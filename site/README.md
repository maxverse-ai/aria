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
