import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { apply } from '../src/index.js'
import { loadCheckpoint } from '../src/storage.js'
import {
  makeAgent,
  makeFakeContext,
  makeFakeGoals,
  makeSession,
  makeTempRoot,
  removeTempRoot,
  startProbeServer,
  textMessageEvent,
  toolCallEvent,
  toolResultEvent,
  waitFor,
} from './helpers.mjs'

async function emitEvent(ctx, session, type, data) {
  const seq = Number(session.seq)
  const event = {
    type,
    seq,
    time: Date.now(),
    data,
  }
  await ctx.emitSession(session, event)
  return event
}

async function emitNetworkError(ctx, session, turn = 1) {
  return emitEvent(ctx, session, 'turn/end', {
    turn,
    reason: {
      kind: 'error',
      error: { code: 'ECONNRESET', message: 'socket hang up', name: 'LlmError' },
    },
  })
}

async function makeHost(options = {}) {
  const root = await makeTempRoot()
  const session = makeSession(options.sessionId ?? 'integration-session', 0, { agentPreset: 'test-preset' })
  const agent = makeAgent(session)
  const ctx = makeFakeContext({ agents: [agent], sessions: [session] })
  const goals = makeFakeGoals(ctx, options.goals ?? {})
  ctx.services.goals = goals.service
  if (options.credentials) ctx.services.credentials = options.credentials
  return { root, session, agent, ctx, goals }
}

async function applyPlugin(ctx, root, overrides = {}) {
  await apply(ctx, {
    checkpointRoot: root,
    persistDebounceMs: 0,
    ...overrides,
  })
}

async function readLoadedState(root, session) {
  return loadCheckpoint(root, session)
}

test('network interruption is checkpointed, probed, goal-rearmed, and context-injected', async () => {
  const server = await startProbeServer({ status: 200 })
  const host = await makeHost({ goals: { objective: 'Ship the checkpoint project.' } })
  try {
    await applyPlugin(host.ctx, host.root, {
      recoveryMode: 'probe',
      probeUrl: server.url,
      initialProbeDelayMs: 0,
      maxProbeDelayMs: 1,
      maxProbeAttempts: 2,
      probeTimeoutMs: 1000,
      maxAutoResumes: 3,
      duplicateToolPolicy: 'deny-on-recovery',
    })

    await host.ctx.emitSession(host.session, textMessageEvent(0, 'Ship the checkpoint project.'))
    await host.ctx.emitSession(host.session, toolCallEvent(1, 'call-1', 'shell', { cmd: 'echo hi' }))
    await host.ctx.emitSession(host.session, toolResultEvent(2, 'call-1', 'hi'))
    await emitNetworkError(host.ctx, host.session)
    host.agent.status = 'idle'
    await host.ctx.emit('agent/status', { agent: host.agent, status: 'idle' })

    await waitFor(() => host.goals.calls.resume === 1 && host.agent.injected.length === 1)
    const injected = host.agent.injected[0]
    assert.equal(injected.role, 'user')
    assert.equal(injected.source.kind, 'task-checkpoint-guard')
    assert.match(injected.content[0].text, /SYSTEM-GENERATED RECOVERY CONTEXT/)
    assert.match(injected.content[0].text, /shell \(call-1\) completed/)
    assert.equal(host.goals.service.snapshot().activation, 'armed')
    assert.equal(server.requests.length, 1)

    const loaded = await waitFor(async () => {
      const result = await readLoadedState(host.root, host.session)
      return result?.state?.recovery?.lastOutcome === 'goal-rearmed' ? result : undefined
    })
    assert.equal(loaded.state.recovery.duplicateGuardActive, true)
    assert.equal(loaded.state.status, 'RECOVERING')

    const allow = async () => ({ kind: 'allow' })
    const duplicate = await host.ctx.emit(
      'tools/pre-execute',
      { name: 'shell', arguments: { cmd: 'echo hi' }, agent: host.agent },
      allow,
    )
    assert.equal(duplicate[0].kind, 'deny')
    assert.match(duplicate[0].reason, /already completed/i)

    const different = await host.ctx.emit(
      'tools/pre-execute',
      { name: 'shell', arguments: { cmd: 'echo different' }, agent: host.agent },
      allow,
    )
    assert.equal(different[0].kind, 'allow')

    await emitEvent(host.ctx, host.session, 'turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    })
    await waitFor(async () => {
      const result = await readLoadedState(host.root, host.session)
      return result?.state?.recovery?.duplicateGuardActive === false
    })
    const afterTurn = await host.ctx.emit(
      'tools/pre-execute',
      { name: 'shell', arguments: { cmd: 'echo hi' }, agent: host.agent },
      allow,
    )
    assert.equal(afterTurn[0].kind, 'allow')
  } finally {
    await host.ctx.dispose()
    await server.close()
    await removeTempRoot(host.root)
  }
})

test('probe exhaustion retains the checkpoint and does not reactivate the goal', async () => {
  const server = await startProbeServer({ status: 503 })
  const host = await makeHost()
  try {
    await applyPlugin(host.ctx, host.root, {
      recoveryMode: 'probe',
      probeUrl: server.url,
      initialProbeDelayMs: 1,
      maxProbeDelayMs: 2,
      maxProbeAttempts: 2,
      probeTimeoutMs: 1000,
    })
    await host.ctx.emitSession(host.session, textMessageEvent(0, 'Do a long task.'))
    await emitNetworkError(host.ctx, host.session)
    host.agent.status = 'idle'
    await host.ctx.emit('agent/status', { agent: host.agent, status: 'idle' })

    const loaded = await waitFor(async () => {
      const result = await readLoadedState(host.root, host.session)
      return result?.state?.recovery?.blockedReason === 'probe-exhausted' ? result : undefined
    })
    assert.equal(loaded.state.recovery.lastOutcome, 'probe-exhausted')
    assert.equal(host.goals.calls.resume, 0)
    assert.equal(host.agent.injected.length, 0)
    assert.equal(server.requests.length, 2)
  } finally {
    await host.ctx.dispose()
    await server.close()
    await removeTempRoot(host.root)
  }
})

test('a human message cancels an in-flight readiness wait', async () => {
  const server = await startProbeServer({ status: 200 })
  const host = await makeHost()
  try {
    await applyPlugin(host.ctx, host.root, {
      recoveryMode: 'probe',
      probeUrl: server.url,
      initialProbeDelayMs: 150,
      maxProbeDelayMs: 150,
      maxProbeAttempts: 1,
      probeTimeoutMs: 1000,
    })
    await host.ctx.emitSession(host.session, textMessageEvent(0, 'Original task.'))
    await emitNetworkError(host.ctx, host.session)
    host.agent.status = 'idle'
    await host.ctx.emit('agent/status', { agent: host.agent, status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 20))
    await host.ctx.emitSession(host.session, textMessageEvent(host.session.seq, 'Human takes over.'))

    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(host.goals.calls.resume, 0)
    assert.equal(host.agent.injected.length, 0)
    assert.equal(server.requests.length, 0)
  } finally {
    await host.ctx.dispose()
    await server.close()
    await removeTempRoot(host.root)
  }
})

test('deferred recovery mode re-arms the goal without an outbound probe when explicitly enabled', async () => {
  const host = await makeHost({ goals: { objective: 'Deferred recovery task' } })
  try {
    await applyPlugin(host.ctx, host.root, {
      recoveryMode: 'deferred',
      initialProbeDelayMs: 1,
      maxAutoResumes: 2,
    })
    await host.ctx.emitSession(host.session, textMessageEvent(0, 'Deferred recovery task'))
    await emitNetworkError(host.ctx, host.session)
    host.agent.status = 'idle'
    await host.ctx.emit('agent/status', { agent: host.agent, status: 'idle' })
    await waitFor(() => host.goals.calls.resume === 1 && host.agent.injected.length === 1)
    assert.equal(host.goals.service.snapshot().activation, 'armed')
  } finally {
    await host.ctx.dispose()
    await removeTempRoot(host.root)
  }
})

test('paused goals are not silently resumed', async () => {
  const server = await startProbeServer({ status: 200 })
  const host = await makeHost({ goals: { phase: 'paused' } })
  try {
    await applyPlugin(host.ctx, host.root, {
      recoveryMode: 'probe',
      probeUrl: server.url,
      initialProbeDelayMs: 0,
      maxProbeAttempts: 1,
    })
    await host.ctx.emitSession(host.session, textMessageEvent(0, 'Paused task'))
    await emitNetworkError(host.ctx, host.session)
    host.agent.status = 'idle'
    await host.ctx.emit('agent/status', { agent: host.agent, status: 'idle' })
    const loaded = await waitFor(async () => {
      const result = await readLoadedState(host.root, host.session)
      return result?.state?.recovery?.blockedReason === 'goal-paused' ? result : undefined
    })
    assert.equal(host.goals.calls.resume, 0)
    assert.equal(host.agent.injected.length, 0)
    assert.equal(loaded.state.recovery.lastOutcome, 'goal-paused')
  } finally {
    await host.ctx.dispose()
    await server.close()
    await removeTempRoot(host.root)
  }
})

test('resolved probe credentials are sent to the probe but never persisted', async () => {
  const secret = 'test-only-secret-token-0123456789'
  const server = await startProbeServer({ status: 200 })
  const host = await makeHost({
    credentials: {
      async resolve(ref) {
        assert.equal(ref, 'TEST_PROBE_KEY')
        return { value: secret, source: 'test' }
      },
    },
  })
  try {
    await applyPlugin(host.ctx, host.root, {
      recoveryMode: 'probe',
      probeUrl: server.url,
      probeAuth: 'bearer',
      credentialRef: 'TEST_PROBE_KEY',
      initialProbeDelayMs: 0,
      maxProbeAttempts: 1,
      probeTimeoutMs: 1000,
    })
    await host.ctx.emitSession(host.session, textMessageEvent(0, 'Credential containment task'))
    await emitNetworkError(host.ctx, host.session)
    host.agent.status = 'idle'
    await host.ctx.emit('agent/status', { agent: host.agent, status: 'idle' })
    await waitFor(() => host.goals.calls.resume === 1 && host.agent.injected.length === 1)
    assert.equal(server.requests[0].headers.authorization, `Bearer ${secret}`)

    const loaded = await waitFor(async () => {
      const result = await readLoadedState(host.root, host.session)
      return result?.state?.recovery?.lastOutcome === 'goal-rearmed' ? result : undefined
    })
    const taskJson = await readFile(loaded.taskFile, 'utf8')
    const taskMarkdown = await readFile(loaded.taskFile.replace(/\.json$/, '.md'), 'utf8')
    assert.doesNotMatch(taskJson, new RegExp(secret))
    assert.doesNotMatch(taskMarkdown, new RegExp(secret))
    assert.doesNotMatch(JSON.stringify(loaded.state), new RegExp(secret))
  } finally {
    await host.ctx.dispose()
    await server.close()
    await removeTempRoot(host.root)
  }
})

test('missing history is reconstructed through ctx.sessionQuery instead of snapshotEvents', async () => {
  const root = await makeTempRoot()
  const session = makeSession('query-session', 3)
  const agent = makeAgent(session)
  let readSessionCalls = 0
  const ctx = makeFakeContext({
    agents: [agent],
    sessions: [session],
    sessionQuery: {
      async readSession(id) {
        readSessionCalls++
        assert.equal(id, 'query-session')
        return {
          events: [
            textMessageEvent(0, 'Historical instruction from sessionQuery'),
            toolCallEvent(1, 'historical-call', 'read_file', { path: 'README.md' }),
            toolResultEvent(2, 'historical-call', 'historical result'),
          ],
        }
      },
    },
  })
  try {
    await applyPlugin(ctx, root, { reconstructFromSessionQuery: true })
    const loaded = await waitFor(async () => {
      const result = await readLoadedState(root, session)
      return result?.state?.originalInstruction === 'Historical instruction from sessionQuery'
        ? result
        : undefined
    })
    assert.equal(readSessionCalls, 1)
    assert.equal(loaded.state.tools.length, 1)
    assert.equal(loaded.state.tools[0].name, 'read_file')
    assert.equal(loaded.state.tools[0].status, 'completed')
  } finally {
    await ctx.dispose()
    await removeTempRoot(root)
  }
})

test('plugin disposal removes listeners and a fresh mount works independently', async () => {
  const root = await makeTempRoot()
  try {
    const firstSession = makeSession('dispose-session-1', 0)
    const firstAgent = makeAgent(firstSession)
    const firstCtx = makeFakeContext({ agents: [firstAgent], sessions: [firstSession] })
    await applyPlugin(firstCtx, root)
    await firstCtx.emitSession(firstSession, textMessageEvent(0, 'First mount'))
    await waitFor(async () => (await readLoadedState(root, firstSession)) !== undefined)
    await firstCtx.dispose()
    assert.equal(firstCtx.listenerCount('session/event'), 0)
    assert.equal(firstCtx.listenerCount('agent/status'), 0)

    const secondSession = makeSession('dispose-session-2', 0)
    const secondAgent = makeAgent(secondSession)
    const secondCtx = makeFakeContext({ agents: [secondAgent], sessions: [secondSession] })
    await applyPlugin(secondCtx, root)
    await secondCtx.emitSession(secondSession, textMessageEvent(0, 'Second mount'))
    const loaded = await waitFor(async () => {
      const result = await readLoadedState(root, secondSession)
      return result?.state?.originalInstruction === 'Second mount' ? result : undefined
    })
    assert.equal(loaded.state.originalInstruction, 'Second mount')
    await secondCtx.dispose()
  } finally {
    await removeTempRoot(root)
  }
})
