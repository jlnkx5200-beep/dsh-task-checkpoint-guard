/**
 * Pure checkpoint state machine, event ingestion, recovery-context rendering,
 * and checkpoint-document construction.
 *
 * No DSH package is imported here. Session objects and events are treated as
 * plain public data structures so the same code can run in the host, in a
 * loader smoke test, and in a standalone Node test.
 */
import { createHash } from 'node:crypto'
import {
  parseArguments,
  reasoningFacts,
  redact,
  redactJson,
  toolFingerprint,
  visibleText,
} from './redact.js'

export const SCHEMA_VERSION = 1
export const RECOVERY_MARKER = '[SYSTEM-GENERATED RECOVERY CONTEXT'
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

export const STATUSES = Object.freeze([
  'PENDING',
  'RUNNING',
  'CHECKPOINTED',
  'INTERRUPTED',
  'RECOVERING',
  'PAUSED',
  'BLOCKED',
  'FAILED',
  'COMPLETED',
])

export const DEFAULT_LIMITS = Object.freeze({
  maxToolHistory: 80,
  maxToolResultChars: 2000,
  maxToolArgumentChars: 1000,
  maxRecoveryContextChars: 16000,
})

const MAX_INSTRUCTION_CHARS = 12000
const MAX_ASSISTANT_TEXT = 12000
const MAX_RESULT_TEXT = 3000
const MAX_TODOS = 100
const MAX_COMPLETED_STEPS = 60
const MAX_CONFIRMED_RESULTS = 12
const MAX_STATUS_HISTORY = 30
const MAX_STORED_TOOL_ERROR = 500

const GOAL_PHASES = new Set(['active', 'paused', 'blocked', 'complete'])
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

function asString(value, max = 1000) {
  return typeof value === 'string' ? redact(value, max) : null
}

function asInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) ? value : fallback
}

function asBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** Make an arbitrary identity safe as one filename component without losing uniqueness. */
export function safeFileId(value) {
  const raw = String(value ?? 'unknown')
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12)
  let cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  cleaned = cleaned.replace(/[. ]+$/g, '_') || 'id'
  return `${cleaned}-${hash}`
}

/** Create the independent task record for one live session. */
export function createTaskState(session, now = Date.now()) {
  const sessionId = String(session?.id ?? 'unknown')
  return {
    schemaVersion: SCHEMA_VERSION,
    taskId: `session-${safeFileId(sessionId)}`,
    sessionId,
    agentPreset: session?.header?.agentPreset ?? null,
    createdAt: now,
    updatedAt: now,
    status: 'PENDING',
    phase: 'PENDING',
    statusHistory: [],
    provider: null,
    model: null,
    reasoningEffort: null,
    originalInstruction: null,
    lastUserInstruction: null,
    goal: null,
    todos: [],
    execution: {
      turn: 0,
      step: 0,
      currentStep: null,
      completedSteps: [],
      lastTurnEnd: null,
    },
    confirmedResults: [],
    lastAssistant: null,
    tools: [],
    pendingToolCalls: [],
    lastToolError: null,
    tokenUsage: null,
    retry: null,
    lastEventSeq: null,
    lastCheckpoint: { seq: null, time: null, eventType: null },
    interruption: null,
    recovery: {
      eligible: false,
      attempts: 0,
      resumeAttempts: 0,
      lastProbe: null,
      lastOutcome: null,
      note: null,
      blockedReason: null,
      pendingContextInjection: false,
      injectedAtSeq: null,
      duplicateGuardActive: false,
    },
    rawReasoningPolicy:
      'not-persisted: model CoT is represented only by block count and character count',
    storageNotice:
      'Local-only checkpoint. dsh-task-checkpoint-guard never uploads or remotely syncs this file.',
  }
}

/** Record one status transition with bounded history. */
export function transitionStatus(state, next, reason, event) {
  const from = state.status
  if (from === next) {
    state.phase = next
    return state
  }
  state.status = next
  state.phase = next
  state.updatedAt = Date.now()
  state.statusHistory.push({
    from,
    to: next,
    reason: redact(reason ?? 'event', 200),
    seq: Number.isSafeInteger(event?.seq) ? event.seq : null,
    at: Date.now(),
  })
  state.statusHistory = state.statusHistory.slice(-MAX_STATUS_HISTORY)
  return state
}

/** Return the first genuine human instruction, excluding generated context. */
function instructionText(message) {
  if (!message || message.role !== 'user') return undefined
  if (message.source?.kind !== 'user') return undefined
  const text = visibleText(message.content)
  if (text.trim().length === 0) return undefined
  if (text.startsWith(RECOVERY_MARKER)) return undefined
  return redact(text, MAX_INSTRUCTION_CHARS)
}

/** Extract a compact visible text result from one tool-result message. */
function toolResultText(message, limits) {
  return redact(visibleText(message?.content), limits.maxToolResultChars)
}

/** Extract one tool call id from the durable result shape or its source. */
function resultCallId(message) {
  const direct = message?.toolCallId
  const sourced = message?.source?.callId
  return String(direct ?? sourced ?? '')
}

/**
 * Classify an error without preserving provider-specific credentials or
 * host-specific paths. Only transport/service failures are auto-recoverable.
 */
export function classifyFailure(error) {
  const code = String(
    error?.code
      ?? error?.failure?.code
      ?? error?.error?.code
      ?? error?.cause?.code
      ?? '',
  )
  const message = String(
    error?.message
      ?? error?.failure?.message
      ?? error?.error?.message
      ?? error?.reason
      ?? error
      ?? '',
  )
  const text = `${code} ${message}`
  const aborted = /(?:^|\b)(?:ABORT_ERR|ABORTED|CANCELLED|CANCELED)(?:\b|$)|operation was aborted|user (?:cancel|abort)/i.test(text)
  const auth = /(?:MISSING_CREDENTIAL|INVALID_CREDENTIAL|AUTH(?:ENTICATION|ORIZATION)?|PERMISSION_DENIED)|\b(?:400|401|403)\b/i.test(text)
  const timeout = /(?:TIMEOUT|ETIMEDOUT|timed?\s*out|deadline exceeded)/i.test(text)
  const network = /(?:ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|TRANSPORT|network|socket|fetch failed|other side closed|premature close|stream idle|stream ended|connection reset)/i.test(text)
  const service = /(?:RATE_LIMIT|SERVER|SERVICE_UNAVAILABLE|OVERLOADED)|\b(?:429|500|502|503|504)\b/i.test(text)
  const kind = auth
    ? 'AUTH_OR_REQUEST'
    : aborted
      ? 'ABORTED'
      : timeout
        ? 'TIMEOUT'
        : network
          ? 'NETWORK'
          : service
            ? 'SERVICE'
            : 'UNKNOWN'
  return {
    kind,
    code: redact(code, 120),
    message: redact(message, 1000),
    retryable: ['NETWORK', 'TIMEOUT', 'SERVICE'].includes(kind),
    autoResumeEligible: ['NETWORK', 'TIMEOUT', 'SERVICE'].includes(kind),
  }
}

/** Reset task-scoped fields while retaining session-level identity. */
function resetTaskState(state, sessionLike, now = Date.now()) {
  const preserved = {
    sessionId: state.sessionId,
    agentPreset: state.agentPreset,
    provider: state.provider,
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    lastEventSeq: state.lastEventSeq,
  }
  Object.assign(state, createTaskState(sessionLike, now))
  state.sessionId = preserved.sessionId
  state.agentPreset = preserved.agentPreset
  state.provider = preserved.provider
  state.model = preserved.model
  state.reasoningEffort = preserved.reasoningEffort
  state.lastEventSeq = preserved.lastEventSeq
  state.taskId = `session-${safeFileId(state.sessionId)}`
}

/** Adopt one durable goal snapshot, resetting task-scoped records on a goal switch. */
function adoptGoal(state, goal, operation, roundsStarted, event) {
  if (!goal || typeof goal.id !== 'string' || goal.id.length === 0) return
  const changedTask = state.goal?.id !== goal.id
  if (changedTask) {
    resetTaskState(state, {
      id: state.sessionId,
      header: { agentPreset: state.agentPreset },
    }, Date.now())
    state.originalInstruction = redact(goal.objective ?? '', MAX_INSTRUCTION_CHARS)
  }
  state.taskId = goal.id
  state.goal = {
    id: goal.id,
    revision: Number.isSafeInteger(goal.revision) ? goal.revision : 1,
    objective: redact(goal.objective ?? '', MAX_INSTRUCTION_CHARS),
    phase: GOAL_PHASES.has(goal.phase) ? goal.phase : 'active',
    maxGoalRounds: Number.isSafeInteger(goal.maxGoalRounds) ? goal.maxGoalRounds : null,
    roundsStarted: Number.isSafeInteger(roundsStarted) ? roundsStarted : 0,
    lastOperation: typeof operation === 'string' ? operation : null,
  }
  if (state.originalInstruction === null && goal.objective) {
    state.originalInstruction = redact(goal.objective, MAX_INSTRUCTION_CHARS)
  }
  if (state.goal.phase === 'complete') transitionStatus(state, 'COMPLETED', 'goal-complete', event)
  else if (state.goal.phase === 'paused') transitionStatus(state, 'PAUSED', 'goal-paused', event)
  else if (state.goal.phase === 'blocked') transitionStatus(state, 'BLOCKED', 'goal-blocked', event)
  else if (changedTask || state.status === 'PENDING') transitionStatus(state, 'RUNNING', 'goal-active', event)
}

/** Handle a goal/change event, including the clear tombstone. */
function handleGoalChange(state, data, event) {
  if (data?.operation === 'clear') {
    resetTaskState(state, {
      id: state.sessionId,
      header: { agentPreset: state.agentPreset },
    }, Date.now())
    state.goal = null
    state.originalInstruction = null
    state.lastEventSeq = event?.seq ?? state.lastEventSeq
    transitionStatus(state, 'CHECKPOINTED', 'goal-cleared', event)
    return
  }
  adoptGoal(state, data?.goal, data?.operation, data?.roundsStarted, event)
}

/** Mark the last processed event boundary. */
function markCheckpoint(state, event, now = Date.now()) {
  state.updatedAt = now
  if (Number.isSafeInteger(event?.seq)) state.lastEventSeq = event.seq
  state.lastCheckpoint = {
    seq: Number.isSafeInteger(event?.seq) ? event.seq : state.lastEventSeq,
    time: Number.isSafeInteger(event?.time) ? event.time : now,
    eventType: typeof event?.type === 'string' ? event.type : null,
  }
}

/** Ingest one Session event into the task record. Unknown events are harmless. */
export function ingestEvent(state, event, limits = DEFAULT_LIMITS) {
  if (!event || typeof event !== 'object') return state
  const seq = Number.isSafeInteger(event.seq) ? event.seq : null
  if (seq !== null && state.lastEventSeq !== null && seq <= state.lastEventSeq) return state

  const data = event.data ?? {}
  switch (event.type) {
    case 'request/header': {
      const config = data.header?.config
      if (config) {
        state.provider = asString(config.provider, 200) ?? state.provider
        state.model = asString(config.model, 300) ?? state.model
        state.reasoningEffort = asString(config.reasoningEffort, 100) ?? state.reasoningEffort
      }
      break
    }
    case 'model/selection': {
      state.provider = asString(data.provider, 200) ?? state.provider
      state.model = asString(data.model, 300) ?? state.model
      state.reasoningEffort = asString(data.reasoningEffort, 100) ?? state.reasoningEffort
      break
    }
    case 'user/message': {
      if (data?.source?.kind === 'user') {
        const text = instructionText(data)
        if (text !== undefined) {
          if (state.originalInstruction === null) state.originalInstruction = text
          state.lastUserInstruction = {
            text,
            seq,
            time: Number.isSafeInteger(event.time) ? event.time : Date.now(),
          }
        }
        if (state.interruption !== null) {
          state.interruption = {
            ...state.interruption,
            autoResumeEligible: false,
            manualOverride: true,
            firstAction: 'A human message superseded automatic recovery. Follow the human instruction and verify durable state before acting.',
          }
        }
        state.recovery.eligible = false
        state.recovery.pendingContextInjection = false
        state.recovery.duplicateGuardActive = false
        state.recovery.blockedReason = null
        state.recovery.resumeAttempts = 0
        state.recovery.note = 'human input superseded automatic recovery'
        if (state.status === 'PENDING' || state.status === 'PAUSED' || state.status === 'INTERRUPTED' || state.status === 'FAILED' || state.status === 'CHECKPOINTED') {
          transitionStatus(state, 'RUNNING', 'human-message', event)
        }
      }
      break
    }
    case 'goal/change': {
      handleGoalChange(state, data, event)
      break
    }
    case 'todo/write': {
      state.todos = asArray(data.todos).slice(0, MAX_TODOS).map(todo => ({
        content: redact(todo?.content ?? '', 1000),
        status: TODO_STATUSES.has(todo?.status) ? todo.status : 'unknown',
      }))
      break
    }
    case 'turn/start': {
      state.execution.turn = asInteger(data.turn, state.execution.turn)
      transitionStatus(state, 'RUNNING', 'turn-start', event)
      break
    }
    case 'step/start': {
      state.execution.turn = asInteger(data.turn, state.execution.turn)
      state.execution.step = asInteger(data.step, state.execution.step)
      state.execution.currentStep = {
        turn: state.execution.turn,
        step: state.execution.step,
        startedAt: Date.now(),
        seq,
      }
      transitionStatus(state, 'RUNNING', 'step-start', event)
      break
    }
    case 'step/end': {
      state.execution.completedSteps.push({
        turn: asInteger(data.turn, state.execution.turn),
        step: asInteger(data.step, state.execution.step),
        endedAt: Date.now(),
        seq,
      })
      state.execution.completedSteps = state.execution.completedSteps.slice(-MAX_COMPLETED_STEPS)
      state.execution.currentStep = null
      break
    }
    case 'turn/end': {
      const reason = data.reason ?? { kind: 'unknown' }
      state.execution.lastTurnEnd = {
        turn: asInteger(data.turn, state.execution.turn),
        reason: redact(reason, 2000),
        seq,
      }
      state.recovery.duplicateGuardActive = false
      if (reason.kind === 'completed') {
        state.interruption = null
        state.recovery.eligible = false
        state.recovery.resumeAttempts = 0
        state.recovery.blockedReason = null
        transitionStatus(state, state.goal?.phase === 'complete' ? 'COMPLETED' : 'CHECKPOINTED', 'turn-completed', event)
      } else if (reason.kind === 'aborted') {
        state.interruption = {
          kind: 'ABORTED',
          message: 'The turn was cancelled.',
          atSeq: seq,
          safeToRetry: false,
          autoResumeEligible: false,
          unfinishedOperations: state.pendingToolCalls.map(call => call.callId),
          firstAction: 'Do not auto-resume a user-cancelled task. Wait for an explicit instruction.',
        }
        state.recovery.eligible = false
        transitionStatus(state, 'INTERRUPTED', 'turn-aborted', event)
      } else if (reason.kind === 'max-tokens') {
        state.interruption = {
          kind: 'MAX_TOKENS',
          message: 'The model stopped at its output-token ceiling.',
          atSeq: seq,
          safeToRetry: state.pendingToolCalls.length === 0,
          autoResumeEligible: false,
          unfinishedOperations: state.pendingToolCalls.map(call => call.callId),
          firstAction: 'Inspect the durable partial answer and continue the unfinished work without repeating completed calls.',
        }
        state.recovery.eligible = false
        transitionStatus(state, 'INTERRUPTED', 'turn-max-tokens', event)
      } else if (reason.kind === 'blocked' || reason.kind === 'interrupted' || reason.kind === 'forked') {
        state.interruption = {
          kind: String(reason.kind).toUpperCase(),
          message: `The turn closed with reason "${String(reason.kind)}".`,
          atSeq: seq,
          safeToRetry: false,
          autoResumeEligible: false,
          unfinishedOperations: state.pendingToolCalls.map(call => call.callId),
          firstAction: 'Inspect the checkpoint and the host state before continuing.',
        }
        state.recovery.eligible = false
        transitionStatus(state, reason.kind === 'blocked' ? 'BLOCKED' : 'INTERRUPTED', `turn-${reason.kind}`, event)
      } else {
        const failure = classifyFailure(reason?.error ?? reason)
        const hasPendingTools = state.pendingToolCalls.length > 0
        const eligible = failure.autoResumeEligible && !hasPendingTools
        state.interruption = {
          kind: failure.kind,
          message: failure.message,
          code: failure.code,
          atSeq: seq,
          safeToRetry: failure.retryable && !hasPendingTools,
          autoResumeEligible: eligible,
          unfinishedOperations: state.pendingToolCalls.map(call => call.callId),
          firstAction: eligible
            ? 'Wait for bounded readiness recovery, then resume from this checkpoint and inspect durable state before acting.'
            : 'Inspect the error and workspace state; do not retry blindly.',
        }
        state.recovery.eligible = eligible
        transitionStatus(state, failure.autoResumeEligible ? 'INTERRUPTED' : 'FAILED', 'turn-error', event)
      }
      break
    }
    case 'assistant/message': {
      const message = data.message ?? {}
      const source = message.source ?? {}
      if (source.provider) state.provider = asString(source.provider, 200) ?? state.provider
      if (source.model) state.model = asString(source.model, 300) ?? state.model
      const text = visibleText(message.content)
      const reasoning = reasoningFacts(message.content)
      state.lastAssistant = {
        turn: asInteger(data.turn, state.execution.turn),
        step: asInteger(data.step, state.execution.step),
        interrupted: data.interrupted === true,
        text: redact(text, MAX_ASSISTANT_TEXT),
        reasoningBlocks: reasoning.blocks,
        reasoningChars: reasoning.chars,
        seq,
        at: Number.isSafeInteger(event.time) ? event.time : Date.now(),
      }
      if (text.trim().length > 0) {
        state.confirmedResults.push({
          turn: asInteger(data.turn, state.execution.turn),
          step: asInteger(data.step, state.execution.step),
          text: redact(text, MAX_RESULT_TEXT),
          seq,
        })
        state.confirmedResults = state.confirmedResults.slice(-MAX_CONFIRMED_RESULTS)
      }
      if (data.usage !== undefined) state.tokenUsage = redactJson(data.usage)
      if (data.interrupted === true) {
        state.interruption = {
          kind: 'STREAM_PARTIAL',
          message: 'Assistant stream ended with a durable partial message.',
          atSeq: seq,
          safeToRetry: state.pendingToolCalls.length === 0,
          autoResumeEligible: false,
          unfinishedOperations: state.pendingToolCalls.map(call => call.callId),
          firstAction: 'Use the durable partial assistant text as context, then continue only the unfinished step.',
        }
        state.recovery.eligible = false
        transitionStatus(state, 'INTERRUPTED', 'assistant-stream-partial', event)
      } else {
        state.recovery.resumeAttempts = 0
      }
      break
    }
    case 'tool/call': {
      const callId = String(data.callId ?? '')
      const args = parseArguments(data.arguments)
      const record = {
        callId,
        name: redact(data.name ?? '', 300),
        argumentsPreview: redact(data.arguments ?? '', limits.maxToolArgumentChars),
        argumentsHash: toolFingerprint(data.name ?? '', args),
        turn: asInteger(data.turn, state.execution.turn),
        step: asInteger(data.step, state.execution.step),
        startedSeq: seq,
        status: 'started',
        outcomeUnknown: false,
      }
      state.tools.push(record)
      state.tools = state.tools.slice(-limits.maxToolHistory)
      state.pendingToolCalls.push(record)
      state.pendingToolCalls = state.pendingToolCalls.slice(-limits.maxToolHistory)
      break
    }
    case 'tool/result': {
      const message = data.message ?? {}
      const callId = resultCallId(message)
      const index = state.pendingToolCalls.findIndex(call => call.callId === callId)
      if (index >= 0) state.pendingToolCalls.splice(index, 1)
      let existing = index >= 0
        ? state.tools.find(call => call.callId === callId)
        : [...state.tools].reverse().find(call => call.callId === callId)
      if (existing === undefined) {
        existing = {
          callId,
          name: 'unknown-tool',
          argumentsPreview: '',
          argumentsHash: null,
          turn: asInteger(data.turn, state.execution.turn),
          step: asInteger(data.step, state.execution.step),
          startedSeq: null,
          status: 'started',
          outcomeUnknown: false,
        }
        state.tools.push(existing)
        state.tools = state.tools.slice(-limits.maxToolHistory)
      }
      const errorCode = String(data.error?.code ?? '')
      const errorName = String(data.error?.name ?? '')
      const unknown = errorCode === TOOL_OUTCOME_UNKNOWN || errorName === 'ToolOutcomeUnknownError'
      existing.status = unknown ? 'unknown' : message.isError === true ? 'error' : 'completed'
      existing.outcomeUnknown = unknown
      existing.result = toolResultText(message, limits)
      existing.finishedSeq = seq
      existing.error = data.error
        ? {
            code: redact(errorCode, 120),
            name: redact(errorName, 120),
            ...(typeof data.error.reason === 'string'
              ? { reason: redact(data.error.reason, MAX_STORED_TOOL_ERROR) }
              : {}),
          }
        : null
      if (data.error) {
        state.lastToolError = {
          callId,
          code: existing.error?.code ?? '',
          name: existing.error?.name ?? '',
          seq,
        }
      }
      break
    }
    case 'llm/retry': {
      state.retry = {
        retry: asInteger(data.retry, 0),
        maxRetries: asInteger(data.maxRetries, 0),
        delayMs: asInteger(data.delayMs, 0),
        failure: data.failure
          ? {
              code: redact(data.failure.code ?? '', 120),
              message: redact(data.failure.message ?? '', 1000),
            }
          : null,
        atSeq: seq,
      }
      break
    }
    default:
      break
  }

  markCheckpoint(state, event)
  return state
}

/** Record an out-of-band agent error that may have no durable event body. */
export function recordAgentError(state, error, turn, step) {
  const failure = classifyFailure(error)
  const hasPendingTools = state.pendingToolCalls.length > 0
  const eligible = failure.autoResumeEligible && !hasPendingTools
  state.interruption = {
    kind: failure.kind,
    code: failure.code,
    message: failure.message,
    turn: asInteger(turn, state.execution.turn),
    step: asInteger(step, state.execution.step),
    at: Date.now(),
    safeToRetry: failure.retryable && !hasPendingTools,
    autoResumeEligible: eligible,
    unfinishedOperations: state.pendingToolCalls.map(call => call.callId),
    firstAction: eligible
      ? 'Wait for bounded readiness recovery, then resume from this checkpoint and inspect durable state before acting.'
      : 'Inspect the error and workspace state; do not retry blindly.',
  }
  state.recovery.eligible = eligible
  state.recovery.duplicateGuardActive = false
  transitionStatus(state, failure.autoResumeEligible ? 'INTERRUPTED' : 'FAILED', 'agent-error', {})
  state.updatedAt = Date.now()
  return state
}

/** Set a specific non-network interruption such as an internal write failure. */
export function recordFailure(state, kind, message) {
  state.interruption = {
    kind: redact(kind, 120),
    message: redact(message, 2000),
    at: Date.now(),
    safeToRetry: false,
    autoResumeEligible: false,
    unfinishedOperations: state.pendingToolCalls.map(call => call.callId),
    firstAction: 'Inspect the checkpoint and error before any retry.',
  }
  state.recovery.eligible = false
  state.recovery.duplicateGuardActive = false
  transitionStatus(state, 'FAILED', `failure:${kind}`, {})
  return state
}

/** Render the bounded recovery context injected on the first resumed step. */
export function renderRecoveryContext(state, maxChars = DEFAULT_LIMITS.maxRecoveryContextChars) {
  const completedTools = state.tools
    .filter(call => call.status === 'completed')
    .slice(-20)
    .map(call => `- ${call.name || 'tool'} (${call.callId || 'unknown'}) completed`)
  const uncertainTools = state.tools
    .filter(call => call.status === 'started' || call.status === 'unknown' || call.outcomeUnknown)
    .slice(-20)
    .map(call => {
      const label = call.outcomeUnknown || call.status === 'unknown'
        ? 'outcome unknown'
        : 'started without a durable result'
      return `- ${call.name || 'tool'} (${call.callId || 'unknown'}) ${label}`
    })
  const recentResults = state.confirmedResults
    .slice(-6)
    .map(result => `- turn ${result.turn} step ${result.step}: ${result.text}`)
  const todos = state.todos
    .slice(0, 30)
    .map(todo => `- [${todo.status}] ${todo.content}`)
  const interruption = state.interruption
    ? `${state.interruption.kind}${state.interruption.code ? ` / ${state.interruption.code}` : ''}: ${state.interruption.message ?? ''}`
    : '(none recorded)'

  const lines = [
    `${RECOVERY_MARKER} — not a new user request]`,
    '',
    `Task ID: ${state.taskId}`,
    `Status at interruption: ${state.status}`,
    `Last interruption: ${interruption}`,
    `Provider/model: ${state.provider ?? '(unknown)'} / ${state.model ?? '(unknown)'}`,
    `Goal: ${state.goal ? `${state.goal.id} (${state.goal.phase}, revision ${state.goal.revision})` : '(none)'}`,
    `Original objective: ${state.originalInstruction ?? state.goal?.objective ?? '(not captured)'}`,
    `Current phase: ${state.execution.currentStep ? `turn ${state.execution.currentStep.turn} step ${state.execution.currentStep.step}` : (state.phase ?? state.status)}`,
    '',
    'Completed tool operations (do not repeat them):',
    completedTools.length > 0 ? completedTools.join('\n') : '- (none recorded)',
    '',
    'Unfinished or unknown tool operations:',
    uncertainTools.length > 0 ? uncertainTools.join('\n') : '- (none recorded)',
    '',
    'Recent durable visible results:',
    recentResults.length > 0 ? recentResults.join('\n') : '- (none recorded)',
    '',
    'Current todo state:',
    todos.length > 0 ? todos.join('\n') : '- (none recorded)',
    '',
    'Recovery constraints:',
    '- Stay on the original objective above. Do not widen or replace the task.',
    '- Treat the durable session, workspace, and tool results as authoritative.',
    '- Do not repeat a completed tool call. If an outcome is unknown, inspect the actual external/workspace state before retrying it.',
    '- Prefer read-only verification over a blind retry of a side-effecting operation.',
    '- Do not invent or persist hidden chain-of-thought. Use only visible results and this structured state.',
    '- Continue from the first unfinished step and verify the result before claiming completion.',
  ]
  const text = lines.join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 40))}\n…[recovery context truncated by policy]`
}

/** Build both the stable JSON and the human-readable Markdown checkpoint documents. */
export function checkpointDocuments(state, limits = DEFAULT_LIMITS) {
  const now = Date.now()
  const safeState = redactJson(state)
  const json = {
    ...safeState,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
    rawReasoningPolicy:
      'not-persisted: model CoT is represented only by block count and character count',
    storageNotice:
      'Local-only checkpoint. dsh-task-checkpoint-guard never uploads or remotely syncs this file.',
  }
  const md = [
    `# DSH task checkpoint — ${state.taskId}`,
    '',
    `- Session: ${state.sessionId}`,
    `- Status: ${state.status}`,
    `- Phase: ${state.phase}`,
    `- Provider/model: ${state.provider ?? '(unknown)'} / ${state.model ?? '(unknown)'}`,
    `- Goal: ${state.goal ? `${state.goal.id} (${state.goal.phase}, revision ${state.goal.revision})` : '(none)'}`,
    `- Last checkpoint: seq ${state.lastCheckpoint.seq ?? '(none)'} (${state.lastCheckpoint.eventType ?? 'none'})`,
    `- Updated: ${new Date(now).toISOString()}`,
    '',
    '## Original objective',
    state.originalInstruction ?? state.goal?.objective ?? '(not captured)',
    '',
    '## Current state',
    `- Goal rounds: ${state.goal?.roundsStarted ?? 0}/${state.goal?.maxGoalRounds ?? '(unknown)'}`,
    `- Current step: ${state.execution.currentStep ? `turn ${state.execution.currentStep.turn}, step ${state.execution.currentStep.step}` : '(none)'}`,
    `- Completed steps: ${state.execution.completedSteps.length}`,
    `- Pending tool calls: ${state.pendingToolCalls.length}`,
    `- Reasoning text: intentionally not persisted (${state.lastAssistant?.reasoningChars ?? 0} chars last observed)`,
    '',
    '## Todos',
    ...(state.todos.length > 0 ? state.todos.map(todo => `- [${todo.status}] ${todo.content}`) : ['- (none)']),
    '',
    '## Recent visible results',
    ...(state.confirmedResults.length > 0
      ? state.confirmedResults.map(result => `- turn ${result.turn} step ${result.step}: ${result.text}`)
      : ['- (none)']),
    '',
    '## Tools',
    ...(state.tools.length > 0
      ? state.tools.map(call => `- ${call.status}: ${call.name} (${call.callId})${call.result ? ` — ${call.result}` : ''}`)
      : ['- (none)']),
    '',
    '## Interruption and recovery',
    `- Interruption: ${state.interruption ? JSON.stringify(redactJson(state.interruption)) : '(none)'}`,
    `- Recovery: ${JSON.stringify(redactJson(state.recovery))}`,
    '',
    '> Local-only file. No credentials or hidden reasoning are deliberately stored. Do not publish this file.',
  ].join('\n')
  return { json, md }
}

/** Normalize a potentially old or tampered checkpoint document. */
export function normalizeLoadedState(session, raw, limits = DEFAULT_LIMITS) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('checkpoint document must be a JSON object')
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`unsupported checkpoint schemaVersion ${String(raw.schemaVersion)}`)
  }
  const sessionId = String(session?.id ?? 'unknown')
  if (raw.sessionId !== sessionId) throw new Error('checkpoint sessionId does not match the live session')
  if (typeof raw.taskId !== 'string' || raw.taskId.length === 0) {
    throw new Error('checkpoint taskId is missing or invalid')
  }

  const state = createTaskState(session, asInteger(raw.createdAt, Date.now()))
  state.updatedAt = asInteger(raw.updatedAt, state.createdAt)
  state.taskId = raw.taskId
  state.agentPreset = session?.header?.agentPreset ?? null
  state.provider = asString(raw.provider, 200)
  state.model = asString(raw.model, 300)
  state.reasoningEffort = asString(raw.reasoningEffort, 100)
  state.originalInstruction = asString(raw.originalInstruction, MAX_INSTRUCTION_CHARS)
  if (raw.lastUserInstruction && typeof raw.lastUserInstruction === 'object') {
    state.lastUserInstruction = {
      text: asString(raw.lastUserInstruction.text, MAX_INSTRUCTION_CHARS),
      seq: Number.isSafeInteger(raw.lastUserInstruction.seq) ? raw.lastUserInstruction.seq : null,
      time: Number.isSafeInteger(raw.lastUserInstruction.time) ? raw.lastUserInstruction.time : null,
    }
  }
  state.status = STATUSES.includes(raw.status) ? raw.status : 'PENDING'
  state.phase = STATUSES.includes(raw.phase) ? raw.phase : state.status
  state.statusHistory = asArray(raw.statusHistory).slice(-MAX_STATUS_HISTORY).map(item => ({
    from: asString(item?.from, 40),
    to: asString(item?.to, 40),
    reason: asString(item?.reason, 200),
    seq: Number.isSafeInteger(item?.seq) ? item.seq : null,
    at: asInteger(item?.at, 0),
  }))

  if (raw.goal && typeof raw.goal === 'object' && typeof raw.goal.id === 'string') {
    state.goal = {
      id: raw.goal.id,
      revision: asInteger(raw.goal.revision, 1),
      objective: asString(raw.goal.objective, MAX_INSTRUCTION_CHARS) ?? '',
      phase: GOAL_PHASES.has(raw.goal.phase) ? raw.goal.phase : 'active',
      maxGoalRounds: Number.isSafeInteger(raw.goal.maxGoalRounds) ? raw.goal.maxGoalRounds : null,
      roundsStarted: asInteger(raw.goal.roundsStarted, 0),
      lastOperation: asString(raw.goal.lastOperation, 80),
    }
    state.taskId = state.goal.id
  }

  state.todos = asArray(raw.todos).slice(0, MAX_TODOS).map(todo => ({
    content: redact(todo?.content ?? '', 1000),
    status: TODO_STATUSES.has(todo?.status) ? todo.status : 'unknown',
  }))

  if (raw.execution && typeof raw.execution === 'object') {
    state.execution.turn = asInteger(raw.execution.turn, 0)
    state.execution.step = asInteger(raw.execution.step, 0)
    state.execution.currentStep = raw.execution.currentStep && typeof raw.execution.currentStep === 'object'
      ? {
          turn: asInteger(raw.execution.currentStep.turn, 0),
          step: asInteger(raw.execution.currentStep.step, 0),
          startedAt: asInteger(raw.execution.currentStep.startedAt, 0),
          seq: Number.isSafeInteger(raw.execution.currentStep.seq) ? raw.execution.currentStep.seq : null,
        }
      : null
    state.execution.completedSteps = asArray(raw.execution.completedSteps)
      .slice(-MAX_COMPLETED_STEPS)
      .map(item => ({
        turn: asInteger(item?.turn, 0),
        step: asInteger(item?.step, 0),
        endedAt: asInteger(item?.endedAt, 0),
        seq: Number.isSafeInteger(item?.seq) ? item.seq : null,
      }))
    state.execution.lastTurnEnd = raw.execution.lastTurnEnd && typeof raw.execution.lastTurnEnd === 'object'
      ? {
          turn: asInteger(raw.execution.lastTurnEnd.turn, 0),
          reason: asString(raw.execution.lastTurnEnd.reason, 2000),
          seq: Number.isSafeInteger(raw.execution.lastTurnEnd.seq) ? raw.execution.lastTurnEnd.seq : null,
        }
      : null
  }

  state.confirmedResults = asArray(raw.confirmedResults).slice(-MAX_CONFIRMED_RESULTS).map(result => ({
    turn: asInteger(result?.turn, 0),
    step: asInteger(result?.step, 0),
    text: redact(result?.text ?? '', MAX_RESULT_TEXT),
    seq: Number.isSafeInteger(result?.seq) ? result.seq : null,
  }))

  if (raw.lastAssistant && typeof raw.lastAssistant === 'object') {
    state.lastAssistant = {
      turn: asInteger(raw.lastAssistant.turn, 0),
      step: asInteger(raw.lastAssistant.step, 0),
      interrupted: asBoolean(raw.lastAssistant.interrupted),
      text: redact(raw.lastAssistant.text ?? '', MAX_ASSISTANT_TEXT),
      reasoningBlocks: asInteger(raw.lastAssistant.reasoningBlocks, 0),
      reasoningChars: asInteger(raw.lastAssistant.reasoningChars, 0),
      seq: Number.isSafeInteger(raw.lastAssistant.seq) ? raw.lastAssistant.seq : null,
      at: asInteger(raw.lastAssistant.at, 0),
    }
  }

  state.tools = asArray(raw.tools).slice(-limits.maxToolHistory).map(call => ({
    callId: String(call?.callId ?? ''),
    name: redact(call?.name ?? '', 300),
    argumentsPreview: redact(call?.argumentsPreview ?? '', limits.maxToolArgumentChars),
    argumentsHash: typeof call?.argumentsHash === 'string' ? call.argumentsHash.slice(0, 100) : null,
    turn: asInteger(call?.turn, 0),
    step: asInteger(call?.step, 0),
    startedSeq: Number.isSafeInteger(call?.startedSeq) ? call.startedSeq : null,
    finishedSeq: Number.isSafeInteger(call?.finishedSeq) ? call.finishedSeq : null,
    status: ['started', 'completed', 'error', 'unknown'].includes(call?.status) ? call.status : 'started',
    outcomeUnknown: asBoolean(call?.outcomeUnknown),
    result: asString(call?.result, limits.maxToolResultChars),
    error: call?.error && typeof call.error === 'object'
      ? {
          code: asString(call.error.code, 120),
          name: asString(call.error.name, 120),
          reason: asString(call.error.reason, MAX_STORED_TOOL_ERROR),
        }
      : null,
  }))
  state.pendingToolCalls = state.tools.filter(call => call.status === 'started')
  state.lastToolError = raw.lastToolError && typeof raw.lastToolError === 'object'
    ? {
        callId: asString(raw.lastToolError.callId, 200),
        code: asString(raw.lastToolError.code, 120),
        name: asString(raw.lastToolError.name, 120),
        seq: Number.isSafeInteger(raw.lastToolError.seq) ? raw.lastToolError.seq : null,
      }
    : null
  state.tokenUsage = raw.tokenUsage === undefined || raw.tokenUsage === null ? null : redactJson(raw.tokenUsage)
  state.retry = raw.retry && typeof raw.retry === 'object'
    ? {
        retry: asInteger(raw.retry.retry, 0),
        maxRetries: asInteger(raw.retry.maxRetries, 0),
        delayMs: asInteger(raw.retry.delayMs, 0),
        failure: raw.retry.failure && typeof raw.retry.failure === 'object'
          ? {
              code: asString(raw.retry.failure.code, 120),
              message: asString(raw.retry.failure.message, 1000),
            }
          : null,
        atSeq: Number.isSafeInteger(raw.retry.atSeq) ? raw.retry.atSeq : null,
      }
    : null
  state.lastEventSeq = Number.isSafeInteger(raw.lastEventSeq) ? raw.lastEventSeq : null
  state.lastCheckpoint = raw.lastCheckpoint && typeof raw.lastCheckpoint === 'object'
    ? {
        seq: Number.isSafeInteger(raw.lastCheckpoint.seq) ? raw.lastCheckpoint.seq : null,
        time: Number.isSafeInteger(raw.lastCheckpoint.time) ? raw.lastCheckpoint.time : null,
        eventType: asString(raw.lastCheckpoint.eventType, 120),
      }
    : { seq: null, time: null, eventType: null }

  if (raw.interruption && typeof raw.interruption === 'object') {
    state.interruption = {
      kind: asString(raw.interruption.kind, 120),
      message: asString(raw.interruption.message, 2000),
      code: asString(raw.interruption.code, 120),
      atSeq: Number.isSafeInteger(raw.interruption.atSeq) ? raw.interruption.atSeq : null,
      turn: Number.isSafeInteger(raw.interruption.turn) ? raw.interruption.turn : null,
      step: Number.isSafeInteger(raw.interruption.step) ? raw.interruption.step : null,
      at: Number.isSafeInteger(raw.interruption.at) ? raw.interruption.at : null,
      safeToRetry: asBoolean(raw.interruption.safeToRetry),
      autoResumeEligible: asBoolean(raw.interruption.autoResumeEligible),
      unfinishedOperations: asArray(raw.interruption.unfinishedOperations)
        .slice(0, limits.maxToolHistory)
        .map(callId => redact(callId, 200)),
      firstAction: asString(raw.interruption.firstAction, 1000),
      manualOverride: asBoolean(raw.interruption.manualOverride),
    }
  }

  const rawRecovery = raw.recovery && typeof raw.recovery === 'object' ? raw.recovery : {}
  state.recovery = {
    eligible: asBoolean(rawRecovery.eligible),
    attempts: asInteger(rawRecovery.attempts, 0),
    resumeAttempts: asInteger(rawRecovery.resumeAttempts, 0),
    lastProbe: rawRecovery.lastProbe && typeof rawRecovery.lastProbe === 'object'
      ? {
          at: asInteger(rawRecovery.lastProbe.at, 0),
          elapsedMs: asInteger(rawRecovery.lastProbe.elapsedMs, 0),
          status: Number.isSafeInteger(rawRecovery.lastProbe.status) ? rawRecovery.lastProbe.status : null,
          authenticated: asBoolean(rawRecovery.lastProbe.authenticated),
          ok: asBoolean(rawRecovery.lastProbe.ok),
          reachable: asBoolean(rawRecovery.lastProbe.reachable),
          error: rawRecovery.lastProbe.error && typeof rawRecovery.lastProbe.error === 'object'
            ? {
                name: asString(rawRecovery.lastProbe.error.name, 120),
                code: asString(rawRecovery.lastProbe.error.code, 120),
                message: asString(rawRecovery.lastProbe.error.message, 800),
              }
            : asString(rawRecovery.lastProbe.error, 800),
        }
      : null,
    lastOutcome: asString(rawRecovery.lastOutcome, 120),
    note: asString(rawRecovery.note, 2000),
    blockedReason: asString(rawRecovery.blockedReason, 500),
    pendingContextInjection: false,
    injectedAtSeq: Number.isSafeInteger(rawRecovery.injectedAtSeq) ? rawRecovery.injectedAtSeq : null,
    duplicateGuardActive: asBoolean(rawRecovery.duplicateGuardActive),
  }
  state.rawReasoningPolicy =
    'not-persisted: model CoT is represented only by block count and character count'
  state.storageNotice =
    'Local-only checkpoint. dsh-task-checkpoint-guard never uploads or remotely syncs this file.'
  return state
}

/**
 * Return whether an exact tool call must be denied after recovery.
 * Completed calls are never replayed exactly; calls with unknown outcomes must
 * first be verified with a different operation.
 */
export function duplicateToolDecision(state, name, args, policy = 'deny-on-recovery') {
  if (policy !== 'deny-on-recovery' || state?.recovery?.duplicateGuardActive !== true) {
    return { block: false }
  }
  const fingerprint = toolFingerprint(name, args)
  const completed = state.tools.find(call => call.status === 'completed' && call.argumentsHash === fingerprint)
  if (completed) {
    return {
      block: true,
      kind: 'completed',
      reason: `Tool "${name}" was already completed with identical arguments before the interruption. Do not replay it; use the recorded result or verify external state with a different check.`,
    }
  }
  const unknown = state.tools.find(
    call => (call.status === 'unknown' || call.outcomeUnknown) && call.argumentsHash === fingerprint,
  )
  if (unknown) {
    return {
      block: true,
      kind: 'unknown',
      reason: `Tool "${name}" has an unknown prior outcome with identical arguments. Inspect the actual workspace or external state first; do not retry blindly.`,
    }
  }
  return { block: false }
}

export { resetTaskState }
