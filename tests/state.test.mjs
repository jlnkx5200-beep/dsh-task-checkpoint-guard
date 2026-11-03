import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyFailure,
  createTaskState,
  duplicateToolDecision,
  ingestEvent,
  normalizeLoadedState,
  renderRecoveryContext,
  checkpointDocuments,
  SCHEMA_VERSION,
  TOOL_OUTCOME_UNKNOWN,
} from '../src/state.js'
import {
  goalChangeEvent,
  makeSession,
  textMessageEvent,
  toolCallEvent,
  toolResultEvent,
} from './helpers.mjs'

function seedState() {
  return createTaskState(makeSession('state-test-session', 0), 1_700_000_000_000)
}

test('failure classification recognizes transport, timeout, service, auth, and cancellation classes', () => {
  assert.equal(classifyFailure({ code: 'ECONNRESET', message: 'socket hang up' }).kind, 'NETWORK')
  assert.equal(classifyFailure({ code: 'ETIMEDOUT', message: 'request timed out' }).kind, 'TIMEOUT')
  assert.equal(classifyFailure({ code: 'SERVER', message: '503 Service Unavailable' }).kind, 'SERVICE')
  assert.equal(classifyFailure({ code: 'AUTH', message: '401 Unauthorized' }).kind, 'AUTH_OR_REQUEST')
  assert.equal(classifyFailure({ message: 'operation was aborted' }).kind, 'ABORTED')
  assert.equal(classifyFailure({ code: 'ECONNRESET' }).autoResumeEligible, true)
  assert.equal(classifyFailure({ code: '401' }).autoResumeEligible, false)
})

test('first human prompt becomes the durable objective; generated context is ignored', () => {
  const state = seedState()
  ingestEvent(state, textMessageEvent(0, 'Build a safe checkpoint plugin.'))
  ingestEvent(state, textMessageEvent(1, 'Ignore this system notice.', { kind: 'task-checkpoint-guard' }))
  ingestEvent(state, textMessageEvent(2, 'Second human steer.'))
  assert.equal(state.originalInstruction, 'Build a safe checkpoint plugin.')
  assert.equal(state.lastUserInstruction.text, 'Second human steer.')
  assert.equal(state.status, 'RUNNING')
})

test('goal adoption resets task-specific state and tracks the new task id', () => {
  const state = seedState()
  ingestEvent(state, textMessageEvent(0, 'Old task'))
  ingestEvent(state, toolCallEvent(1, 'call-old', 'shell', { cmd: 'echo old' }))
  const goal = {
    id: 'goal-new',
    revision: 1,
    objective: 'New durable goal',
    phase: 'active',
    maxGoalRounds: 8,
  }
  ingestEvent(state, goalChangeEvent(2, goal, 'create', 0))
  assert.equal(state.taskId, 'goal-new')
  assert.equal(state.goal.id, 'goal-new')
  assert.equal(state.originalInstruction, 'New durable goal')
  assert.deepEqual(state.tools, [])
  assert.equal(state.status, 'RUNNING')
})

test('tool lifecycle records call, result, and unknown outcome without raw reasoning', () => {
  const state = seedState()
  ingestEvent(state, textMessageEvent(0, 'Run a tool'))
  ingestEvent(state, toolCallEvent(1, 'call-1', 'shell', { command: 'echo hello' }))
  assert.equal(state.pendingToolCalls.length, 1)
  assert.match(state.tools[0].argumentsHash, /^sha256:/)

  ingestEvent(state, toolResultEvent(2, 'call-1', 'hello'))
  assert.equal(state.pendingToolCalls.length, 0)
  assert.equal(state.tools[0].status, 'completed')
  assert.equal(state.tools[0].result, 'hello')

  ingestEvent(state, toolCallEvent(3, 'call-2', 'write_file', { path: 'a.txt', content: 'x' }))
  ingestEvent(state, toolResultEvent(4, 'call-2', 'The outcome is unknown', {
    isError: true,
    error: { code: TOOL_OUTCOME_UNKNOWN, name: 'ToolOutcomeUnknownError' },
  }))
  assert.equal(state.tools[1].status, 'unknown')
  assert.equal(state.tools[1].outcomeUnknown, true)
  assert.equal(state.pendingToolCalls.length, 0)
})

test('hidden reasoning is counted but never present in JSON or Markdown checkpoints', () => {
  const state = seedState()
  ingestEvent(state, textMessageEvent(0, 'Do not leak reasoning.'))
  ingestEvent(state, {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
        content: [
          { type: 'reasoning', text: 'ULTRA SECRET CHAIN OF THOUGHT' },
          { type: 'text', text: 'Visible answer only.' },
        ],
      },
      stream: [],
    },
  })
  assert.equal(state.lastAssistant.reasoningBlocks, 1)
  assert.ok(state.lastAssistant.reasoningChars > 0)
  const docs = checkpointDocuments(state)
  const jsonText = JSON.stringify(docs.json)
  assert.doesNotMatch(jsonText, /ULTRA SECRET CHAIN OF THOUGHT/)
  assert.doesNotMatch(docs.md, /ULTRA SECRET CHAIN OF THOUGHT/)
  assert.match(jsonText, /Visible answer only/)
  assert.match(jsonText, /reasoningBlocks/)
})

test('network turn errors become eligible, while pending tools block auto recovery', () => {
  const state = seedState()
  ingestEvent(state, textMessageEvent(0, 'Do work'))
  ingestEvent(state, toolCallEvent(1, 'pending-call', 'write_file', { path: 'x', content: 'y' }))
  ingestEvent(state, {
    type: 'turn/end',
    seq: 2,
    time: Date.now(),
    data: {
      turn: 1,
      reason: { kind: 'error', error: { code: 'ECONNRESET', message: 'fetch failed' } },
    },
  })
  assert.equal(state.status, 'INTERRUPTED')
  assert.equal(state.interruption.kind, 'NETWORK')
  assert.equal(state.interruption.autoResumeEligible, false)
  assert.equal(state.interruption.safeToRetry, false)

  const noPending = seedState()
  ingestEvent(noPending, textMessageEvent(0, 'Do work'))
  ingestEvent(noPending, {
    type: 'turn/end',
    seq: 1,
    time: Date.now(),
    data: {
      turn: 1,
      reason: { kind: 'error', error: { code: 'ETIMEDOUT', message: 'request timed out' } },
    },
  })
  assert.equal(noPending.interruption.autoResumeEligible, true)
  assert.equal(noPending.recovery.eligible, true)
})

test('completed turn clears interruption and resets recovery counters', () => {
  const state = seedState()
  ingestEvent(state, textMessageEvent(0, 'Continue'))
  state.recovery.resumeAttempts = 2
  state.interruption = { kind: 'NETWORK', autoResumeEligible: true }
  ingestEvent(state, {
    type: 'turn/end',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  assert.equal(state.status, 'CHECKPOINTED')
  assert.equal(state.interruption, null)
  assert.equal(state.recovery.resumeAttempts, 0)
})

test('recovery context lists completed and unknown tools and excludes reasoning text', () => {
  const state = seedState()
  ingestEvent(state, textMessageEvent(0, 'Original task'))
  ingestEvent(state, toolCallEvent(1, 'call-a', 'shell', { command: 'echo a' }))
  ingestEvent(state, toolResultEvent(2, 'call-a', 'a'))
  ingestEvent(state, toolCallEvent(3, 'call-b', 'write_file', { path: 'x', content: 'SECRET' }))
  ingestEvent(state, toolResultEvent(4, 'call-b', 'unknown', {
    isError: true,
    error: { code: TOOL_OUTCOME_UNKNOWN, name: 'ToolOutcomeUnknownError' },
  }))
  ingestEvent(state, {
    type: 'turn/end',
    seq: 5,
    time: Date.now(),
    data: { turn: 1, reason: { kind: 'error', error: { code: 'ECONNRESET', message: 'fetch failed' } } },
  })
  state.recovery.duplicateGuardActive = true
  const context = renderRecoveryContext(state, 5000)
  assert.match(context, /SYSTEM-GENERATED RECOVERY CONTEXT/)
  assert.match(context, /shell \(call-a\) completed/)
  assert.match(context, /write_file \(call-b\) outcome unknown/)
  assert.match(context, /do not repeat/i)
  assert.match(context, /inspect the actual external\/workspace state/i)
  assert.doesNotMatch(context, /SECRET CHAIN/)
})

test('normalizeLoadedState rejects session mismatch and sanitizes a valid previous document', () => {
  const session = makeSession('normalize-session', 0)
  const state = createTaskState(session)
  state.schemaVersion = SCHEMA_VERSION
  state.taskId = 'goal-safe'
  state.goal = {
    id: 'goal-safe',
    revision: 2,
    objective: 'Objective',
    phase: 'active',
    maxGoalRounds: 4,
    roundsStarted: 1,
  }
  state.tools = [{
    callId: 'call',
    name: 'shell',
    argumentsPreview: '{"token":"SECRET"}',
    argumentsHash: 'sha256:abc',
    status: 'completed',
    result: 'ok',
  }]
  state.pendingToolCalls = []
  state.recovery = {
    ...state.recovery,
    duplicateGuardActive: true,
    note: 'Note',
    pendingContextInjection: true,
    lastProbe: {
      at: 1,
      elapsedMs: 2,
      status: 503,
      authenticated: false,
      ok: false,
      reachable: true,
      error: { name: 'Error', code: 'E_TEST', message: 'probe failed' },
    },
  }
  const normalized = normalizeLoadedState(session, state)
  assert.equal(normalized.sessionId, 'normalize-session')
  assert.equal(normalized.taskId, 'goal-safe')
  assert.equal(normalized.recovery.duplicateGuardActive, true)
  assert.equal(normalized.recovery.pendingContextInjection, false)
  assert.equal(normalized.recovery.lastProbe.error.code, 'E_TEST')
  assert.doesNotMatch(normalized.tools[0].argumentsPreview, /SECRET/)

  const wrongSession = { ...state, sessionId: 'other-session' }
  assert.throws(() => normalizeLoadedState(session, wrongSession), /sessionId/)
})

test('duplicate guard blocks exact completed calls only during recovery', () => {
  const state = seedState()
  ingestEvent(state, toolCallEvent(0, 'call-a', 'shell', { cmd: 'echo hi' }))
  ingestEvent(state, toolResultEvent(1, 'call-a', 'hi'))
  assert.equal(duplicateToolDecision(state, 'shell', { cmd: 'echo hi' }).block, false)
  state.recovery.duplicateGuardActive = true
  const blocked = duplicateToolDecision(state, 'shell', { cmd: 'echo hi' })
  assert.equal(blocked.block, true)
  assert.equal(blocked.kind, 'completed')
  assert.equal(duplicateToolDecision(state, 'shell', { cmd: 'echo hi' }, 'off').block, false)
  assert.equal(duplicateToolDecision(state, 'shell', { cmd: 'echo other' }).block, false)
})

test('status transitions are recorded in bounded history', () => {
  const state = seedState()
  for (let index = 0; index < 40; index++) {
    ingestEvent(state, {
      type: 'turn/start',
      seq: index,
      time: Date.now() + index,
      data: { turn: index + 1 },
    })
  }
  assert.ok(state.statusHistory.length <= 30)
  assert.ok(state.statusHistory.some(item => item.to === 'RUNNING'))
})
