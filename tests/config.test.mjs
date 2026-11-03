import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { Config, resolveCheckpointRoot } from '../src/config.js'

function validate(input) {
  return Config['~standard'].validate(input)
}

test('config schema is synchronous Standard Schema and fills safe defaults', () => {
  const result = validate({})
  assert.equal(result.issues, undefined)
  assert.equal(result.value.recoveryMode, 'off')
  assert.equal(result.value.probeAuth, 'none')
  assert.equal(result.value.duplicateToolPolicy, 'deny-on-recovery')
  assert.equal(result.value.maxProbeAttempts, 5)
  assert.equal(result.value.persistDebounceMs, 100)
  assert.equal(result.value.checkpointRoot, undefined)
  assert.equal(result.value.providerFilter, null)
  assert.equal(result.value.reconstructFromSessionQuery, true)
})

test('checkpointRoot accepts absolute and ~/ paths and rejects relative paths', () => {
  const absolute = validate({ checkpointRoot: path.join(path.sep, 'tmp', 'guard-checkpoints') })
  assert.equal(absolute.issues, undefined)

  const tilde = validate({ checkpointRoot: '~/guard-checkpoints' })
  assert.equal(tilde.issues, undefined)
  assert.ok(path.isAbsolute(tilde.value.checkpointRoot))

  const relative = validate({ checkpointRoot: 'relative/checkpoints' })
  assert.ok(relative.issues.some(item => item.path?.[0] === 'checkpointRoot'))
})

test('probe mode requires an absolute http(s) URL and rejects embedded credentials', () => {
  const missing = validate({ recoveryMode: 'probe' })
  assert.ok(missing.issues.some(item => item.path?.[0] === 'probeUrl'))

  const badScheme = validate({ recoveryMode: 'probe', probeUrl: 'file:///tmp/probe' })
  assert.ok(badScheme.issues.some(item => item.path?.[0] === 'probeUrl'))

  const embedded = validate({
    recoveryMode: 'probe',
    probeUrl: 'https://user:password@example.test/health',
  })
  assert.ok(embedded.issues.some(item => item.path?.[0] === 'probeUrl'))

  const good = validate({ recoveryMode: 'probe', probeUrl: 'https://example.test/health' })
  assert.equal(good.issues, undefined)
})

test('bearer probes require a credential ref and https outside loopback', () => {
  const missingRef = validate({
    recoveryMode: 'probe',
    probeUrl: 'https://example.test/health',
    probeAuth: 'bearer',
  })
  assert.ok(missingRef.issues.some(item => item.path?.[0] === 'credentialRef'))

  const plainHttp = validate({
    recoveryMode: 'probe',
    probeUrl: 'http://example.test/health',
    probeAuth: 'bearer',
    credentialRef: 'EXAMPLE_API_KEY',
  })
  assert.ok(plainHttp.issues.some(item => item.path?.[0] === 'probeUrl'))

  const loopback = validate({
    recoveryMode: 'probe',
    probeUrl: 'http://127.0.0.1:1234/health',
    probeAuth: 'bearer',
    credentialRef: 'EXAMPLE_API_KEY',
  })
  assert.equal(loopback.issues, undefined)
})

test('invalid enums, unknown fields, and out-of-range values fail loudly', () => {
  const result = validate({
    recoveryMode: 'sometimes',
    duplicateToolPolicy: 'block-everything',
    unknownSetting: true,
    probeTimeoutMs: 10,
    maxProbeAttempts: 100,
    jitterRatio: 2,
  })
  const fields = new Set(result.issues.map(item => item.path?.[0]))
  for (const field of ['recoveryMode', 'duplicateToolPolicy', 'unknownSetting', 'probeTimeoutMs', 'maxProbeAttempts', 'jitterRatio']) {
    assert.ok(fields.has(field), `expected issue for ${field}`)
  }
})

test('backoff maximum must not be lower than the initial delay', () => {
  const result = validate({ initialProbeDelayMs: 5000, maxProbeDelayMs: 1000 })
  assert.ok(result.issues.some(item => item.path?.[0] === 'maxProbeDelayMs'))
})

test('probeExpectedStatuses only accepts HTTP status integers', () => {
  const good = validate({ probeExpectedStatuses: [200, 204, 200] })
  assert.deepEqual(good.value.probeExpectedStatuses, [200, 204])
  const bad = validate({ probeExpectedStatuses: [200, 99, 600] })
  assert.ok(bad.issues.some(item => item.path?.[0] === 'probeExpectedStatuses'))
})

test('resolveCheckpointRoot prefers configured path, then DSH home, then the environment fallback', () => {
  const configured = path.join(path.sep, 'custom', 'checkpoints')
  assert.equal(resolveCheckpointRoot(configured, path.join(path.sep, 'ignored')), path.normalize(configured))
  const fromDsh = resolveCheckpointRoot(undefined, path.join(path.sep, 'dsh-home'))
  assert.equal(fromDsh, path.join(path.sep, 'dsh-home', 'task-checkpoints'))

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(path.sep, 'env-home')
  try {
    assert.equal(
      resolveCheckpointRoot(undefined),
      path.join(path.sep, 'env-home', 'task-checkpoints'),
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
