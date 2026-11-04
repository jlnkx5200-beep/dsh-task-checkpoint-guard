# Real-model semantic pilot — 2026-11-04

## Run identity

| Field | Value |
|---|---|
| Provider endpoint | `https://api.deepseek.com/chat/completions` |
| Requested display name | `DeepSeek-V4.1-Flash 1017` |
| Actual API model id used | `deepseek-flash` |
| API response style | OpenAI-compatible Chat Completions |
| Cases | 4 |
| Requests | 8 (baseline + guarded per case) |
| Run timestamp | `2026-11-04T13:28:53.611Z` |
| Rubric | v2, section-aware |
| Claim boundary | Pilot only; not a statistically validated accuracy claim |

The provider rejected `DeepSeek-V4.1-Flash 1017` as a model id and listed
`deepseek-flash` and `deepseek-v4-pro` as available. The pilot used
`deepseek-flash`.

Raw, sanitized outputs are in
[semantic-acceptance-run-2026-11-04.json](semantic-acceptance-run-2026-11-04.json).
Reasoning text is **not** present; the report keeps only visible answer text,
finish reason, token usage, and reasoning character counts. No API key or
Authorization header is present.

## Rubric results

```text
baseline: 1/4
guarded:  4/4
```

This is not reported as an accuracy percentage or a general quality claim. It
is a four-case, single-run pilot.

The first heuristic implementation scored guarded at 2/4 because it looked for
the first textual occurrence of the target concept. In two answers the target
appeared in an opening sentence before the prerequisite sections, even though
the formal target chapter came after them. Rubric v2 checks the section
structure instead. The original and rescored evaluations are both reproducible
through the harness; this correction is disclosed rather than hidden.

## Per-case review

### 1. `partial-derivative-isolation`

- Baseline: passed by the no-chain-rule check.
- Guarded: passed.
- Observation: both answers explained partial derivative through fixed-variable
  limits and coordinate-plane tangent slopes. Neither used the queued chain rule
  as a premise. This case did not distinguish the two conditions.

### 2. `multiple-prerequisites-order`

- Baseline: failed. It began directly with the multivariate chain-rule formula
  and did not separately establish `一元函数求导` or `多元函数`.
- Guarded: passed. It explicitly stated that both prerequisites were not marked
  as mastered, gave separate sections for them, then moved to the formal target
  chapter.
- Guard-relevant behavior: separate prerequisite explanations preceded the
  formal target section.

### 3. `goal-over-temporary`

- Baseline: failed. It asked for the missing problem and offered a generic
  technique without retaining the long-term theory goal.
- Guarded: passed. It restated the user's long-term goal of understanding the
  theoretical system, then proposed the compact form “technique + why it works +
  applicability limits” while still respecting the temporary request.
- Guard-relevant behavior: the temporary request did not overwrite L0.

### 4. `unexplained-prerequisite`

- Baseline: failed. It introduced the total differential first and discussed
  partial derivatives later as a relation, without a separate prerequisite
  explanation.
- Guarded: passed. It opened with “先说明前提” and gave a separate partial
  derivative section before the formal total differential section.
- Guard-relevant behavior: an unverified prerequisite was not silently treated
  as known.

## Limitations

- One sample per case; temperature was 0.2.
- The rubric is deterministic and coarse. It can be gamed by section headings
  and cannot measure all semantic quality.
- The run does not establish a general concept-ordering accuracy or model-level
  improvement percentage.
- The raw outputs are synthetic fixtures, not real user sessions.
- The API key used for this run appeared in the interactive request and must be
  revoked/rotated by the account owner. It was not written into this report,
  the repository, or the plugin configuration.

## Reproduce

```sh
DSH_EVAL_BASE_URL=https://api.deepseek.com \
DSH_EVAL_MODEL=deepseek-flash \
DSH_EVAL_API_KEY=... \
npm run test:semantic
```

Re-score an existing report without another API call:

```sh
node scripts/memory-semantic-eval.mjs --rescore docs/semantic-eval-<timestamp>.json
```

## Verification status

- Deterministic suite A–L: passing.
- Real Cordis loader and real DSH ToolRuntime: passing when `DSH_CHECKOUT` is
  available.
- Real-model semantic pilot: completed for this fixed four-case pilot.
- Statistical or production-wide semantic validation: not claimed.
