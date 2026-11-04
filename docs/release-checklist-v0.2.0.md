# v0.2.0 release checklist

## Code and package

- [x] Version is `0.2.0` in `package.json` and `package-lock.json`.
- [x] `memoryEnabled` defaults to `false`.
- [x] Existing checkpoint schemaVersion remains `1`.
- [x] No npm runtime dependencies.
- [x] `npm run check` passes with `DSH_CHECKOUT`.
- [x] 81 automated tests pass with 0 failures and 0 skips.
- [x] Real DSH ToolRuntime schema registration and execution pass.
- [x] `npm pack --dry-run` succeeds.
- [x] Generated tarball contains no API key or real user data.

## Documentation

- [x] README and README.zh-CN describe opt-in memory.
- [x] Architecture, configuration, testing, semantic acceptance, and
  troubleshooting docs updated.
- [x] CHANGELOG entry dated 2026-11-04.
- [x] v0.2.0 release notes prepared.
- [x] awesome-dsh-plugin submission plan prepared.
- [x] Real-model pilot report and sanitized raw output committed.
- [x] Pilot is described as pilot-only, not statistical validation.

## Git and GitHub

- [x] Feature branch contains the verified implementation.
- [x] v0.1.0 tag and Release are preserved.
- [x] Merge the verified feature branch into `main`.
- [x] Push `main`.
- [x] Push the feature branch for traceability.
- [x] Create annotated tag `v0.2.0`.
- [x] Create GitHub Release `v0.2.0` with tarball and SHA-256 asset.
- [x] Add repository topic `dsh-plugin`.
- [x] Verify the public repository renders the v0.2.0 README and release.
- [ ] Submit the awesome-dsh-plugin PR separately.

Release: <https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard/releases/tag/v0.2.0>

Release commit: `ea7f51b41f197fb6e43ce6fbaeba58ad57d13646`

Release assets:

- `dsh-task-checkpoint-guard-0.2.0.tgz`
- `dsh-task-checkpoint-guard-0.2.0.tgz.sha256`

Tarball SHA-256:

```text
66fbc4a4ffe6ce0ffee6f9d795d06588758b751ab777b0ee73b24dada9973af0
```

GitHub Actions:

- main push: successful run `41843474059`
- feature branch push: successful run `41843473741`
- tag push: successful run `41843510556`

## Security

- [ ] Revoke the temporary evaluation API key used for the pilot in the provider console.
- [x] Confirm no `.env.eval` or real key is committed.
- [x] Treat the key as exposed because it appeared in the interactive session.

## Boundaries

- [x] No private DSH APIs or model endpoints used.
- [x] No hidden reasoning stored in checkpoints, memory, or semantic reports.
- [x] No statistical semantic-quality claim.
- [x] No push/tag/release performed before explicit release instruction.
