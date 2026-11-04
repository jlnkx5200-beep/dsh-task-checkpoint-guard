# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project intends to use semantic versioning once a license and public release policy are confirmed.

## [Unreleased]

### Added

- Hierarchical memory curation design records and release-candidate documentation.

## [0.2.0] - Unreleased

### Added

- Optional opt-in four-layer memory model (`L0` goals/constraints, `L1` core
  questions/concepts, `L2` prerequisites, `L3` details/applications).
- Independent memory document schema (`kind: dsh-hierarchical-memory`,
  `schemaVersion: 1`) stored under a separate memory root.
- Deterministic human-message capture, semantic intent/layer classification,
  priority/feasibility/confidence separation, and model-provenance downgrade.
- Layer-protected merge, correction history, conflict records, and capacity
  compression that preserves L0/L1 and unfinished prerequisites.
- Concept dependency graph with multiple prerequisites, cycle detection,
  unresolved dependencies, user-order preservation, and dynamic explanation
  planning.
- Concept Prerequisite Guard and learning-state machine; only explicit user
  evidence can mark a concept `VERIFIED`.
- Layered retrieval with character/token budgets and a read-only
  `memory:curated` system-prompt section.
- Six public tools: `memory_capture`, `memory_search`, `concept_graph`,
  `concept_status`, `memory_update`, and `memory_delete`.
- Atomic memory writes with a shared in-process per-file lock, `.previous`
  fallback, and restart hydration.
- Deterministic tests A–K, semantic regression fixtures, real Cordis loader and
  real DSH ToolRuntime coverage, and an opt-in public-API semantic pilot script.

### Changed

- Package version is now `0.2.0`.
- README, architecture, configuration, testing, security, and troubleshooting
  documentation describe the optional memory subsystem.
- `check` includes syntax checks for the new modules.

### Compatibility

- `memoryEnabled` defaults to `false`; v0.1.0 checkpoint and recovery behavior
  remains unchanged when disabled.
- Existing checkpoint schemaVersion stays `1`.
- Cross-process writers to one memory root are still unsupported.
- Real-model semantic pilot completed on 2026-11-04 with API model
  `deepseek-flash`: 4 cases, baseline 1/4, guarded 4/4 under section-aware rubric
  v2. This is a single-run pilot, not a statistically validated accuracy claim.
- Sanitized outputs and the reviewed report are committed under `docs/`.

## [0.1.0] - 2026-11-02

### Added

- Local structured checkpoint persistence with JSON, Markdown, and session pointer files.
- Atomic same-directory writes with `fsync`, rename fallback for Windows, and one valid `.previous` copy.
- Checkpoint loading with previous-copy fallback and task-file scan.
- Public DSH event reduction for goals, todos, turns, steps, request headers, assistant messages, tool calls/results, and retries.
- Conservative failure classification for network, timeout, service, auth, abort, max-token, partial-stream, and unknown failures.
- Optional bounded HTTP(S) readiness probing with exponential backoff, jitter, timeout, and authenticated credential resolution.
- Explicit `off`, `probe`, and `deferred` recovery modes; automatic recovery is off by default.
- Compare-and-set DSH goal reactivation with race fences for liveness, idle state, pending inbox input, goal phase, activation, provider filter, and round budget.
- Structured recovery-context injection through the public `agent.inject()` method.
- Exact duplicate tool-call guard for the first resumed turn.
- Secret-shape redaction and JSON secret-key redaction before persistence.
- Reasoning text exclusion with block/character-count metadata only.
- Optional reconciliation of missing history through `ctx.sessionQuery`.
- Tests for config validation, state transitions, atomic writes, previous-copy fallback, concurrent writers, network simulation, readiness probes, goal re-arming, duplicate guard, unknown tool outcomes, CoT exclusion, credential redaction, plugin disposal, and real Cordis loading.

### Security

- No remote checkpoint synchronization.
- No credentials written to checkpoint documents.
- Probe redirects rejected; bearer probes require HTTPS outside loopback.
- Local checkpoint files requested with owner-only permissions where supported.

### Known limitations

- Only DSH `0.2.1-rc.3` has been locally verified.
- Automatic continuation requires DSH's goal service and goal-round driver.
- Cross-process checkpoint writers are not supported.
- Checkpoint retention/cleanup and encryption are not implemented.
- Tool idempotency cannot be inferred generically; the duplicate guard covers exact fingerprints only.
- Licensed under the MIT License; see `LICENSE`.
