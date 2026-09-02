# Supervisor console behind a reverse proxy

Aria's supervisor console is local-only by default: it binds to loopback on an
ephemeral port, creates a random token for every process, and accepts only
localhost origins. Keep those defaults unless a separately authenticated edge
proxy needs a stable upstream.

## Aria-side contract

The supervisor recognizes three optional environment variables:

- `ARIA_UI_PORT`: a fixed loopback port from 1 through 65535;
- `ARIA_UI_TOKEN_FILE`: a regular file containing exactly 64 hexadecimal
  characters; on POSIX it must have no group or other permissions;
- `ARIA_UI_ALLOWED_ORIGINS`: comma-separated exact HTTP(S) origins accepted in
  addition to localhost, with no paths.

All three affect only `run --web-ui` / `start --web-ui`. They never make Aria
bind a public interface. An invalid value fails the console closed while the
supervisor continues to own its profile lifecycle.

## Edge responsibilities

The edge proxy must:

1. terminate TLS and authenticate every console request;
2. strip the public path prefix before forwarding;
3. overwrite the upstream `Host` with the configured loopback address;
4. overwrite `X-Ui-Token` with the exact token from `ARIA_UI_TOKEN_FILE`;
5. forward the browser `Origin` unchanged so Aria can compare it with
   `ARIA_UI_ALLOWED_ORIGINS`;
6. keep the upstream token and the human credential outside source control.

The browser bundle resolves `api/` beside the page that served it, so a public
path such as `/aria/` maps to `/aria/api/*` without embedding that prefix in
Aria.

## Caddy shape

This example assumes the Caddy service receives the password hash and upstream
token from a root-managed environment file. The literal values must not be
committed to the Caddyfile.

```caddyfile
redir /aria /aria/ 308
handle_path /aria/* {
  basic_auth {
    operator {$ARIA_CONSOLE_PASSWORD_HASH}
  }
  header {
    Content-Security-Policy "frame-ancestors 'self'"
    Referrer-Policy no-referrer
    X-Frame-Options SAMEORIGIN
  }
  reverse_proxy 127.0.0.1:5274 {
    header_up Host 127.0.0.1:5274
    header_up X-Ui-Token {$ARIA_CONSOLE_UPSTREAM_TOKEN}
  }
}
```

The token in `ARIA_CONSOLE_UPSTREAM_TOKEN` must equal the contents of
`ARIA_UI_TOKEN_FILE`. A supervisor restart does not rotate an explicitly
configured token; rotate both copies together and reload both services.

The console is write-capable. A read-only public status page is a different
surface and must not reuse this route without an explicit authorization model.
