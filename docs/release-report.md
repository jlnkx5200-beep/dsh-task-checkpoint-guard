# Release candidate report

Project: `dsh-task-checkpoint-guard`

Version: `0.1.0`

Release type: public GitHub release

Date: 2026-11-03

## 1. Deliverable location

The independent candidate project is the `dsh-task-checkpoint-guard/` directory containing this document. It is separate from the original plugin directory and does not modify the active DSH profile.

The original plugin was copied to a timestamped sibling backup before work began. The backup name is recorded in [release-checklist.md](release-checklist.md).

## 2. Original-code audit

The original directory contained only:

- `package.json`
- `cordis.patch.yml`
- `README.md`
- `lib/index.js`
- `lib/state.js`

**No test files were present in the original plugin directory.** Historical descriptions of state, atomic-write, CoT-exclusion, network, goal, and duplicate-call tests are therefore not accepted as evidence for this report. All results below come from the new independent test suite.

Confirmed issues in the original implementation:

1. Hardcoded provider id, provider-specific probe URL, and credential reference.
2. Hardcoded developer path in `cordis.patch.yml` and README.
3. `private: true`, no license, no repository metadata, and no package lock.
4. No exported configuration schema; defaults were normalized ad hoc.
5. Used deprecated `session.snapshotEvents()` for production reconstruction.
6. Resume policy accepted paused goals, which can override an intentional human pause.
7. Session pointer stored an absolute task path.
8. Checkpoint files were not all committed as one serialized set; no per-session writer lock.
9. Loaded task JSON was not strictly normalized/validated.
10. In-memory `states`/`pendingRecovery` maps had no `agent/disposed` cleanup.
11. A checkpoint write failure mutated live state but did not produce a durable failure checkpoint.
12. The “prevent repeated tool execution” behavior was advisory text only; there was no tool-pipeline enforcement.
13. The original recovery relied on a `agent/pre-step` wrapper and a custom user message rather than the documented `agent.inject()` context path.
14. The original project did not contain a reproducible DSH loader smoke, clean-profile installation test, security scan, or compatibility matrix.

The original code did already avoid persisting reasoning text and did count reasoning blocks/characters; the new implementation retains that property and tests it.

## 3. New architecture and fixes

- Independent ESM, dependency-free runtime with Standard Schema config validation.
- Pure state/redaction/storage/recovery modules and a small Cordis lifecycle entry.
- No runtime imports from any `@deepseek-ai/*` package.
- JSON + Markdown + relative session pointer storage.
- Atomic temp-file/fsync/rename writes with previous-copy retention and loader fallback.
- Serialized per-session writer and event queues.
- Strict checkpoint normalization and schema-version rejection.
- Conservative failure classifier and fail-closed recovery policy.
- Optional authenticated readiness probe with redirect rejection and HTTPS enforcement outside loopback.
- Goal resume only for active + disarmed goals with revision, provider, round-budget, liveness, idle, and inbox fences.
- Context injection through public `agent.inject()`.
- Exact duplicate tool guard for the first resumed turn.
- Optional `ctx.sessionQuery` reconciliation instead of deprecated event snapshots.
- Bounded tool history/results/arguments/context and secret-shape redaction.

## 4. Public API / compatibility audit

### Used public interfaces

| Interface | Status |
|---|---|
| `ctx.agents.get/list` | Public documented core service |
| `session/event` | Public durable event feed |
| `agent/created`, `agent/error`, `agent/status`, `agent/disposed` | Public documented events |
| `agent.inject(UserMessage)` | Public documented agent method |
| `agent.inbox.nextTurn/nextStep` | Public documented inbox state |
| `ctx.get('goals').get/resume/disarm` | Public documented goal service |
| `ctx.get('credentials').resolve` | Public documented credential seam |
| `ctx.get('sessionQuery').readSession` | Public documented query service |
| `ctx.get('dshHomePath')` | Public host path service; optional fallback |
| `tools/pre-execute` | Public documented tool waterfall |
| `ctx.on/effect/logger/get` | Public Cordis host API |

### Not used

- No private DSH packages or private source-file imports.
- No imports from another plugin's implementation.
- No local private patch interface.
- No deprecated `snapshotEvents()` call in the new production source.
- No hardcoded provider credential, provider-specific URL, or user home directory.

### Compatibility statement

Declared DSH range: `>=0.2.1-rc.3 <0.3.0`.

Locally verified DSH: `0.2.1-rc.3`.

The declared range is a release boundary, not a claim that every version in it was run. Other DSH versions remain untested.

## 5. Local verification matrix

Environment:

- Windows 11 build `10.0.26300`, x64.
- Node.js `24.21.0`.
- npm `11.19.0`.
- DSH `0.2.1-rc.3`.

### Automated tests

Command with real-loader environment:

```text
DSH_CHECKOUT=<deepseek-harness checkout> npm test
```

Result:

- 52 tests passed.
- 0 failed.
- 0 skipped.
- Real Cordis loader test executed and passed.

Command without `DSH_CHECKOUT`:

- 51 passed.
- 1 skipped (real Cordis loader test).
- 0 failed.

Coverage (non-loader suite, 48 tests):

- Line: 82.78%
- Branch: 66.35%
- Function: 74.57%

### Real DSH CLI packaging smoke

Performed in a clean temporary `DSH_HOME`:

1. `npm pack` produced the sanitized `dsh-task-checkpoint-guard-0.1.0.tgz` (SHA-256 `9ee63e2dc9eb573700e5dbda08de5e74593120da10c89406a9621424547fa470`).
2. `dsh plugin --profile smoke add ./dsh-task-checkpoint-guard-0.1.0.tgz` initialized the profile and installed the bundle.
3. `dsh --profile smoke --dump-config` showed:
   - `# == dsh-task-checkpoint-guard`
   - `id: task-checkpoint-guard`
   - `name: dsh-task-checkpoint-guard`
4. `dsh plugin --profile smoke remove dsh-task-checkpoint-guard` removed both dependency and bundle entry.
5. Re-adding the tarball restored the bundle row.
6. The temporary DSH home was separate from the user's real profile.

Not performed in the clean profile: a full model-backed interactive round. The temporary home had no provider credentials, and no real user credentials were copied. The real Cordis loader test covers plugin activation; full model round behavior remains a pre-publication integration check.

## 6. Claim status

### Implemented and directly tested

- Structured checkpoint JSON/Markdown/pointer persistence.
- Atomic write and `.previous` fallback.
- Pointer fallback and task-file scan.
- Concurrent in-process writer serialization.
- Config defaults and validation.
- State transitions.
- Network/timeout/service/auth/abort classification.
- Probe success, retry, exhaustion, 401, missing credential.
- Bearer credential header behavior and absence from persisted files.
- Goal re-arm with compare-and-set revision.
- Paused-goal refusal.
- Human-input cancellation of recovery.
- Exact duplicate guard and first-turn clearing.
- Unknown tool outcome handling.
- Hidden reasoning exclusion.
- `ctx.sessionQuery` reconciliation.
- Plugin disposal and fresh mount.
- Real Cordis loader activation.
- CLI tarball install/dump/remove/reinstall.

### Simulated only

- Provider/network failures: simulated with fake session events and a loopback HTTP server.
- Goal service and goal-round driver: simulated with a fake goal service; no real provider round was run.
- Human cancellation race: simulated with a short readiness delay.
- Corrupt filesystem states: simulated with deliberate malformed files.

### Not verified

- DSH versions other than `0.2.1-rc.3`.
- Node.js 22.19 locally (workflow matrix configured but not run here).
- Linux/macOS local execution.
- Full interactive DSH model turn under the installed tarball.
- GitHub Actions on a remote repository.
- npm registry publication.
- Real-world idempotency semantics of arbitrary third-party tools.
- Independent external/subagent review: the available subagent runtime failed before returning findings on three attempts. No third-party review result is claimed; this report relies on the local static audit and the test evidence above.

## 7. Sensitive-information review

Scans performed:

- File-name scan for `.credentials.yaml`, session logs, `.previous`, `.pem`, `.key`, logs, and package-lock files in the published tarball.
- Secret-shape scan for private keys, bearer tokens, common API-key prefixes, GitHub/Slack/AWS token shapes, and hardcoded URLs.
- Absolute Windows user/workspace path scan.
- Provider-specific default/endpoint scan.
- Manual review of all matches.

Results:

- No `.credentials.yaml`, session files, real checkpoints, logs, private keys, or `.previous` files in the repository or npm tarball.
- No absolute user/workspace paths in the npm tarball.
- Test fixtures contain only synthetic tokens and are excluded from the npm tarball.
- Documentation contains placeholder credential references and example URLs only.
- No provider-specific endpoint or credential reference is hardcoded in runtime configuration; examples use explicit placeholders only.
- The build tarball is generated locally and ignored by Git.

Residual risk: redaction is heuristic and cannot detect arbitrary secrets embedded in natural language. Users must not place real credentials in prompts or tool arguments.

## 8. License and publication status

1. **License selected:** MIT License, copyright (c) 2026 jlnkx5200-beep.
2. **Target repository:** `jlnkx5200-beep/dsh-task-checkpoint-guard`.
3. The previous public artifact was revoked before this clean rebuild: its
   repository was made private, its release was deleted, and its tag was
   removed.
4. The old local Git history, tarballs, and temporary publication evidence were
   deleted; the replacement history starts from a clean tree.
5. No real name, personal email address, campus email, or old account
   identifier is present in the published content.
6. npm publication remains an independent, optional decision.

## 9. Publication record

Pending clean publication under the target account:

- Repository: <https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard>
- Initial commit: `1a525a40be075ed817b3e8b8b93e4bc6b1050fb8`
- Tagged release commit: `490e2f103f30c5cf72896f32c17b46dc4747c1d7`
- GitHub Actions: <https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/actions/runs/41583854293>
- Tag: `v0.1.0`
- Release: <https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/releases/tag/v0.1.0>
- Release asset: `dsh-task-checkpoint-guard-0.1.0.tgz`
- Asset SHA-256:
  `9ee63e2dc9eb573700e5dbda08de5e74593120da10c89406a9621424547fa470`
- Downloaded release asset matches the local package byte-for-byte.

npm publication remains an independent, optional decision. A real model-backed
recovery drill remains a post-publication acceptance task.

## 10. Future upgrade suggestions

- Add CI coverage for every DSH minor release in the declared range.
- Add a real host integration test with a deterministic mock provider.
- Add a per-tool idempotency/idempotency-key declaration so repeat protection can be safer and less binary.
- Add checkpoint retention, cleanup commands, and optional encryption-at-rest.
- Add subagent/multi-agent checkpoint trees.
- Add a read-only checkpoint browser.
- Add provider-neutral probe presets without hardcoding any specific provider.
- Add migration support when the checkpoint schema version changes.
- Add a Linux/macOS verification run before broadening platform claims.
