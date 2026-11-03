# Configuration

The bundle row is inserted as `id: task-checkpoint-guard`. Defaults are intentionally conservative and are applied by the exported Standard Schema validator.

## Override the row

Edit the profile's `cordis.patch.yml`:

```yaml
- id: task-checkpoint-guard
  name: dsh-task-checkpoint-guard
  config:
    # Full configuration goes here.
```

A later patch replaces the row's **whole** `config` object. If you override any field, include every non-default field you want to keep.

## Parameters

| Parameter | Type | Default | Accepted values | Purpose | Security / operational impact |
|---|---|---|---|---|---|
| `checkpointRoot` | string | `$DSH_HOME/task-checkpoints` | Absolute path, or `~/...` | Local directory for state | Contains task text and bounded tool data. Protect it as user data. No default hardcoded user path. |
| `recoveryMode` | string | `off` | `off`, `probe`, `deferred` | Selects recovery policy | `off` cannot resume automatically. `probe` makes outbound HTTP requests. `deferred` may retry without proving network readiness; use only when explicitly desired. |
| `probeUrl` | string | unset | Absolute `http://` or `https://` URL; required for `probe` | Readiness endpoint | An outbound request reveals the endpoint host and timing. Query strings can contain secrets; prefer a clean endpoint and `credentialRef`. Redirects are rejected. |
| `probeMethod` | string | `GET` | `GET`, `HEAD` | HTTP method | `HEAD` may not be supported by every gateway. `GET` never persists the body. |
| `probeAuth` | string | `none` | `none`, `bearer` | Whether to resolve and attach a credential | `bearer` requires `credentialRef`; HTTPS is mandatory except loopback. The secret is never stored. |
| `credentialRef` | string | unset | Environment-variable-style identifier | Reference passed to DSH credentials service | Only the reference name is persisted in configuration; the value is resolved per probe and never logged. |
| `probeExpectedStatuses` | number[] | `[]` (any 2xx) | Integers `100`–`599` | Exact statuses considered ready | A 3xx is not followed. An endpoint that routinely returns 401 should be paired with valid credentials rather than listed as success. |
| `probeTimeoutMs` | integer | `5000` | `250`–`60000` | Per-attempt timeout | Bounds hung probes. |
| `maxProbeAttempts` | integer | `5` | `1`–`12` | Number of probe attempts | Bounds recovery latency. |
| `initialProbeDelayMs` | integer | `1000` | `0`–`60000` | First delay / deferred delay | `0` is useful only for tests or a local readiness service. |
| `maxProbeDelayMs` | integer | `30000` | `0`–`300000`; >= initial | Backoff cap | Prevents unbounded exponential growth. |
| `jitterRatio` | number | `0.2` | `0`–`1` | Symmetric jitter fraction | Reduces synchronized retries. |
| `maxAutoResumes` | integer | `3` | `0`–`10` | Successful re-arms allowed per interruption | `0` effectively disables automatic re-arm even if `probe` is configured. |
| `providerFilter` | string or null | `null` | Any non-empty string up to 200 chars | Only auto-resume when recorded provider matches | Prevents recovering a task through a provider the operator did not intend. |
| `duplicateToolPolicy` | string | `deny-on-recovery` | `off`, `deny-on-recovery` | Exact duplicate guard during the first resumed turn | `deny-on-recovery` blocks exact completed or unknown-outcome fingerprints for that one turn. `off` leaves enforcement to model instructions. It cannot judge idempotency for different arguments. |
| `maxToolHistory` | integer | `80` | `1`–`200` | Number of tool records retained | Bounds checkpoint size and duplicate-guard memory. |
| `maxToolResultChars` | integer | `2000` | `100`–`20000` | Visible tool-result text cap | Reduces sensitive-data exposure and disk growth. Results are redacted before truncation. |
| `maxToolArgumentChars` | integer | `1000` | `0`–`10000` | Redacted tool-argument preview cap | The full canonical argument digest is still retained for duplicate detection; raw arguments are not written. |
| `maxRecoveryContextChars` | integer | `16000` | `1000`–`50000` | Injected recovery message cap | Bounds model context and token cost. |
| `persistDebounceMs` | integer | `100` | `0`–`5000` | Coalescing window for low-priority events | Larger values reduce disk writes but increase the crash window. Tool calls/results and turn boundaries flush immediately. |
| `reconstructFromSessionQuery` | boolean | `true` | `true`, `false` | Replay missing events through `ctx.sessionQuery` | Reads local session history, which can be expensive for very large sessions. Disable if the host lacks the service or strict latency is required. |

## Complete example

```yaml
- id: task-checkpoint-guard
  name: dsh-task-checkpoint-guard
  config:
    checkpointRoot: ~/.dsh/task-checkpoints
    recoveryMode: probe
    probeUrl: https://api.example.test/v1/models
    probeMethod: GET
    probeAuth: bearer
    credentialRef: EXAMPLE_API_KEY
    probeExpectedStatuses: [200]
    probeTimeoutMs: 5000
    maxProbeAttempts: 5
    initialProbeDelayMs: 1000
    maxProbeDelayMs: 30000
    jitterRatio: 0.2
    maxAutoResumes: 3
    providerFilter: null
    duplicateToolPolicy: deny-on-recovery
    maxToolHistory: 80
    maxToolResultChars: 2000
    maxToolArgumentChars: 1000
    maxRecoveryContextChars: 16000
    persistDebounceMs: 100
    reconstructFromSessionQuery: true
```

The endpoint and credential reference above are placeholders.

## Defaults-only row

The bundle's own `cordis.patch.yml` inserts the row without config, which is equivalent to:

```yaml
recoveryMode: off
probeMethod: GET
probeAuth: none
probeExpectedStatuses: []
probeTimeoutMs: 5000
maxProbeAttempts: 5
initialProbeDelayMs: 1000
maxProbeDelayMs: 30000
jitterRatio: 0.2
maxAutoResumes: 3
providerFilter: null
duplicateToolPolicy: deny-on-recovery
maxToolHistory: 80
maxToolResultChars: 2000
maxToolArgumentChars: 1000
maxRecoveryContextChars: 16000
persistDebounceMs: 100
reconstructFromSessionQuery: true
```

`checkpointRoot` is omitted because it is resolved at plugin start from `dshHomePath`, then `DSH_HOME`, then the platform home directory.

## Validation behavior

Invalid configuration fails plugin load. Examples:

- `recoveryMode: probe` without `probeUrl`;
- a relative `checkpointRoot`;
- `probeAuth: bearer` without `credentialRef`;
- bearer auth over plain HTTP to a non-loopback host;
- `maxProbeDelayMs < initialProbeDelayMs`;
- unknown fields.

The validator is synchronous and implements the Standard Schema contract expected by Cordis.

## Recovery mode guidance

### `off`

Best default for users who want durable records but do not want any automatic model retry. Recovery context is not injected automatically, but the Markdown/JSON checkpoint remains available for human inspection.

### `probe`

Use when you have a cheap, safe readiness endpoint. A HEAD/GET request is made without a body. The response body is never read. A 401/403 proves the network is reachable, but the plugin treats it as terminal because it cannot prove the model route will work.

### `deferred`

Use when a local scheduler or another layer already knows that connectivity returns after a fixed delay, or when a failed request is safe to retry and spending one more model call is acceptable. The plugin does not verify reachability in this mode; it waits `initialProbeDelayMs` once.

## Credentials

`probeAuth: bearer` uses the public DSH `ctx.credentials.resolve(reference)` service. The reference must be an environment-variable-style name such as `MY_GATEWAY_KEY`.

- The resolved value is attached only to the probe request.
- It is not written to JSON, Markdown, session pointers, logs, or recovery context.
- If the credentials service is absent or returns no value, the probe fails closed without making a request.
- Redirects are rejected so the header cannot be forwarded to another origin.

## Tuning and durability

- `persistDebounceMs` affects only low-priority events. `tool/call`, `tool/result`, `turn/start`, `turn/end`, `user/message`, `goal/change`, and `assistant/message` are flushed immediately.
- A hard crash before a pending debounced write can lose the most recent low-priority event. The previous checkpoint and DSH's own session log remain independent recovery sources.
- `maxToolHistory`, `maxToolResultChars`, and `maxRecoveryContextChars` bound both disk and model-context growth.
- Multi-process checkpoints are not supported; one DSH process should own a given checkpoint root/session.
