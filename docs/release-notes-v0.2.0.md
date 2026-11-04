# v0.2.0 — Hierarchical Memory Curation & Concept Dependency Management

Status: released as `v0.2.0` on 2026-11-04.

## Highlights

- Optional four-layer memory model: L0 goals/constraints, L1 core
  questions/concepts, L2 prerequisites, L3 details/applications.
- Independent memory schema and local JSON document, separate from checkpoint
  schemaVersion 1.
- Deterministic automatic capture for genuine human messages with provenance
  checks against model-originated claims.
- Priority, feasibility, and confidence are independent fields.
- Concept dependency graph with multiple prerequisites, cycle detection,
  unresolved dependency reporting, and dynamic explanation-order planning.
- Concept Prerequisite Guard with explicit user-only `VERIFIED` transitions.
- Layer-protected merge/correction/conflict policy and bounded capacity
  compression.
- Layered retrieval under character/token budgets; L3 cannot displace L0/L1/L2.
- Six opt-in tools: `memory_capture`, `memory_search`, `concept_graph`,
  `concept_status`, `memory_update`, `memory_delete`.
- Atomic memory writes with a per-file in-process lock, `.previous` fallback,
  and restart hydration for first-prompt context.
- English/Chinese documentation, deterministic acceptance fixtures, real-DSH
  ToolRuntime smoke, and an opt-in public-API semantic pilot harness.

## Compatibility

- `memoryEnabled` defaults to `false`.
- v0.1.0 checkpoint and recovery behavior is unchanged when the feature is off.
- Checkpoint `schemaVersion` remains `1`.
- Plugin `inject` remains `['agents', 'sessions']`; tools and systemPrompt are
  optional runtime integrations.
- Cross-process writers to one memory root remain unsupported.

## Verification status

Implemented and deterministically tested:

- capture/classification, merge/conflict, capacity, retrieval, graph planning,
  guard transitions, concurrency, restart, deletion, and tool wiring;
- real Cordis loader and real DSH ToolRuntime registration when
  `DSH_CHECKOUT` is available.

Real-model pilot completed:

- 2026-11-04, public DeepSeek-compatible Chat Completions endpoint.
- Requested display name `DeepSeek-V4.1-Flash 1017`; actual API model id
  `deepseek-flash`.
- 4 fixed cases, baseline + guarded per case.
- Section-aware rubric v2: baseline 1/4, guarded 4/4.
- Single-run pilot only.

Not claimed in this tree:

- statistically validated concept-ordering accuracy;
- general production-wide semantic improvement. See
  [semantic-acceptance-report-2026-11-04.md](semantic-acceptance-report-2026-11-04.md)
  and the sanitized raw
  [semantic-acceptance-run-2026-11-04.json](semantic-acceptance-run-2026-11-04.json).

## Upgrade notes

Restate the complete bundle `config` object when overriding the row. To enable
memory:

```yaml
memoryEnabled: true
memoryRoot: ~/.dsh/task-memory
memoryScopeId: default-user
```

Existing v0.1.0 checkpoint files are untouched. Memory files live under the
separate `memoryRoot`.
