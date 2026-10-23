# Worker mode

> Status: current

> 中文版：[worker-mode.zh.md](worker-mode.zh.md)

`aria worker` runs Aria as a **channel-free managed worker**: no chat channel,
no Supervisor, just a profile's engine and local policy driven over
newline-delimited JSON-RPC on stdin/stdout. This is the embedding surface a
controller (for example a job orchestrator that manages workers as child
processes) uses when it wants agent runs without standing up a chat bot.

## Discover worker identities

```bash
aria worker discover --config <path-to-aria-config.json>
```

Prints a secret-free JSON snapshot of the configured profiles:

```json
{
  "protocolVersion": 1,
  "profiles": [
    { "profile": "claude", "engine": "claude", "connectable": true }
  ]
}
```

`connectable` is true when the profile name is safe to use as an opaque
reference; discovery describes configured identities, not running or
authorized engines.

## Serve a worker

```bash
aria worker serve \
  --config <path-to-aria-config.json> \
  --profile <name> \
  --state-dir <isolated-state-directory> \
  --product-id riff-computer \
  --product-name "Riff Computer"
```

`--state-dir` is required and must be an isolated root: the worker keeps its
own session and log state there instead of sharing the profile's runtime
state. stdout is the protocol transport — runtime log lines go to stderr.
The optional product flags are a deployment-time label for an embedding host;
provide both or neither. Without them the product identity is `aria` / `Aria`.
The `runtime.handshake` response reports that product identity separately from
the implementation identity (`aria` / `Aria`). This label is fixed for the
worker lifetime and is not an authorization principal, device identity, or
permission grant. It does not rename the `aria` executable or engine IDs.

## Embedded server API

The package exposes `@maxverse-ai/aria/worker` as a composition-only entry:

```ts
import { AriaWorkerServer } from '@maxverse-ai/aria/worker';

const server = new AriaWorkerServer({
  input,
  output,
  host, // A deployment-owned ProfileConversationHost.
  profile: 'local',
  workerVersion: ariaVersion,
  productIdentity: { id: 'riff-computer', displayName: 'Riff Computer' },
});
await server.serve();
```

For a standalone engine profile, `createAriaWorker` composes the same host and
server without depending on the CLI entry or importing private modules:

```ts
import { createAriaWorker } from '@maxverse-ai/aria/worker';

const worker = await createAriaWorker({
  configPath: '/product/config.json',
  profile: 'local',
  stateDirectory: '/product/state',
  input,
  output,
  productIdentity: { id: 'riff-computer', displayName: 'Riff Computer' },
});
await worker.serve();
```

Calling this factory checks environment isolation, configures logging under
the explicit state directory, and constructs Aria's profile host. Run it in a
dedicated process: logging configuration is process-wide. The embedding entry
must direct human-readable console output away from the protocol output. The
factory does not install signals, services, updates or CLI argument handlers.
Credentials and engine data isolation still depend on the deployment's
explicit profile configuration; stateDirectory alone does not isolate them.

`discoverInstalledAgents()` from the same entry inspects PATH for the built-in
Codex, Claude Code and DSH commands without starting them. Its trusted-host
result contains `id`, `displayName`, `status` (`installed`, `notInstalled`, or
`unavailable`) and an optional `binaryPath`. Do not forward paths to a renderer.
Discovery establishes neither version compatibility nor login/account access.
On Windows an installation must resolve to a native `.exe`: Codex's known npm
optional-platform and legacy vendor payloads are resolved without executing the
launcher. Missing native payloads and unsupported script-only launchers are
`unavailable`, not runnable installations. Native Claude Code and DSH executables
are supported; their npm/script-only launchers are not currently supported by
this embedded discovery surface.
Use separate worker profiles and state directories for each selected engine.
Profiles may select `claude.binaryPath`; Codex can reuse the user's configuration
with `codex.inheritCodexHome: true`. DSH can opt in with
`dsh.inheritDshHome: true`; otherwise it retains its existing profile-isolated
home. An explicit `dsh.dshHome` takes precedence over inheritance. Inheritance
preserves the user's agent environment, default configuration and login; it does
not copy credentials. Worker session state remains independent, but the native
agent's own history/cache may be shared.

Importing this entry does not parse CLI arguments, register process signals,
replace console methods, configure logging, or open a listener. The embedding
process owns those concerns and must keep its logs separate from protocol
output. It must establish environment isolation before constructing its host;
`assertIsolatedWorkerEnvironment` is exported for the CLI's checks. An embedding
host is trusted deployment code, not a sandbox. Team hosts still require an
authenticated `spaceSession`; branding cannot bypass that check.

This API only separates worker product metadata from implementation metadata.
Native engine `clientInfo`, service installation, update authority, data-directory
defaults and cloud/device registration are not renamed by it. The downstream
product owns its executable/package name and explicit isolated state directory.

The worker **fails closed when it inherits a channel or UI environment**:
`LARK_*`, `LARKSUITE_*`, `FEISHU_*`, `ARIA_UI_*`, `ARIA_HOME`,
`ARIA_WORKSPACE_HOME`, and `ARIA_TRIGGER_RUNTIME` must not be set in its
environment. The error names the offending variables (never their values);
remove them and retry.

## Protocol

Protocol version 1, newline-delimited JSON-RPC 2.0:

| Method | Purpose |
| --- | --- |
| `runtime.handshake` | Protocol/worker version, product and implementation identities, profile, engine descriptor, method list |
| `runtime.health` | Readiness and active/completed operation counts |
| `runtime.models` | Profile-scoped model catalog with explicit provenance and freshness |
| `run.start` | Start an agent run under a `scopeRef` |
| `run.interrupt` | Interrupt the run for a `scopeRef` |
| `session.reset` | Reset the session for a `scopeRef` |
| `runtime.shutdown` | Accepted only with controller management authority |

Streamed agent events arrive as notifications while a run is active. A wrong
method name returns `-32601 method not found`; malformed input returns a parse
error.

`runtime.models` returns `profileId`, `engineId`, `models`, `source`, `stale`,
`refreshing`, `revision`, and optional `fetchedAt`/`error`. Each model carries
`value`, `label`, and optional engine-proven capabilities. Sources are `runtime`,
`plugin`, `cache`, or `static`; static catalogs do not verify account access.
Live catalogs are authoritative and do not append unverified static model ids.
Discovery has bounded provider timeouts and can fall back to a static catalog.
If there are no known models, the embedding UI should still offer the native
agent default. This metadata query does not submit a model/tool turn.

`run.start` accepts an optional nonempty `model` id (maximum 512 characters,
without line breaks or NUL). It is forwarded per turn without rewriting profile
preferences. `default` explicitly omits the native model flag; an omitted field
uses the profile preference. Model availability is ultimately decided by the
agent, never silently substituted by the worker.

## What can go wrong

- **`--config is required` / `--profile is required` / `--state-dir is
  required`** — all three flags are mandatory for `serve`.
- **`aria worker serve requires an isolated environment; remove: ...`** —
  unset the listed variables in the worker's process environment.
- **Logs vs. protocol** — write tooling against stdout only; anything
  human-readable is on stderr.

## Internals

The managed-worker protocol is implemented in `src/worker/`; the environment
isolation contract lives in `src/worker/isolation.ts`.
