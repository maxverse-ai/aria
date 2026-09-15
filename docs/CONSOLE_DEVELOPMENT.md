# Console development preview

The browser console can run independently from the production Supervisor so
frontend iteration never restarts the Lark bridge or interrupts agent runs.
The preview and packaged console use the same source under `web/`.

## Start a read-only preview

Run this from an isolated development workspace, not an installed runtime:

```sh
ARIA_WEB_PREVIEW_BASE=/aria-dev/ \
ARIA_WEB_PREVIEW_PORT=5174 \
ARIA_WEB_PREVIEW_API_TARGET=http://127.0.0.1:5274 \
ARIA_WEB_PREVIEW_PUBLIC_ORIGIN=https://console.example.com \
pnpm exec vite web
```

The API target must be a loopback HTTP origin. Preview API requests are
read-only by default: non-GET/HEAD requests receive `405` before reaching the
upstream. If no API target is configured, API requests fail closed with `503`.

An authenticated reverse proxy may mount the development server below the
configured base path. It must preserve WebSocket upgrades for Vite HMR and may
inject the private `X-Ui-Token` header server-side. Never put the token in the
browser URL, Vite source, or repository configuration.

## Test mutations safely

Configuration, lifecycle, OAuth, and other write flows require a separate Aria
home and a dedicated development Lark application. Point the preview at that
isolated loopback backend, then opt in explicitly:

```sh
ARIA_WEB_PREVIEW_API_MODE=write \
ARIA_WEB_PREVIEW_WRITE_CONFIRM=isolated-development-backend \
pnpm exec vite web
```

Do not enable write mode against a production Supervisor.

## Package the same frontend

The normal production build remains unchanged:

```sh
pnpm build:web
```

It writes one self-contained `src/ui/generated/index.html`, which the Aria CLI
bundle embeds. There is no copy or merge step between preview and production.
