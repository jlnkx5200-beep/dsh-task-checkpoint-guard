# v0.1.0 Release Notes (draft)

**Release type:** first public release

**Suggested tag:** `v0.1.0`

**Suggested title:** `dsh-task-checkpoint-guard v0.1.0 — durable checkpoints for DSH tasks`

## Summary

First standalone release of `dsh-task-checkpoint-guard`, a host-side DeepSeek Harness bundle for durable task checkpoints and bounded recovery after transport/service interruptions.

## Highlights

- Local JSON/Markdown/session-pointer checkpoints with atomic writes and a previous valid copy.
- Structured task state: objective, goal revision, todos, turn/step, tool lifecycle, and bounded visible results.
- Conservative failure classification with automatic recovery disabled by default.
- Optional authenticated readiness probing with timeout, exponential backoff, and jitter.
- Compare-and-set re-arm of an active, disarmed DSH goal, followed by structured context injection.
- Exact duplicate tool-call guard for the first resumed turn.
- Hidden reasoning text is never stored.
- No npm runtime dependencies and no private DSH imports.

## Compatibility

- DSH: declared range `>=0.2.1-rc.3 <0.3.0`; locally verified against `0.2.1-rc.3`.
- Node.js: `^22.19.0 || >=24.0.0`.
- Automatic continuation requires the DSH goal service and goal-round driver.

## Installation

```sh
npm pack
dsh plugin --profile <profile> add ./dsh-task-checkpoint-guard-0.1.0.tgz
dsh --profile <profile> --dump-config
```

## Configuration

The package defaults to:

```yaml
- id: task-checkpoint-guard
  name: dsh-task-checkpoint-guard
  config:
    recoveryMode: off
```

To enable automatic recovery, configure `recoveryMode: probe` with a real readiness endpoint and credential reference. See `docs/configuration.md`.

## Security

- Checkpoints are local-only.
- Credentials are resolved per probe and never persisted.
- Probe redirects are rejected; bearer probes require HTTPS outside loopback.
- Redaction is heuristic; do not put secrets in prompts or tool arguments.
- Released under the MIT License.

## Known limitations

- Only DSH `0.2.1-rc.3` has been locally verified.
- No cross-process checkpoint writer coordination.
- No automatic retention/cleanup or encryption.
- Duplicate guard is fingerprint-based and first-resumed-turn only.
- Manual recovery may be required without a goal-round driver.
- A real-model recovery drill remains required before advertising automatic
  recovery as fully field-tested.

## License

MIT License. Copyright (c) 2026 jlnkx5200-beep. See [LICENSE](../LICENSE).

## Verification summary

Local Windows 11 / Node 24.21.0 / DSH 0.2.1-rc.3:

- 52 tests passing locally, including real Cordis loader loading.
- Clean temporary-profile tarball install, config dump, remove, and reinstall.
- GitHub Actions green on Ubuntu and Windows with Node.js 22.19 and Node.js 24.
- Tarball produced with `npm pack`.
- See `docs/release-report.md` for the verification matrix.
