# Semantic acceptance protocol

The schema tests prove storage and guard mechanics. They do not prove that a
model produces a better explanation. This document defines the separate
semantic acceptance process and its claim boundary.

## Dataset

The fixed pilot cases are in `scripts/memory-semantic-fixtures.mjs`:

1. **partial-derivative-isolation** — the user asks about partial derivative
   and chain rule together. The target answer must not use chain rule as an
   unexplained premise.
2. **multiple-prerequisites-order** — multivariable composite differentiation
   depends on single-variable differentiation and multivariable functions. Both
   must be recognized and separately introduced before the target.
3. **goal-over-temporary** — a long-term theory-oriented learning goal must
   survive a later task-local request for a calculation technique.
4. **unexplained-prerequisite** — total differential depends on partial
   derivatives. The answer must not treat partial derivatives as mastered.

Each fixture includes a user message, a current question, a retrieval query, and
a short rubric. The harness builds the exact memory context and stores both a
baseline prompt (no curated memory context) and a guarded prompt.

## Run protocol

```sh
DSH_EVAL_BASE_URL=https://public-endpoint.example/v1 \
DSH_EVAL_API_KEY=... \
DSH_EVAL_MODEL=... \
npm run test:semantic
```

The script uses only a public OpenAI-compatible Chat Completions API. It does
not use a private model endpoint and is never called from `session/event`.

The output file records:

- UTC timestamp;
- model id;
- endpoint path;
- full baseline and guarded prompt;
- raw model response text;
- per-case deterministic rubric checks;
- the explicit claim boundary.

## Rubric

| Fixture | Pass condition |
|---|---|
| partial-derivative-isolation | The guarded answer contains zero occurrences of “链式法则”. |
| multiple-prerequisites-order | Both prerequisite names occur, an explicit prerequisite section is present, and a formal target section (“正题/正式讲解/目标概念”) appears after it. |
| goal-over-temporary | The answer mentions the long-term theory/system goal while giving the current technique. |
| unexplained-prerequisite | A “先说明前提/先单独讲/前置概念” section exists before the formal total-differential section, and both prerequisite and target terms are present. |

These are coarse pilot checks. They can miss semantic equivalence and can be
gamed by section headings. They must not be reported as a general concept
ordering accuracy. Rubric v2 intentionally checks prerequisite sections rather
than the first mention of the target name, because a good answer may name the
target in its opening sentence before explaining prerequisites.

## Current status in this tree

- Deterministic fixture suite: implemented and passing.
- Real Cordis loader: implemented and passing when `DSH_CHECKOUT` is available.
- Real DSH `ToolRuntime` JSON-Schema registration and tool execution:
  implemented and passing when `DSH_CHECKOUT` is available.
- Real-model semantic pilot: **completed for the fixed four-case pilot on
  2026-11-04** using the public DeepSeek-compatible endpoint and API model
  `deepseek-flash`. The provider rejected the display name
  `DeepSeek-V4.1-Flash 1017` and listed `deepseek-flash` / `deepseek-v4-pro`
  as API model ids.
- Pilot result under the section-aware rubric v2: baseline 1/4, guarded 4/4.
  This is a single-run pilot, not a statistical accuracy claim.
- Full report: [semantic-acceptance-report-2026-11-04.md](semantic-acceptance-report-2026-11-04.md).
  Sanitized raw output:
  [semantic-acceptance-run-2026-11-04.json](semantic-acceptance-run-2026-11-04.json).

## Reproducibility notes

- Keep the generated JSON report and the exact commit hash together.
- Do not include API keys, local home paths, or unrelated session content.
- Re-run with temperature 0.2 or lower and the same model id for comparison.
- A single response per case is a pilot, not a benchmark. Multiple runs and a
  larger case set are required for any accuracy claim.
