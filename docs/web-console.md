# Web console

> Status: current

> 中文版：[web-console.zh.md](web-console.zh.md)

Aria's local web console manages configuration, profiles, and online bots from
a browser. It is hosted by the machine-wide **Supervisor** — one per machine —
not by the single-profile bridge process.

## Start the console

Run the Supervisor with `--web-ui`, foreground or as the background service:

```bash
aria run --web-ui       # foreground supervisor + console (hosts all profiles)
aria start --web-ui     # the same, as an OS-managed service
```

Then open it:

```bash
aria ui                 # open the console URL in your browser
aria ui --print         # print the URL instead (remote terminals)
```

`aria ui` reads the Supervisor's host-level sidecar (`~/.aria/ui.json`). If no
Supervisor is running it prints startup instructions instead of a URL — a
plain `aria run` / `aria start` is a single-profile headless run with no
console.

## Security defaults

The console is local-only by default: it binds to loopback on an ephemeral
port, creates a random token for every process, and accepts only localhost
origins. Keep those defaults unless a separately authenticated edge proxy
needs a stable upstream — in that case the Supervisor recognizes three
optional environment variables:

| Variable | Effect |
| --- | --- |
| `ARIA_UI_PORT` | a fixed loopback port, 1–65535 |
| `ARIA_UI_TOKEN_FILE` | a file containing exactly 64 hex characters (POSIX: no group/other permissions) |
| `ARIA_UI_ALLOWED_ORIGINS` | comma-separated exact `http(s)` origins accepted in addition to localhost |

All three affect only `--web-ui` runs and never make Aria bind a public
interface; an invalid value fails the console closed while the Supervisor
continues to own profile lifecycle. The edge-proxy contract — TLS termination,
path-prefix stripping, `X-Ui-Token` injection — is specified in
[Supervisor console behind a reverse proxy](CONSOLE_REVERSE_PROXY.md). Never
put the token in a browser URL or committed configuration.

## What the console does

The console is a Management API adapter: profile creation/activation,
preferences, access and account settings, and model/engine controls go through
the same versioned `plan → confirm → apply` pipeline as the CLI and the chat
cards — see [Operate the bridge](operate-the-bridge.md#changing-configuration-safely)
and the [control plane](CONTROL_PLANE.md) internals doc.

Frontend development runs the same `web/` source as an isolated read-only
preview without touching the production Supervisor; see
[Console development preview](CONSOLE_DEVELOPMENT.md).
