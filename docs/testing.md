# Testing

## Commands

```sh
npm test
npm run check
npm run pack:check
npm run test:semantic:dry-run
```

Optional local verification against a real DSH checkout:

```powershell
$env:DSH_CHECKOUT = (Resolve-Path '..\deepseek-harness').Path
npm test
```

The three real-loader tests are skipped when `DSH_CHECKOUT` is absent. When it
is present, they mount the plugin in the real Cordis loader and, for the opt-in
memory path, mount the real DSH `SystemPrompt` and `ToolRuntime` packages. The
ToolRuntime test validates the six raw JSON-Schema tool definitions and executes
`memory_capture` and `memory_search` through the public registry.

## Deterministic acceptance matrix

| ID | Automated test | What it proves |
|---|---|---|
| A | `tests/concept-guard.test.mjs` | Two simultaneous concepts stay independent; an unexplained chain rule cannot be used as a premise for partial derivative. |
| B | `tests/concept-guard.test.mjs` | Multiple necessary prerequisites are discovered and ordered before their dependent concept. |
| C | `tests/concept-guard.test.mjs` | A prerequisite can be moved before a target only with an explicit separate-note marker; target user order is checked. |
| D | `tests/memory-curation.test.mjs` | A temporary L3 request cannot overwrite a long-term L0 goal. |
| E | `tests/memory-curation.test.mjs` | Explicit correction updates content and retains history; same-layer contradiction creates a conflict. |
| F | `tests/concept-guard.test.mjs`, `tests/memory-integration.test.mjs` | Model inference cannot mark VERIFIED; unverified `USER_EXPLICIT` tool claims are downgraded. |
| G | `tests/concept-guard.test.mjs`, `tests/memory-curation.test.mjs` | Cyclic prerequisite graphs return no false topological order. |
| H | `tests/memory-curation.test.mjs` | Capacity pressure compresses/evicts L3 while preserving L0/L1 and core prerequisites. |
| I | `tests/memory-curation.test.mjs`, `tests/semantic-acceptance.test.mjs` | L0/L1/L2 precede L3 under a bounded budget; unrelated same-keyword details stay out. |
| J | `tests/memory-store.test.mjs`, `tests/memory-integration.test.mjs` | Concurrent writers merge under one lock; a fresh store loads the persisted graph after restart. |
| K | `tests/memory-curation.test.mjs`, `tests/memory-integration.test.mjs` | Priority update, correction, delete, and relation/index cleanup work through the code and tools. |
| L | `tests/semantic-acceptance.test.mjs` | Deterministic semantic fixtures check the actual injected context and guard decisions. |

The deterministic suite is evidence for the code paths it executes. It is not
evidence that a particular model will always follow the injected guard.

## Real-model semantic pilot

The repository includes an opt-in public-API harness:

```sh
DSH_EVAL_BASE_URL=https://your-public-endpoint.example/v1 \
DSH_EVAL_API_KEY=... \
DSH_EVAL_MODEL=... \
npm run test:semantic
```

It calls an OpenAI-compatible `/chat/completions` endpoint outside plugin
startup, never during a session event. Outputs are written to
`docs/semantic-eval-<timestamp>.json` with a pilot-only claim boundary.

Run the prompt-only dry run without credentials:

```sh
npm run test:semantic:dry-run
```

This writes `docs/semantic-eval-dry-run.json`.

### Reporting rules

- **Implemented** means code and schema are present.
- **Simulated/deterministic verification** means the fixture suite passed.
- **Real-model validated** requires raw model outputs, the exact model id, the
  prompt, the rubric, and a date. A pilot is not a statistically validated
  accuracy result.
- Do not report a concept-ordering accuracy percentage without a named dataset,
  repeated runs, and an explicit scoring standard.

## Regression baseline

The v0.1.0 suite remains in place unchanged in intent:

```text
tests/config.test.mjs
tests/privacy.test.mjs
tests/state.test.mjs
tests/storage.test.mjs
tests/recovery.test.mjs
tests/loader.test.mjs
tests/checkpoint-guard.integration.test.mjs
```

The new tests are additive. The default configuration test asserts
`memoryEnabled: false`, no memory tools are registered, and checkpoint
`schemaVersion` stays `1`.
