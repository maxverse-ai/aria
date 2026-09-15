# Grok Agent stdio runtime

> Status: current

Aria's Grok engine owns one `grok agent stdio` process per profile. The process
speaks ACP version 1 as newline-delimited JSON-RPC over stdin and stdout. ACP
method names and xAI extensions remain private to the Grok runtime; the rest of
Aria consumes only the semantic `EngineRuntime` and `AgentEvent` contracts.

## Profile configuration

```json
{
  "agentKind": "grok",
  "grok": {
    "binaryPath": "/absolute/path/to/grok",
    "inheritGrokHome": true
  }
}
```

Aria does not copy or store Grok credentials. The child uses the local Grok
login or `XAI_API_KEY` inherited through the normal agent-launch environment.
Set `grokHome` only when a profile needs an explicit `GROK_HOME`; otherwise the
user's existing Grok home is inherited.

## Lifecycle and sessions

The profile owns the process. A run creates or loads one ACP session and owns a
single `session/prompt` request. Process disposal interrupts active runs before
terminating the stdio server. If a requested session is missing, Aria starts a
fresh session and reports its actual id rather than pretending the old session
was resumed.

Aria deliberately has no headless fallback. Mixing `grok -p` with Agent stdio
would create two authorities for session state and make prompt delivery
ambiguous after transport failures.

## Live input

During an active prompt, eligible text is delivered through xAI's
`x.ai/interject` extension. Aria reports steering as accepted only after the
JSON-RPC response arrives. Empty input, stale run ids, closing turns, and
transport errors remain in the ordinary next-turn path.

## Permissions

Canonical profile access is mapped at process launch:

| Aria access | Grok sandbox | Permission requests |
| --- | --- | --- |
| `read-only` | `read-only` | select `reject_once` |
| `workspace` | `workspace` | select `reject_once` |
| `full` | `off` plus `--always-approve` | select `allow_once` |

Permission requests are accepted only for a currently active session. Unknown
server requests fail closed. Aria never retries an unacknowledged prompt because
the first attempt may already have executed tools.

## Protocol compatibility

The implementation uses a small typed subset of the wire protocol and ignores
unknown notification fields. Process tests run against a fake stdio server and
cover initialization, authentication, sessions, model selection, streamed
messages, tools, permission requests, usage, steering acknowledgements, and
cleanup. Upgrade Grok in a test profile and run those tests before changing the
supported protocol surface.
