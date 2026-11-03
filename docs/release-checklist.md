# Release checklist

This is the release gate for `dsh-task-checkpoint-guard`. A checked box means it was verified for the local release candidate; it does not imply that a remote GitHub or npm operation was performed.

## Source preservation

- [x] Original plugin backed up before independent project creation to a timestamped sibling directory (`dsh-task-checkpoint-guard-backup-20261102-222932`).
- [x] Original plugin directory left in place and not overwritten.
- [x] Independent project directory created as `./dsh-task-checkpoint-guard`.
- [x] No DSH workspace, profile, credentials, ComfyUI project, or unrelated user data copied into the project.

## Audit

- [x] Current original source files inspected (`package.json`, bundle patch, `lib/index.js`, `lib/state.js`, README).
- [x] No tests were found in the original plugin directory; historical “tests passed” claims are not treated as evidence.
- [x] Original absolute provider/profile paths, hardcoded provider URL and credential reference, and a developer-specific Windows user checkpoint path were identified and removed from the independent project.
- [x] Original use of deprecated `session.snapshotEvents()` avoided in the independent implementation.
- [x] Public DSH services/events documented in `docs/architecture.md`.
- [x] No private DSH imports, sibling-plugin internals, local private patches, or user credentials used.
- [x] Compatibility range declared in `engines.dsh`.
- [x] Optional services and goal-round-driver requirement documented.

## Package

- [x] Package name `dsh-task-checkpoint-guard`.
- [x] Version `0.1.0`.
- [x] `type: module`.
- [x] Valid `main`/`exports` entry.
- [x] `dsh.bundle.patch` points to `cordis.patch.yml`.
- [x] Node engine range declared.
- [x] DSH engine range declared.
- [x] No npm runtime dependencies.
- [x] `files` whitelist excludes tests and development files from the npm tarball.
- [x] `npm pack --dry-run` succeeds.
- [x] Actual sanitized `npm pack` tarball produced (`dsh-task-checkpoint-guard-0.1.0.tgz`, SHA-256 `9ee63e2dc9eb573700e5dbda08de5e74593120da10c89406a9621424547fa470`).
- [x] npm tarball excludes tests, GitHub metadata, release working notes, package-lock, and local runtime data.
- [x] Repository owner and GitHub URLs use `jlnkx5200-beep/dsh-task-checkpoint-guard`.
- [x] Final license selected and applied: MIT, copyright (c) 2026 jlnkx5200-beep.

## Tests

- [x] Configuration Standard Schema/defaults/negative cases.
- [x] JSON checkpoint write/read.
- [x] Atomic write and `.previous` protection.
- [x] Corrupt target falls back to previous.
- [x] Corrupt pointer falls back to pointer previous / task scan.
- [x] Concurrent in-process writes leave valid documents.
- [x] State transitions and failure classification.
- [x] Network exception simulation.
- [x] Readiness probe success, 401, 503 exhaustion, missing credentials.
- [x] Goal re-arm with compare-and-set fake service.
- [x] Paused goal is not silently resumed.
- [x] Human input cancels in-flight recovery.
- [x] Exact duplicate tool guard and automatic clear after first resumed turn.
- [x] Unknown tool outcome is surfaced and guarded.
- [x] Hidden reasoning text exclusion.
- [x] Credential redaction and no secret in JSON/Markdown.
- [x] `ctx.sessionQuery` history reconciliation.
- [x] Plugin disposal and fresh remount.
- [x] Real Cordis plugin-loader smoke against DSH `0.2.1-rc.3`.
- [x] Tarball install into a clean temporary DSH home, config dump, remove, and reinstall.
- [ ] Full interactive DSH model round under the installed tarball (not performed; no test provider was configured in the temporary home).
- [ ] Other DSH versions in range.
- [ ] Local Linux/macOS execution.
- [ ] GitHub Actions execution on the remote repository.

## Privacy and security scan

- [x] Final sensitive-information scan completed (see `docs/release-report.md`).
- [x] Tarball inspected for checkpoint data, logs, credentials, sessions, and local paths.
- [x] No `.credentials.yaml`, session files, real checkpoints, or user task data included.
- [x] No hardcoded provider-specific API endpoint or credential reference in `src/`.
- [x] No API keys written to checkpoint state.
- [x] No hidden CoT written to checkpoint state.
- [x] Local-only storage and no remote sync documented.
- [x] Probe redirects rejected and bearer HTTPS enforced outside loopback.
- [x] File mode `0600` requested; Windows ACL caveat documented.
- [x] Multi-process limitation documented.

## Documentation

- [x] English README.
- [x] Simplified Chinese README.
- [x] Architecture documentation with Mermaid diagram.
- [x] Configuration documentation with every field, type, default, range, purpose, and security impact.
- [x] Troubleshooting guide.
- [x] Example configuration.
- [x] Security policy.
- [x] Contributing guide.
- [x] Changelog.
- [x] License decision aid.
- [x] Release notes draft.
- [x] License finalized as MIT.

## GitHub publication readiness

- [x] `.gitignore` excludes dependencies, logs, checkpoints, credentials, and package artifacts.
- [x] `.npmignore` excludes tests, GitHub metadata, and local runtime data.
- [x] GitHub Actions matrix configured for Node 22.19/24.x on Ubuntu/Windows.
- [x] Local Git repository initialized with the sanitized identity and a single clean commit (`1a525a4`).
- [x] Remote repository created: `jlnkx5200-beep/dsh-task-checkpoint-guard`.
- [x] Remote configured and first push performed.
- [x] GitHub Actions green on the target repository:
  <https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/actions/runs/41583854293>.
- [x] GitHub Release created from `v0.1.0` and tarball attached:
  <https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/releases/tag/v0.1.0>.

## Final approval

- [x] License approved by copyright owner: MIT.
- [x] Repository owner/homepage/bugs URLs configured for `jlnkx5200-beep`.
- [x] Release notes reviewed for identity leaks.
- [x] Clean remote publication explicitly authorized by the user.

**Clean v0.1.0 GitHub publication is complete. npm publication remains a separate, unperformed decision.**
