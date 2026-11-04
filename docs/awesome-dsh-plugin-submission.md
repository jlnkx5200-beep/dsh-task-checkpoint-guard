# Final submission plan — awesome-dsh-plugin

Target repository: <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>

## 1. Plugin listing

| Field | Value |
|---|---|
| Repository | `https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard` |
| Release | `v0.2.0` |
| Category | `memory` |
| Entry file | `data/plugins/jlnkx5200-beep__dsh-task-checkpoint-guard.yml` |
| Icon | omitted; the list falls back to the owner avatar |
| `dsh.bundle.patch` | present |
| Topic | `dsh-plugin` present |

Proposed YAML:

```yaml
url: https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard
name: jlnkx5200-beep/dsh-task-checkpoint-guard
category: memory
description:
  en: 'Local task checkpoints and bounded recovery for DSH, with optional L0–L3 hierarchical memory, dependency-aware retrieval, prerequisite-aware context, and six opt-in memory tools.'
  zh: '为 DSH 提供本地任务检查点与有界恢复，并可选启用 L0–L3 层级记忆、依赖感知检索、先修知识上下文和六个按需启用的记忆工具。'
tarball: https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/releases/download/v0.2.0/dsh-task-checkpoint-guard-0.2.0.tgz
```

The tarball URL was downloaded on 2026-11-04 and matched SHA-256
`66fbc4a4ffe6ce0ffee6f9d795d06588758b751ab777b0ee73b24dada9973af0`.
The list supports the optional `tarball:` field for GitHub Releases.

## 2. Pre-submission verification

- [x] Package version is `0.2.0`.
- [x] `package.json` declares `dsh.bundle.patch`.
- [x] `cordis.patch.yml` is present and composes the bundle row.
- [x] Public tarball URL resolves and the SHA-256 matches.
- [x] Release tarball installs into a disposable DSH profile.
- [x] Disposable `--dump-config` contains `id: task-checkpoint-guard`.
- [x] `dsh-plugin` topic is present.
- [x] Repository is older than one day and actively maintained.
- [x] `v0.2.0` Tag and Release exist; v0.1.0 is preserved.
- [x] Main CI passes all four Node/OS jobs on the final verified commit.
- [x] `v0.2.0..main` contains only documentation and test-harness changes,
  with no plugin source changes.
- [x] Automated test evidence is reproducible from the documented environment.
- [x] The semantic pilot is described as a four-case, single-run pilot.
- [x] No security-audit claim is made.
- [ ] API key used in the semantic pilot has been rotated in the provider console.
- [ ] The awesome PR changes exactly one new YAML file and no existing entries.
- [ ] The generated README files are not hand-edited in the PR.

## 3. Pull request format

Branch:

```text
add/dsh-task-checkpoint-guard
```

Create a fork of `awesome-dsh-plugin/awesome-dsh-plugin`, then add exactly one
file:

```text
data/plugins/jlnkx5200-beep__dsh-task-checkpoint-guard.yml
```

Do not manually edit `README.md` or `README.zh.md`; they are generated after
merge. For a local preview, run the target repository's checks:

```sh
npm ci
node scripts/generate-readme.mjs
```

For the actual submission commit, stage only the new YAML file. Do not modify
other plugin entries.

## 4. Proposed PR description

```markdown
## Add dsh-task-checkpoint-guard

- Repository: https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard
- Release: v0.2.0
- Category: memory
- License: MIT

### What it does

Provides durable local task checkpoints and bounded recovery for DeepSeek Harness agents.

The optional hierarchical memory subsystem provides:

- L0–L3 layered memory records.
- Independent priority, feasibility, and confidence classification.
- A concept dependency graph with multiple prerequisites and cycle detection.
- Prerequisite-aware context retrieval and learning-state transitions.
- Six opt-in memory tools.

### Design and compatibility

- Memory is disabled by default.
- The memory document has an independent schema and storage path.
- Existing v0.1.0 checkpoint behavior is preserved when memory is disabled.
- Hidden chain-of-thought is not persisted.
- Task and memory records remain local.
- The plugin uses documented DSH extension points.

### Verification

- Automated tests pass using the documented test suite.
- Real Cordis Loader and DSH ToolRuntime integration have been verified against DSH 0.2.1-rc.3.
- A four-case, single-run DeepSeek semantic pilot has been completed.
- The semantic pilot is not presented as statistically validated model improvement.

Documentation:
- README: https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard
- Architecture: https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/blob/main/docs/architecture.md
- Testing: https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/blob/main/docs/testing.md
- Semantic pilot: https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/blob/main/docs/semantic-acceptance-report-2026-11-04.md
```

Only retain specific test counts if the exact output is reproducible from the
submitted commit and documented environment.

## 5. Final submission procedure

1. Confirm the API key used for the semantic pilot has been rotated.
2. Fork the target repository.
3. Clone the fork and create `add/dsh-task-checkpoint-guard`.
4. Add the single YAML entry from `docs/awesome-dsh-plugin-entry.yml`.
5. Inspect the staged diff.
6. Run local checks if desired.
7. Commit and push.
8. Open one PR against the upstream `main` branch.
9. Wait for automatic CI.
10. Respond to maintainer comments with exact file paths and test evidence.

Do not modify other plugin entries.

Do not promise a merge date.

Do not create another Release unless the v0.2.0-to-main comparison identifies
actual source changes that require a new version. The current comparison shows
only docs and test-harness changes.

## 6. Stop conditions

Pause submission if:

- API credential rotation is incomplete.
- Public installation fails.
- Current `main` contains unverified plugin source changes.
- The release tarball fails checksum verification.
- The listing description overstates the actual prerequisite guard.

The objective is an accurate, reproducible, and maintainable contribution, not
merely a green CI result.
