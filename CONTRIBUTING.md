# Contributing

Thank you for considering a contribution. This project is a DSH host plugin and must remain safe for other users' task data.

> **License:** this project is released under the MIT License. By contributing, you agree that your contribution may be distributed under the same license. See [LICENSE](LICENSE).

## Setup

Requirements:

- Node.js `^22.19.0` or `>=24.0.0`;
- DSH `0.2.1-rc.3` for the optional real-loader smoke test.

There are no npm runtime dependencies.

```sh
npm test
npm run check
npm run pack:check
npm run test:semantic:dry-run
```

To run the optional real Cordis loader and real ToolRuntime tests:

```powershell
$env:DSH_CHECKOUT = (Resolve-Path '..\deepseek-harness').Path
npm test
```

```sh
DSH_CHECKOUT=/path/to/deepseek-harness npm test
```

The real-model semantic pilot is opt-in and uses a public API only:

```sh
DSH_EVAL_BASE_URL=... DSH_EVAL_API_KEY=... DSH_EVAL_MODEL=... npm run test:semantic
```

Do not add model calls to `session/event` handling. The plugin's automatic
capture is deterministic by design.

## What to change

- Keep runtime source under `src/`.
- Add or update tests under `tests/`.
- Update `README.md`, `README.zh-CN.md`, and the relevant `docs/` page when behavior changes.
- Update `CHANGELOG.md`.
- Do not add a runtime dependency unless it is strictly necessary and its license is compatible with the eventually selected project license.
- Do not import private DSH source, another plugin's internal files, or local absolute paths.
- Do not add hardcoded providers, credentials, endpoints, profile names, or user home directories.

## Safety requirements for changes

Any change touching recovery must preserve these invariants:

- no automatic recovery after user cancellation, auth/request error, max-token stop, partial stream, or unknown failure;
- no automatic recovery while a tool call has no durable result;
- no blind retry of a completed/unknown-outcome tool call;
- exact-agent liveness, idle state, inbox emptiness, goal revision, phase, activation, and round-budget checks before goal resume;
- human input aborts an in-flight readiness wait;
- checkpoint text never includes reasoning content or credentials;
- probe redirects are rejected and bearer probes require HTTPS outside loopback;
- write failures are contained and logged without leaking full paths/credentials.

Any change touching hierarchical memory must preserve:

- L0/L1 authority over lower-layer material;
- explicit history retained on correction and conflict records;
- no `VERIFIED` transition without explicit user evidence;
- no inferred concept upgraded to `USER_EXPLICIT`;
- cycle detection returns no fabricated topological order;
- L0/L1 and unfinished prerequisites survive capacity pressure;
- L3 details cannot displace L0/L1/L2 in the bounded prompt context;
- memory schema, storage, and locks remain separate from checkpoint schema;
- no hidden reasoning is persisted;
- multi-process writes are not claimed unless a real cross-process lock is added.

## Tests

Use Node's built-in test runner. The suite must not require a real model provider or modify the user's active DSH profile.

Every new behavior needs:

1. a pure unit test where possible;
2. an integration test through the fake host when lifecycle ordering matters;
3. a negative test for fail-closed behavior;
4. a privacy assertion if the change persists new text or metadata.

Tests must use synthetic session/task IDs and temporary directories.

## Style

- ESM JavaScript, semicolon-free style consistent with the existing source.
- Prefer small pure functions in `src/state.js`, `src/storage.js`, `src/redact.js`, `src/recovery.js`, `src/memory-curation/`, and `src/concept-guard/`.
- Keep DSH-specific lifecycle and optional service wiring in `src/index.js`; keep memory policy, graph, and retrieval logic host-independent.
- Never log raw thrown objects or credential values.
- Keep all persisted strings bounded and redacted.

## Commit messages

Use a conventional prefix where practical:

```text
feat: ...
fix: ...
test: ...
docs: ...
chore: ...
security: ...
```

## Reporting security issues

See [SECURITY.md](SECURITY.md). Do not put secrets or real checkpoints in a public issue.
