# v0.2.0 technical design — Hierarchical Memory Curation & Concept Dependency Management

Status: implementation design. This document records the v0.1.0 audit, the
module boundaries, the durable schemas, the failure model, and the acceptance
contract for the optional memory subsystem.

## 1. Audit of v0.1.0

### Runtime shape

`src/index.js` is the only host plugin entry point. It exports `name`, `inject`
(`agents`, `sessions`), `Config`, and `apply()`. The plugin reduces documented
session events into one task state through a per-session promise chain, writes
JSON/Markdown/pointer documents, and optionally recovers a goal.

The following properties are part of the compatibility contract and must not
change in v0.2.0:

1. Default activation behavior: checkpointing remains on; automatic recovery
   remains off; the exact-duplicate guard remains `deny-on-recovery`.
2. `schemaVersion: 1` on the existing checkpoint document. The memory subsystem
   has its own schema and never changes the meaning of checkpoint fields.
3. `apply()` remains synchronous and the loader still receives a plain Cordis
   plugin. No new required service is added to `inject`.
4. Existing public DSH seams only: session events, agent lifecycle, public tool
   registry, public system-prompt registry, and the existing optional services.
5. No model call is added to `session/event` handling. Automatic capture is
   deterministic and local.

### Available DSH extension points

The local DSH checkout confirms these documented seams:

- `ctx.tools.register(tool)` accepts a raw `ToolDefinition` with a JSON-Schema
  `parameters` object and an `output.schema` / `output.render` pair.
- `ctx.systemPrompt.section({ name, order, text })` is evaluated for each prompt
  assembly. The agent-backed assembly context exposes the current agent, so a
  scoped section can render only that agent's curated memory.
- `agent/pre-step` can append messages to a proposed step, but v0.2.0 does not
  use it for the primary path: the system-prompt section is the lower-risk,
  non-duplicating injection point.
- `tools/pre-execute` remains the correct place for hard tool-call policy; the
  memory subsystem therefore enforces state transitions in its own tools and
  never relies on a prompt instruction alone where a tool result can be checked.

### Why this is additive

Memory code is reached only when `memoryEnabled: true`. The default is `false`.
The modules are loaded as inert internal code so the plugin keeps a synchronous
Cordis `apply()` and real ToolRuntime schemas can be registered immediately
when enabled; with the switch off, no memory store is opened, no tools or
prompt sections are registered, and the v0.1.0 checkpoint/recovery tests remain
the regression baseline.

## 2. Data model

The memory document is a separate JSON document:

```text
<memoryRoot>/<safe-scope-id>.json
<memoryRoot>/<safe-scope-id>.json.previous
```

It has `schemaVersion: 1` and `kind: "dsh-hierarchical-memory"`. It is not
embedded in the checkpoint and is never interpreted by checkpoint loading.

### Memory record

Every user-visible assertion, question, goal, constraint, prerequisite, or
detail is an independent record. A record includes at least:

```json
{
  "id": "mem_…",
  "layer": "L1",
  "topic": "偏导数",
  "content": "解释偏导数的概念与几何意义",
  "userOriginal": "请解释偏导数的概念与几何意义",
  "source": { "kind": "USER_EXPLICIT", "sessionId": "…", "seq": 12 },
  "sourceRefs": ["session:…/event:12"],
  "confidence": "EXPLICIT",
  "priority": "HIGH",
  "feasibility": "READY",
  "processingStatus": "QUEUED",
  "relatedConceptIds": ["concept_…"],
  "dependencyConceptIds": [],
  "intent": "question",
  "temporalScope": "task",
  "userOrder": 3,
  "version": 1,
  "createdAt": 0,
  "updatedAt": 0,
  "history": []
}
```

Layers:

- `L0`: long-term goals, final purpose, and explicit constraints.
- `L1`: independently identified core questions and concepts.
- `L2`: prerequisites required by an L1 concept.
- `L3`: derivations, examples, applications, and temporary task-local details.

Layer is not explanation order. A dependency edge and a topological planner own
explanation order.

### Concept node

Concept nodes are independent even when related. Their view is computed from
the document and relation list:

```json
{
  "id": "concept_…",
  "name": "偏导数",
  "aliases": [],
  "layer": "L1",
  "priority": "HIGH",
  "feasibility": "READY",
  "confidence": "EXPLICIT",
  "status": "QUEUED",
  "prerequisiteIds": [],
  "relatedConceptIds": [],
  "sourceRefs": ["session:…/event:12"],
  "userOrder": 1,
  "explanationOrder": null,
  "version": 1,
  "statusHistory": []
}
```

### Relation edges

Relations are separate first-class objects:

```json
{
  "id": "rel_…",
  "type": "PREREQUISITE_OF",
  "fromConceptId": "concept_prerequisite",
  "toConceptId": "concept_target",
  "confidence": "EXPLICIT",
  "source": "USER_EXPLICIT",
  "createdAt": 0,
  "updatedAt": 0
}
```

Supported types: `PREREQUISITE_OF`, `PART_OF`, `ELABORATES`, `EXAMPLE_OF`,
`RELATED_TO`, `CONFLICTS_WITH`.

`PREREQUISITE_OF` is directed prerequisite → dependent. A relation is created
only when the user stated it, the caller explicitly requested it, or verified
evidence supports it. Co-occurrence in one message is not sufficient evidence.

## 3. Capture and classification

`capture.js` splits human messages conservatively at durable boundaries:
paragraphs, list items, sentence terminators, and explicit conjunctions when the
resulting fragments are independently actionable. It preserves the original
message and a per-record `userOrder`.

`classifier.js` uses semantic intent rules rather than a single keyword match:

- long-term objective or constraint language → `L0`;
- a question/core concept or explicit topic → `L1`;
- prerequisite language or explicit dependency input → `L2`;
- proof, example, calculation, application, or temporary request language → `L3`;
- correction language marks the capture as a correction, not a silent overwrite;
- hedged user language lowers confidence to `UNCERTAIN`;
- model/tool-originated content defaults to `INFERRED`.

The automatic path captures only genuine human messages. Tool-provided
`USER_EXPLICIT` content is accepted only when it is verifiably present in a
recent human message; otherwise it is downgraded to `INFERRED`. This prevents a
model from upgrading its own inference to user fact.

Feasibility is a state label, not a score:

- `READY`
- `NEEDS_PREREQUISITE`
- `NEEDS_CLARIFICATION`
- `BLOCKED`
- `OUT_OF_SCOPE`

Priority and confidence are evaluated independently. A high-priority concept
can remain `NEEDS_PREREQUISITE`; that does not reduce its priority.

## 4. Merge and conflict policy

`merge-policy.js` classifies each incoming item as one of:

- new node;
- supplement to an existing node;
- correction;
- conflict;
- unclassified.

Rules:

1. L2/L3 material cannot silently change L0 or L1 content.
2. A correction requires explicit user correction language or a user-supplied
   `memory_update`; the old version remains in bounded per-record history.
3. Same-layer contradictions that are not corrections create a conflict record
   and require confirmation. Both sources and timestamps remain.
4. Repeating a concept mention does not create a duplicate node; it updates
   source references and version metadata only.
5. A concept node never merges two distinct names merely because they share a
   keyword.

Capacity policy protects all L0 records and all L1/core concepts first. It then
protects L2 prerequisites reachable from unfinished L1 concepts. L3 records are
compressed first. Compression keeps the record id, layer, topic, hash,
source references, and a bounded summary. Older duplicate low-priority records
may be moved to bounded audit/tombstone indexes only after compression, never
silently.

## 5. Dependency graph and guard

`dependency-graph.js` provides:

- add/update/remove relation operations;
- adjacency and reverse adjacency;
- multiple prerequisites;
- cycle detection for `PREREQUISITE_OF`;
- topological planning with unresolved state on missing dependencies;
- user-order tie-breaking.

A cycle is reported explicitly. The planner returns no false topological
sequence. If a relation is forced for diagnostics, it is retained with a cycle
diagnostic but the ordering result remains blocked.

`concept-guard/prerequisite-check.js` checks:

1. the target concept exists;
2. every necessary prerequisite is `EXPLAINED` or `VERIFIED`;
3. queued concepts not declared as prerequisites are not used as premises;
4. all concept names/aliases found in the proposed explanation are either the
   target, a satisfied prerequisite, or already explained;
5. a missing/ambiguous dependency remains `NEEDS_CLARIFICATION` rather than
   being guessed.

The check returns structured violations and never rewrites model output. The
tool transition path uses it as a hard gate: `start_explanation` and
`complete_explanation` fail if the guard fails.

`state-transition.js` enforces the learning-state machine:

```text
CAPTURED -> QUEUED -> INTRODUCED -> EXPLAINED -> VERIFIED
     \         \          \            \
      -> DEFERRED / BLOCKED <-----------+
EXPLAINED / VERIFIED -> QUEUED  (new user doubt / correction)
```

`VERIFIED` requires explicit user evidence (`USER_CONFIRMATION`,
`USER_APPLICATION`, or `USER_FEEDBACK`). Model inference alone is rejected. A
new user question or doubt reopens a previously verified concept to `QUEUED`.

`explanation-order.js` builds a target/prerequisite closure, detects cycles, and
returns a deterministic order. Independent concepts retain user order. A
prerequisite may be moved before its dependent with an explicit
`adjustedForPrerequisite` reason and a marker that a separate prerequisite
section was created.

## 6. Retrieval and context injection

`retrieval.js` does not use keyword similarity alone. Selection is ordered by:

1. mandatory L0 goals/constraints;
2. current L1 targets;
3. prerequisite closure (L2);
4. concept state and dependency readiness;
5. user priority;
6. confidence source;
7. recency;
8. relevance.

L3 records are eligible only when they elaborate a selected L1/L2 concept or are
explicitly requested. A same-keyword L3 snippet cannot displace L0/L1/L2.

The budget is enforced with both character and approximate-token ceilings.
Records are emitted as bounded blocks; required L0 blocks are truncated only as
a last resort. Omitted ids are returned for explicit follow-up searching.

When memory is enabled, the optional `systemPrompt` seam receives one
`memory:curated` section per agent. The section text is rendered from the
in-memory snapshot for the configured memory scope and the agent's most recent
human query. No model call is made. If the seam is unavailable, tools still work
and retrieve on demand.

## 7. Persistence and concurrency

`store.js` uses the existing atomic-write primitive but an independent memory
document and lock namespace. Every mutation is:

1. acquired under a module-level per-file lock;
2. loaded from the latest valid document/previous copy;
3. mutated and normalized;
4. written to a same-directory temporary file, fsynced, and atomically replaced;
5. leaves the previous valid document as `.previous`.

All in-process agents share the same lock for one memory file. Concurrent
writes to different concepts are serialized and merged; a later write cannot
silently replace an earlier one. An optimistic per-record `version` protects
targeted corrections. Cross-process writers are a documented limitation of the
same order as v0.1.0 and are not claimed as supported.

The on-disk memory document is separate from v0.1.0 checkpoint files. Restart
is exercised by constructing a fresh store and loading the same file.

## 8. Tools

The optional tools are registered only when `memoryEnabled: true` and a public
tool registry is present:

- `memory_capture`: record structured or natural-language information.
- `memory_search`: layered retrieval with optional explicit-detail search.
- `concept_graph`: read concept nodes, relations, cycles, and order.
- `concept_status`: view, check, start, complete, verify, defer, block, or
  reopen concept learning state.
- `memory_update`: correct priority/layer/content/confidence/status with
  `expectedVersion`.
- `memory_delete`: delete a record/concept and synchronize relation and record
  indexes.

Every tool returns canonical JSON and a rendered text projection. No tool
persists hidden reasoning.

## 9. Test mapping

| Test | Module/system path |
|---|---|
| A concept isolation | capture + dependency graph + guard on 偏导数/链式法则 |
| B multiple prerequisites | graph closure + topo planner |
| C user order protection | planner tie-break + separate prerequisite marker |
| D high-layer protection | merge policy L0 vs temporary L3 |
| E correction history | correction path + per-record history |
| F inference isolation | state transition VERIFIED guard + provenance downgrade |
| G cycle detection | forced cyclic graph → no topological order |
| H capacity | L0/L1 protection + L3 compression |
| I context injection | retrieval budget and L3 relevance filter |
| J concurrent writes/restart | shared store lock + fresh load |
| K correction/delete | memory_update / memory_delete + index cleanup |
| L semantic regression | fixture harness; real-model results reported separately |

## 10. Acceptance boundary

Implemented means: code, schema, tests, loader smoke, and documentation pass.
Simulated verification means: deterministic fixtures and injected fake hosts
pass. Real-model semantic validation is a distinct claim. A release note may
report semantic improvement only when a named dataset, rubric, model, and run
output are retained. No concept-sorting accuracy percentage is claimed here.

## 11. Implementation status in this branch

- Core memory modules, six tools, guard, retrieval, persistence, and tests:
  implemented.
- Real Cordis loader and real DSH `ToolRuntime` registration/execution:
  implemented and verified with `DSH_CHECKOUT` pointing at the local
  `deepseek-harness` checkout.
- Deterministic semantic regression fixtures: passing.
- Real-model semantic pilot: public-API harness implemented; no API credentials
  were configured during this development run, so no real-model improvement
  claim is made. See [semantic-acceptance.md](semantic-acceptance.md).
- No push, tag, or GitHub Release has been created.
