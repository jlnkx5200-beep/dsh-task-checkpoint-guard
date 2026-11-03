import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRecoveryMessage,
  probeDelay,
  probeOnce,
  sleep,
  waitForReadiness,
} from '../src/recovery.js'
import { createTaskState } from '../src/state.js'
import { makeSession, startProbeServer } from './helpers.mjs'

const baseConfig = {
  recoveryMode: 'probe',
  probeUrl: 'http://127.0.0.1:9/health',
  probeMethod: 'GET',
  probeAuth: 'none',
  probeExpectedStatuses: [],
  probeTimeoutMs: 1000,
  maxProbeAttempts: 2,
  initialProbeDelayMs: 0,
  maxProbeDelayMs: 10,
  jitterRatio: 0,
}

test('sleep resolves false immediately when aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  assert.equal(await sleep(1000, controller.signal), false)
  assert.equal(await sleep(0, new AbortController().signal), true)
})

test('probeDelay is exponential, capped, and jitter-bounded', () => {
  const config = { ...baseConfig, initialProbeDelayMs: 1000, maxProbeDelayMs: 3000, jitterRatio: 0 }
  assert.equal(probeDelay(config, 1), 1000)
  assert.equal(probeDelay(config, 2), 2000)
  assert.equal(probeDelay(config, 3), 3000)
  assert.equal(probeDelay(config, 4), 3000)
  const jittered = { ...config, jitterRatio: 0.5 }
  assert.ok(probeDelay(jittered, 1, () => 0) >= 500)
  assert.ok(probeDelay(jittered, 1, () => 1) <= 1500)
})

test('unauthenticated probe succeeds against a local endpoint without reading a body', async () => {
  const server = await startProbeServer({ status: 204, body: 'should-not-be-read' })
  try {
    const result = await probeOnce({ ...baseConfig, probeUrl: server.url }, undefined, new AbortController().signal)
    assert.equal(result.ok, true)
    assert.equal(result.status, 204)
    assert.equal(result.authenticated, false)
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0].method, 'GET')
    assert.equal(server.requests[0].headers.authorization, undefined)
  } finally {
    await server.close()
  }
})

test('bearer probe resolves the credential per call and sends only an authorization header', async () => {
  const server = await startProbeServer({ status: 200 })
  const resolved = []
  const credentials = {
    async resolve(ref) {
      resolved.push(ref)
      return { value: 'test-secret-token', source: 'test' }
    },
  }
  try {
    const result = await probeOnce(
      { ...baseConfig, probeUrl: server.url, probeAuth: 'bearer', credentialRef: 'TEST_API_KEY' },
      credentials,
      new AbortController().signal,
    )
    assert.equal(result.ok, true)
    assert.equal(result.authenticated, true)
    assert.deepEqual(resolved, ['TEST_API_KEY'])
    assert.equal(server.requests[0].headers.authorization, 'Bearer test-secret-token')
  } finally {
    await server.close()
  }
})

test('missing probe credentials fail closed without making a request', async () => {
  const server = await startProbeServer({ status: 200 })
  let called = 0
  try {
    const result = await probeOnce(
      { ...baseConfig, probeUrl: server.url, probeAuth: 'bearer', credentialRef: 'MISSING_KEY' },
      { async resolve() { return undefined } },
      new AbortController().signal,
    )
    called = server.requests.length
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'CREDENTIAL_NOT_CONFIGURED')
    assert.equal(called, 0)
  } finally {
    await server.close()
  }
})

test('waitForReadiness retries a 503 and then reports exhaustion', async () => {
  const server = await startProbeServer({ status: 503 })
  try {
    const result = await waitForReadiness(
      { ...baseConfig, probeUrl: server.url, maxProbeAttempts: 2, initialProbeDelayMs: 1 },
      undefined,
      new AbortController().signal,
    )
    assert.equal(result.ready, false)
    assert.equal(result.terminal, true)
    assert.equal(result.reason, 'probe-exhausted')
    assert.equal(result.attempts, 2)
    assert.equal(server.requests.length, 2)
  } finally {
    await server.close()
  }
})

test('a 401 is reachable but terminal, not a successful recovery signal', async () => {
  const server = await startProbeServer({ status: 401 })
  try {
    const result = await waitForReadiness(
      { ...baseConfig, probeUrl: server.url, maxProbeAttempts: 3, initialProbeDelayMs: 1 },
      undefined,
      new AbortController().signal,
    )
    assert.equal(result.ready, false)
    assert.equal(result.terminal, true)
    assert.equal(result.reason, 'credential-rejected')
    assert.equal(result.probe.reachable, true)
    assert.equal(server.requests.length, 1)
  } finally {
    await server.close()
  }
})

test('deferred mode does not make an outbound probe and waits only the configured delay', async () => {
  const result = await waitForReadiness(
    {
      ...baseConfig,
      recoveryMode: 'deferred',
      initialProbeDelayMs: 1,
      probeUrl: undefined,
    },
    undefined,
    new AbortController().signal,
  )
  assert.equal(result.ready, true)
  assert.equal(result.reason, 'deferred')
  assert.equal(result.probe, null)
})

test('recovery message has a system marker and a plugin source', () => {
  const state = createTaskState(makeSession('message-session'))
  state.originalInstruction = 'Resume this task.'
  state.status = 'INTERRUPTED'
  state.phase = 'INTERRUPTED'
  const message = createRecoveryMessage(state, 4000)
  assert.match(message.content[0].text, /SYSTEM-GENERATED RECOVERY CONTEXT/)
  assert.match(message.content[0].text, /Resume this task/)
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'task-checkpoint-guard')
  assert.equal(message.source.form, 'notice')
})
