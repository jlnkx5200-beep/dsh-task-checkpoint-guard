# v0.2.1 — memory capture ordering fix

Released: 2026-11-04

## Fixed

- Human `user/message` events now await local memory capture before the host
  proceeds to prompt assembly when `memoryEnabled: true`. This prevents the
  first prompt on a slower host from missing the just-captured L1/L2 context.
- The memory integration test now waits for the asynchronous checkpoint writer
  instead of performing a single race-prone read.

## Compatibility

- Checkpoint schemaVersion remains `1`.
- `memoryEnabled` remains `false` by default.
- No DSH range change.
- v0.1.0 and v0.2.0 release tags stay in place.

## Verification

- Full documented suite with `DSH_CHECKOUT`: 81 passed, 0 failed, 0 skipped.
- GitHub Actions Node 22.19/24 on Ubuntu and Windows.
- Real Cordis loader and real DSH `ToolRuntime` smoke tests.
- Real-model semantic pilot remains a four-case, single-run pilot; no
  statistical semantic-quality result is claimed.

## Assets

- `dsh-task-checkpoint-guard-0.2.1.tgz`
- `dsh-task-checkpoint-guard-0.2.1.tgz.sha256`
