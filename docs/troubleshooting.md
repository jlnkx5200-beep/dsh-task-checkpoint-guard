# Troubleshooting

Start by identifying which half of the plugin failed: **checkpointing** or **recovery**.

## No checkpoint files are created

### Check that the bundle is installed

```sh
dsh plugin --profile <profile> why dsh-task-checkpoint-guard
dsh --profile <profile> --dump-config
```

The composed configuration should contain a row with:

```yaml
id: task-checkpoint-guard
name: dsh-task-checkpoint-guard
```

### Check the effective root

The default is `$DSH_HOME/task-checkpoints`. If `DSH_HOME` is unset, DSH uses its normal home directory (typically `~/.dsh`). If you set `checkpointRoot`, confirm it is absolute or starts with `~/`.

### Check permissions

The plugin requests `0600` files and owner-only directories. On Windows, directory ACLs are the effective control. Verify the DSH process can create and rename files in the root.

### Check the host services

The plugin requires `agents` and `sessions`; it will not mount without them. Load errors for missing services are shown by the DSH profile/plugin loader.

### Check startup errors

If the plugin configuration fails validation, the profile can fail to load or omit the plugin row. Run:

```sh
dsh --profile <profile> --dump-config
```

Then inspect DSH host logs for `task-checkpoint-guard`. Configuration errors never silently fall back to defaults.

## A checkpoint is corrupt

The loader tries the task file, then `<file>.previous`, then a scan of matching task JSON files. If a previous copy is valid, the plugin logs a debug/warning and continues.

If both copies are invalid:

1. Stop writing to the profile if possible.
2. Preserve the whole checkpoint directory for diagnosis.
3. Do not publish the files; they contain task data.
4. The next successful write can start a new valid target. The loader will not silently treat an unknown schema version as current.

The Markdown copy is human-readable but is not authoritative for restoration.

## Automatic recovery did not happen

Check each condition in order:

1. **`recoveryMode` is `off` by default.** Enable `probe` or `deferred` explicitly.
2. **The failure was not classified as recoverable.** Authentication/request errors, aborts, max-token stops, partial streams, and unknown errors deliberately do not auto-resume.
3. **A tool call is still pending.** The session may have a durable `tool/call` without a result. DSH usually repairs this with a synthetic `TOOL_OUTCOME_UNKNOWN` result; until the call is settled, the checkpoint guard refuses to resume.
4. **A human message arrived.** The plugin aborts the readiness wait and marks the interruption as manually overridden.
5. **The agent is not idle** or its inbox has pending input.
6. **There is no current goal.** The plugin only resumes an existing active DSH goal.
7. **The goal is paused, blocked, complete, already armed, or out of rounds.** Automatic recovery only resumes active + disarmed goals with budget remaining.
8. **The goal revision changed.** The compare-and-set resume fails closed.
9. **The retry budget is exhausted.** See `maxAutoResumes`.
10. **The goal-round driver is absent.** The goal may be re-armed and context injected, but no new model turn is scheduled.

Inspect the JSON checkpoint's `interruption`, `recovery.lastOutcome`, `recovery.blockedReason`, and `recovery.note` fields.

## Probe keeps failing

- Confirm DNS, proxy, and TLS reachability from the DSH process, not just your browser.
- Try the endpoint manually with the same method and headers.
- A `404` means the endpoint path is wrong.
- A `401`/`403` means the network is reachable but auth is missing or rejected. The plugin intentionally stops rather than starting a model round.
- A `5xx` is treated as not ready and retried until `maxProbeAttempts`.
- A timeout aborts after `probeTimeoutMs`.

## Bearer probe rejected at configuration time

The schema rejects `probeAuth: bearer` over plain HTTP unless the host is loopback. Use HTTPS. For local testing:

```yaml
recoveryMode: probe
probeUrl: http://127.0.0.1:PORT/health
probeAuth: bearer
credentialRef: LOCAL_TEST_KEY
```

The credential must still resolve through DSH's credentials service.

## A tool call was denied after recovery

This is the recovery duplicate guard. It denies an exact `(tool name, canonical arguments)` match when that call:

- completed before the interruption; or
- has an unknown outcome.

The denial text asks the model to use the recorded result or verify current external/workspace state with a different operation. The guard is only active during the first resumed turn and clears at `turn/end`.

To disable the guard:

```yaml
duplicateToolPolicy: off
```

Disabling it falls back to instructions in the recovery context, which are advisory only.

## `TOOL_OUTCOME_UNKNOWN` appears in recovery context

DSH records a synthetic tool result when a durable `tool/call` has no matching result at session recovery. The exact external effect is unknown.

The plugin tells the model not to retry blindly. For a read-only or idempotent operation, a retry may still be reasonable after inspection. For a side-effecting operation, verify external state or ask the user. The plugin does not know which tools are safe to repeat.

## Permission denied while writing a checkpoint

- The configured `checkpointRoot` may point inside a read-only or sandboxed directory.
- On Windows, an antivirus/indexer may briefly lock a target during rename. The writer retries the rename-over-existing fallback but cannot guarantee indefinite retry.
- Do not point the checkpoint root at a network share with unreliable rename/fsync semantics.
- Use a directory owned by the DSH process.

## Checkpoints take too much disk space

Tune:

- lower `maxToolHistory`;
- lower `maxToolResultChars`;
- lower `maxToolArgumentChars`;
- increase `persistDebounceMs` for low-priority events.

Checkpoint retention/cleanup is a roadmap item; there is no automatic
checkpoint deletion. The optional memory subsystem has its own bounded capacity
policy, but it never deletes L0/L1 or unfinished prerequisite data to satisfy a
count limit. Delete old task files manually only after confirming the
associated sessions no longer need recovery.

## The plugin loads but does not resume after a host restart

1. Confirm the same session is resumed and the checkpoint exists.
2. If `sessionQuery` is unavailable, events between the last checkpoint and the crash may not be replayed.
3. After session resume DSH disarms active goals. The guard waits for an active + disarmed goal before resuming.
4. Ensure `recoveryMode` is not `off`.
5. A hard crash may leave a partial session record; DSH's session repair should append a synthetic unknown tool result before the checkpoint guard is willing to continue.

## DSH says the plugin's version range is unsupported

The package declares:

```json
"engines": {
  "dsh": ">=0.2.1-rc.3 <0.3.0"
}
```

Upgrade DSH or install a plugin release whose declared range matches. Do not bypass the range check unless you are prepared to test the public API surface yourself.

## DSH version compatibility questions

The plugin does not import private DSH source. It relies on public services/events listed in [architecture.md](architecture.md#public-api-dependencies). Only DSH `0.2.1-rc.3` has been locally verified in this release. Other versions in the declared range may work, but that is not a tested guarantee.

## Uninstall does not remove task history

This is intentional. Remove the checkpoint root manually only when you no longer need the data:

```powershell
Remove-Item -Recurse -Force "$HOME\.dsh\task-checkpoints"
```

Before deleting, confirm the path is exactly the checkpoint root and does not contain unrelated user data.

## Memory tools are missing

Memory is off by default. Confirm:

1. `memoryEnabled: true` in the effective profile config.
2. The host provides a public `ctx.tools` registry. Without it, checkpointing
   and recovery still load, but the six memory tools are inactive.
3. The host provides `ctx.systemPrompt` if automatic context injection is
   expected. The curated prompt section is not registered when that seam is
   absent.
4. The profile was restarted after enabling the feature. The loader validates
   unknown fields; `memoryRoot` is rejected unless `memoryEnabled` is true.

The plugin logs a warning when memory is enabled but a tool or prompt registry
is absent.

## Memory file is not created

A memory document is written only after relevant information is captured. A
fresh profile with no human message has no memory document. Check:

- `memoryRoot` (default `$DSH_HOME/task-memory`);
- `memoryScopeId` (default `default-user`);
- whether the profile uses a different `DSH_HOME`;
- directory permissions for atomic rename and `fsync`.

Memory and checkpoint files are separate. Creating a checkpoint does not
guarantee that a memory document exists.

## A concept transition was blocked

`concept_status` rejects `start` or `complete` when:

- a necessary prerequisite is not `EXPLAINED` or `VERIFIED`;
- the visible `plannedText` mentions an undeclared queued concept;
- the dependency graph contains a cycle or missing prerequisite node;
- the requested state transition is invalid.

Read the returned `guard.violations` and
`guard.requiredActions`. Explain the prerequisite separately, then retry with
the correct `usedConceptIds`. Do not bypass the guard by editing memory files.

## A concept will not become VERIFIED

`VERIFIED` requires explicit evidence from the user:

- `USER_CONFIRMATION`;
- `USER_APPLICATION`;
- `USER_FEEDBACK`.

A model statement, a completed assistant response, or a tool argument is not
user evidence. The check is enforced in `state-transition.js`; it is not just a
prompt instruction.

## Memory grows too large

Tune:

- `maxMemoryRecords`;
- `maxMemoryConcepts`;
- `maxMemoryRecordChars`;
- `maxMemoryContextChars` and `maxMemoryContextTokens`.

L0/L1 and unfinished core prerequisites are protected. L3 records are
compressed/evicted first, and compressed records retain their id, topic,
digest, source references, and layer. Explicit `memory_search` can retrieve
retained details.

## Concurrent memory writes

All agents in one DSH process share a per-file lock and serialize read-modify-
write cycles. If two DSH processes point at the same `memoryRoot` and scope,
there is no cross-process lock. Use one owning process per memory root/scope.

## Real-model semantic evaluation

`npm run test:semantic:dry-run` needs no credentials and shows the exact prompts.
`npm run test:semantic` needs `DSH_EVAL_BASE_URL`, `DSH_EVAL_API_KEY`, and
`DSH_EVAL_MODEL`. It is an offline maintainer tool, not a runtime dependency.
No model-level improvement should be claimed without saving and reviewing its
report. See [semantic-acceptance.md](semantic-acceptance.md).
