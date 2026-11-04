# Submission plan — awesome-dsh-plugin

Target list: <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>

## Listing metadata

| Field | Proposed value |
|---|---|
| Repository URL | `https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard` |
| Entry file | `data/plugins/jlnkx5200-beep__dsh-task-checkpoint-guard.yml` |
| Name/link text | `jlnkx5200-beep/dsh-task-checkpoint-guard` |
| Category | `memory` |
| Icon | omitted; the list falls back to the owner avatar |
| dsh.bundle manifest | present at `package.json` → `dsh.bundle.patch` |
| Repository topic | `dsh-plugin` (add before opening the PR) |

Proposed file:

```yaml
url: https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard
name: jlnkx5200-beep/dsh-task-checkpoint-guard
category: memory
description:
  en: 'Durable task checkpoints and recovery, plus optional L0–L3 concept memory with dependency-aware retrieval, prerequisite guards, and six memory tools.'
  zh: '为 DSH 提供可恢复的任务检查点，并可选择启用 L0–L3 概念记忆、依赖感知检索、先修守卫和六个记忆工具。'
```

The description is intentionally limited to verified capabilities. It does not
claim statistical semantic improvement or a security audit.

## Pre-submission gate

- [x] Package version is `0.2.0`.
- [x] `package.json` declares `dsh.bundle.patch`.
- [x] `cordis.patch.yml` is present.
- [x] Repository has real working code, not placeholder content.
- [x] Repository is older than one day.
- [x] Project is actively maintained.
- [x] Add GitHub topic `dsh-plugin` to
  `jlnkx5200-beep/dsh-task-checkpoint-guard`.
- [x] Publish/verify the v0.2.0 GitHub Release and asset.
- [ ] Confirm the PR changes exactly one new YAML file and no existing entries.
- [ ] Confirm the generated READMEs are not hand-edited in the PR.

Release: <https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/releases/tag/v0.2.0>

## Submission procedure

1. Wait for the v0.2.0 GitHub Release and verify the public install path.

   ```sh
   dsh plugin --profile <disposable-profile> add \
     https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard
   ```

2. Add the `dsh-plugin` topic to the plugin repository.

3. Fork `awesome-dsh-plugin/awesome-dsh-plugin` and create a branch:

   ```sh
   git checkout -b add/dsh-task-checkpoint-guard
   ```

4. Add only this file:

   ```text
   data/plugins/jlnkx5200-beep__dsh-task-checkpoint-guard.yml
   ```

5. Run the list's checks:

   ```sh
   npm ci
   node scripts/generate-readme.mjs
   ```

6. Confirm the diff contains the new entry plus only generated README changes,
   and no other plugin entry was modified.

7. Commit and open a PR:

   ```sh
   git add data/plugins/jlnkx5200-beep__dsh-task-checkpoint-guard.yml README.md README.zh.md
   git commit -m "Add dsh-task-checkpoint-guard"
   git push origin add/dsh-task-checkpoint-guard
   ```

## Proposed PR body

```markdown
## Add dsh-task-checkpoint-guard

- Repository: https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard
- Release: v0.2.0
- Category: memory
- Installable via `dsh plugin add`; package.json declares `dsh.bundle.patch`.

### What it does

Durable local checkpoints and bounded recovery for DSH tasks, plus an optional
memory subsystem disabled by default. When enabled, it stores L0–L3 records,
maintains a concept dependency graph, retrieves prerequisite-aware context, and
registers six tools: memory_capture, memory_search, concept_graph,
concept_status, memory_update, and memory_delete.

### Verification

- 81/81 automated tests pass with a real DSH checkout.
- Real Cordis loader and real DSH ToolRuntime registration/execution pass.
- v0.2.0 real-model semantic pilot completed for four fixed cases under a
  disclosed pilot-only rubric.
- Checkpoint schemaVersion remains 1; memory is a separate schema and file.
- memoryEnabled defaults to false, preserving v0.1.0 behavior.

The repository does not claim a statistical semantic-quality result; the pilot
report and raw synthetic outputs are linked from the README.
```

## Review response checklist

- Keep the entry description aligned with code and tests.
- Answer reviewer questions with file paths, test names, and release commit.
- Do not claim a security review; the awesome list explicitly states that a
  listing is not a security audit.
- Do not add marketing superlatives.
- If asked for a Chinese translation, use the proposed `zh` line above.
- If the reviewer suggests a better category, accept it.

## Timing

- GitHub release + topic + submission PR: about 1–2 hours after authentication.
- Review latency is controlled by the awesome-list maintainers; do not promise a
  merge date.
- A statistically stronger semantic claim would require additional runs and is
  not part of this submission.
