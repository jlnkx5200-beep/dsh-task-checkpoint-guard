/**
 * dsh-task-checkpoint-guard host plugin.
 *
 * The plugin consumes only documented DSH services and events:
 * - ctx.agents / ctx.sessions (required)
 * - ctx.goals (optional; needed for automatic goal reactivation)
 * - ctx.credentials (optional; needed for authenticated probes)
 * - ctx.sessionQuery (optional; used to reconcile missing history)
 * - session/event, agent/* and tools/pre-execute events
 *
 * It imports only Node built-ins, so installing or linking the package does not
 * add a second DSH package instance to the profile.
 */
import { createTaskState, duplicateToolDecision, ingestEvent, recordAgentError, transitionStatus } from './state.js'
import { Config, resolveCheckpointRoot } from './config.js'
import { loadCheckpoint, persistCheckpoint } from './storage.js'
import { createRecoveryMessage, sleep, waitForReadiness } from './recovery.js'
import { redact, redactHomePath, safeError } from './redact.js'

export const name = 'task-checkpoint-guard'
export const inject = ['agents', 'sessions']
export { Config }

const IMMEDIATE_EVENTS = new Set([
  'user/message',
  'goal/change',
  'turn/start',
  'turn/end',
  'assistant/message',
  'tool/call',
  'tool/result',
])

const CHECKPOINT_EVENTS = new Set([
  'request/header',
  'model/selection',
  'user/message',
  'goal/change',
  'todo/write',
  'turn/start',
  'step/start',
  'step/end',
  'turn/end',
  'assistant/message',
  'tool/call',
  'tool/result',
  'llm/retry',
])

function normalizeConfig(rawConfig) {
  const result = Config['~standard'].validate(rawConfig ?? {})
  if (result.issues) {
    const error = new TypeError(
      `invalid dsh-task-checkpoint-guard config:\n${result.issues.map(item => `- ${item.message}`).join('\n')}`,
    )
    error.issues = result.issues
    throw error
  }
  return result.value
}

function shortId(value) {
  const text = String(value ?? '')
  return text.length <= 12 ? text : `${text.slice(0, 8)}…`
}

function hasPendingInbox(agent) {
  const nextTurn = agent?.inbox?.nextTurn?.length ?? 0
  const nextStep = agent?.inbox?.nextStep?.length ?? 0
  return nextTurn + nextStep > 0
}

function safeProbeFacts(probe) {
  if (!probe || typeof probe !== 'object') return null
  return {
    at: Number.isSafeInteger(probe.at) ? probe.at : Date.now(),
    elapsedMs: Number.isSafeInteger(probe.elapsedMs) ? probe.elapsedMs : 0,
    ...(Number.isInteger(probe.status) ? { status: probe.status } : {}),
    authenticated: probe.authenticated === true,
    ok: probe.ok === true,
    reachable: probe.reachable === true,
    ...(probe.error
      ? {
          error: {
            name: typeof probe.error.name === 'string' ? probe.error.name.slice(0, 120) : 'Error',
            ...(typeof probe.error.code === 'string' ? { code: probe.error.code.slice(0, 120) } : {}),
            message: safeError(probe.error, 800),
          },
        }
      : {}),
  }
}

/** Install checkpointing, recovery, and the recovery-only duplicate guard. */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const root = resolveCheckpointRoot(config.checkpointRoot, optionalGet('dshHomePath'))
  const limits = {
    maxToolHistory: config.maxToolHistory,
    maxToolResultChars: config.maxToolResultChars,
    maxToolArgumentChars: config.maxToolArgumentChars,
    maxRecoveryContextChars: config.maxRecoveryContextChars,
  }
  const states = new Map()
  const ensurePromises = new Map()
  const sessionOps = new Map()
  const operations = new Set()
  const writers = new Map()
  const recoveryControllers = new Map()
  const lifetime = new AbortController()
  let disposed = false

  const logger = ctx.logger ?? console

  function optionalGet(name) {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  function log(level, message, error) {
    try {
      const suffix = error === undefined ? '' : `: ${redactHomePath(safeError(error))}`
      const line = `task-checkpoint-guard: ${redactHomePath(String(message))}${suffix}`
      const method = logger?.[level] ?? logger?.debug ?? logger?.warn
      if (typeof method === 'function') method.call(logger, line)
    } catch {
      // Logging must never break the host.
    }
  }

  function track(promise) {
    operations.add(promise)
    promise.then(
      () => operations.delete(promise),
      () => operations.delete(promise),
    )
    return promise
  }

  function writerFor(state) {
    const key = String(state.sessionId)
    let writer = writers.get(key)
    if (writer === undefined) {
      writer = {
        key,
        dirty: false,
        reason: null,
        timer: null,
        running: null,
      }
      writers.set(key, writer)
    }
    return writer
  }

  function kickWriter(writer) {
    if (writer.running !== null) return writer.running
    if (!writer.dirty) return Promise.resolve()
    const state = states.get(writer.key)
    if (state === undefined) {
      writer.dirty = false
      return Promise.resolve()
    }
    writer.dirty = false
    const snapshot = structuredClone(state)
    const reason = writer.reason
    const run = (async () => {
      try {
        await persistCheckpoint(root, snapshot, limits)
        log('debug', `checkpoint saved (session=${shortId(writer.key)}, task=${shortId(snapshot.taskId)}, reason=${reason ?? 'unknown'})`)
      } catch (error) {
        log('warn', `checkpoint write failed (session=${shortId(writer.key)}, task=${shortId(snapshot.taskId)})`, error)
      }
    })()
    writer.running = run
    track(run)
    void run.finally(() => {
      if (writer.running === run) writer.running = null
      if (writer.dirty && !disposed && writer.timer === null) {
        writer.timer = setTimeout(() => {
          writer.timer = null
          void kickWriter(writer)
        }, config.persistDebounceMs)
        writer.timer.unref?.()
      }
    }).catch(() => {})
    return run
  }

  function schedulePersist(state, reason, immediate = false) {
    // Do not reject writes from already-queued event tasks during disposal;
    // cleanup drains those before removing the state maps.
    const writer = writerFor(state)
    writer.dirty = true
    writer.reason = reason
    if (immediate) {
      if (writer.timer !== null) {
        clearTimeout(writer.timer)
        writer.timer = null
      }
      void kickWriter(writer)
      return
    }
    if (writer.timer === null && writer.running === null) {
      writer.timer = setTimeout(() => {
        writer.timer = null
        void kickWriter(writer)
      }, config.persistDebounceMs)
      writer.timer.unref?.()
    }
  }

  async function flushWriter(writer) {
    if (writer.timer !== null) {
      clearTimeout(writer.timer)
      writer.timer = null
    }
    while (writer.running !== null || writer.dirty) {
      if (writer.running !== null) {
        await writer.running
        continue
      }
      await kickWriter(writer)
    }
  }

  async function flushAllWriters() {
    for (const writer of writers.values()) {
      if (writer.timer !== null) {
        clearTimeout(writer.timer)
        writer.timer = null
      }
    }
    await Promise.allSettled([...writers.values()].map(flushWriter))
  }

  async function hydrateState(session) {
    let loaded
    try {
      loaded = await loadCheckpoint(root, session, limits)
    } catch (error) {
      log('warn', `checkpoint load failed (session=${shortId(session.id)}); starting a new local record`, error)
    }
    const state = loaded?.state ?? createTaskState(session)
    state.agentPreset = session?.header?.agentPreset ?? state.agentPreset
    state.recovery.pendingContextInjection = false

    if (config.reconstructFromSessionQuery) {
      const query = optionalGet('sessionQuery')
      const currentLength = Number.isFinite(Number(session?.seq)) ? Number(session.seq) : null
      const lastSeq = state.lastEventSeq
      const missing = lastSeq === null
        ? currentLength === null || currentLength > 0
        : currentLength !== null && currentLength - 1 > lastSeq
      if (missing && query && typeof query.readSession === 'function') {
        try {
          const snapshot = await query.readSession(session.id)
          const events = Array.isArray(snapshot?.events) ? snapshot.events : []
          let replayed = 0
          for (const event of events) {
            if (lastSeq !== null && Number.isSafeInteger(event?.seq) && event.seq <= lastSeq) continue
            ingestEvent(state, event, limits)
            replayed++
          }
          log('debug', `reconciled ${replayed} session events from ctx.sessionQuery (session=${shortId(session.id)})`)
        } catch (error) {
          log('warn', `session history reconciliation failed (session=${shortId(session.id)})`, error)
        }
      } else if (missing) {
        log('debug', `no sessionQuery service; historical events before mount are not replayed (session=${shortId(session.id)})`)
      }
    }

    if (loaded?.fromPrevious) {
      log('warn', `recovered checkpoint from previous copy (session=${shortId(session.id)}, task=${shortId(state.taskId)})`)
    } else if (loaded?.via === 'scan') {
      log('warn', `recovered checkpoint via task-file scan (session=${shortId(session.id)})`)
    }
    return state
  }

  function ensureState(session) {
    const key = String(session.id)
    if (states.has(key)) return Promise.resolve(states.get(key))
    if (ensurePromises.has(key)) return ensurePromises.get(key)
    const promise = hydrateState(session)
      .then(state => {
        states.set(key, state)
        return state
      })
      .finally(() => ensurePromises.delete(key))
    ensurePromises.set(key, track(promise))
    return promise
  }

  function enqueue(session, task, label = 'session-task') {
    const key = String(session.id)
    const prior = sessionOps.get(key) ?? Promise.resolve()
    const next = prior
      .catch(() => {})
      .then(async () => {
        const state = await ensureState(session)
        return task(state)
      })
    const handled = next.catch(error => {
      log('warn', `${label} failed (session=${shortId(key)})`, error)
      return undefined
    })
    const tracked = track(handled)
    sessionOps.set(key, tracked)
    void tracked.finally(() => {
      if (sessionOps.get(key) === tracked) sessionOps.delete(key)
    }).catch(() => {})
    return tracked
  }

  function cancelRecovery(agentId, reason) {
    const controller = recoveryControllers.get(String(agentId))
    if (controller !== undefined) {
      controller.abort(new Error(reason))
      recoveryControllers.delete(String(agentId))
    }
  }

  function agentIsLive(agent) {
    try {
      return ctx.agents.get(agent.id) === agent
    } catch {
      return false
    }
  }

  function terminateRecovery(state, reason, note, probe) {
    state.recovery.eligible = false
    state.recovery.blockedReason = reason
    state.recovery.lastOutcome = reason
    state.recovery.note = note
    state.recovery.lastProbe = safeProbeFacts(probe)
    if (state.interruption !== null) {
      state.interruption = {
        ...state.interruption,
        autoResumeEligible: false,
        recoveryStoppedReason: reason,
      }
    }
    schedulePersist(state, `recovery:${reason}`, true)
  }

  async function recoverOnce(agent, seedState, signal) {
    const state = states.get(String(agent.id)) ?? seedState
    if (disposed || signal.aborted || !agentIsLive(agent)) return
    if (agent.status !== 'idle' || hasPendingInbox(agent)) {
      state.recovery.note = 'recovery deferred because the agent is not idle or has pending input'
      schedulePersist(state, 'recovery-deferred', true)
      return
    }
    if (state.interruption?.autoResumeEligible !== true) return
    if (state.recovery.blockedReason !== null) return
    if (state.recovery.resumeAttempts >= config.maxAutoResumes) {
      await enqueue(agent.session, current => {
        terminateRecovery(
          current,
          'max-auto-resumes',
          `automatic resume limit (${config.maxAutoResumes}) reached; checkpoint retained for manual recovery`,
          state.recovery.lastProbe,
        )
      }, 'recovery-limit')
      return
    }
    if (config.providerFilter !== null && state.provider !== config.providerFilter) {
      await enqueue(agent.session, current => {
        terminateRecovery(
          current,
          'provider-filter-mismatch',
          `provider "${state.provider ?? '(unknown)'}" does not match providerFilter "${config.providerFilter}"; checkpoint retained`,
          null,
        )
      }, 'recovery-provider-filter')
      return
    }

    const readiness = await waitForReadiness(
      config,
      optionalGet('credentials'),
      signal,
    )
    if (signal.aborted || disposed) return

    if (!readiness.ready) {
      if (readiness.terminal) {
        await enqueue(agent.session, current => {
          const map = {
            'credential-rejected': 'network is reachable but the probe returned HTTP 401/403; automatic resume stopped',
            'credential-unavailable': 'the configured probe credential could not be resolved; automatic resume stopped',
            'probe-exhausted': `network probe exhausted ${readiness.attempts} attempts; checkpoint retained for manual recovery`,
            'recovery-disabled': 'automatic recovery is disabled',
          }
          terminateRecovery(
            current,
            readiness.reason,
            map[readiness.reason] ?? `recovery stopped: ${readiness.reason}`,
            readiness.probe,
          )
        }, 'recovery-terminal')
      }
      return
    }

    await enqueue(agent.session, current => {
      if (signal.aborted || disposed) return
      if (!agentIsLive(agent) || agent.status !== 'idle' || hasPendingInbox(agent)) {
        current.recovery.note = 'recovery deferred after readiness because the agent became busy'
        schedulePersist(current, 'recovery-deferred-after-probe', true)
        return
      }
      if (current.interruption?.autoResumeEligible !== true) return
      current.recovery.attempts = readiness.attempts
      current.recovery.lastProbe = safeProbeFacts(readiness.probe)
      const goals = optionalGet('goals')
      if (goals === undefined || typeof goals.get !== 'function' || typeof goals.resume !== 'function') {
        terminateRecovery(
          current,
          'goal-service-unavailable',
          'goal service is unavailable; checkpoint retained for manual recovery',
          readiness.probe,
        )
        return
      }

      let goal
      try {
        goal = goals.get(agent)
      } catch (error) {
        terminateRecovery(
          current,
          'goal-read-failed',
          `could not read the current goal: ${safeError(error, 500)}`,
          readiness.probe,
        )
        return
      }
      if (goal === undefined) {
        terminateRecovery(
          current,
          'no-current-goal',
          'no current goal exists for this session; checkpoint retained for manual continuation',
          readiness.probe,
        )
        return
      }
      if (goal.phase !== 'active') {
        terminateRecovery(
          current,
          `goal-${String(goal.phase)}`,
          `goal is in phase "${String(goal.phase)}"; automatic recovery only resumes an active, disarmed goal`,
          readiness.probe,
        )
        return
      }
      if (goal.activation === 'armed') {
        terminateRecovery(
          current,
          'goal-already-armed',
          'goal is already armed; the plugin will not queue a duplicate continuation',
          readiness.probe,
        )
        return
      }
      if (Number(goal.roundsStarted) >= Number(goal.maxGoalRounds)) {
        terminateRecovery(
          current,
          'goal-round-budget-exhausted',
          `goal round budget is exhausted (${String(goal.roundsStarted)}/${String(goal.maxGoalRounds)})`,
          readiness.probe,
        )
        return
      }
      if (typeof agent.inject !== 'function') {
        terminateRecovery(
          current,
          'agent-inject-unavailable',
          'this DSH agent does not expose the documented inject() capability; checkpoint retained',
          readiness.probe,
        )
        return
      }

      const message = createRecoveryMessage(current, config.maxRecoveryContextChars)
      let resumed
      try {
        resumed = goals.resume(agent, { id: goal.id, revision: goal.revision })
      } catch (error) {
        terminateRecovery(
          current,
          'goal-resume-failed',
          `goal re-arm failed: ${safeError(error, 500)}`,
          readiness.probe,
        )
        return
      }
      try {
        agent.inject(message)
      } catch (error) {
        try {
          goals.disarm?.(agent)
        } catch {
          // Best effort: the original injection failure is the useful error.
        }
        terminateRecovery(
          current,
          'context-injection-failed',
          `goal was re-armed but structured context injection failed; goal continuation was disarmed: ${safeError(error, 500)}`,
          readiness.probe,
        )
        return
      }

      current.goal = {
        ...(current.goal ?? {}),
        id: resumed?.id ?? goal.id,
        revision: resumed?.revision ?? goal.revision + 1,
        objective: current.goal?.objective ?? goal.objective ?? '',
        phase: resumed?.phase ?? 'active',
        maxGoalRounds: resumed?.maxGoalRounds ?? goal.maxGoalRounds,
        roundsStarted: resumed?.roundsStarted ?? goal.roundsStarted,
      }
      current.taskId = current.goal.id
      transitionStatus(current, 'RECOVERING', 'goal-rearmed', {
        seq: current.lastEventSeq,
      })
      current.interruption = current.interruption === null
        ? null
        : {
            ...current.interruption,
            autoResumeEligible: false,
            recoveredAt: Date.now(),
          }
      current.recovery.eligible = false
      current.recovery.resumeAttempts += 1
      current.recovery.lastOutcome = 'goal-rearmed'
      current.recovery.lastProbe = safeProbeFacts(readiness.probe)
      current.recovery.note =
        'network readiness confirmed; goal rearmed and structured recovery context injected'
      current.recovery.pendingContextInjection = false
      current.recovery.injectedAtSeq = Number.isSafeInteger(Number(agent.session?.seq))
        ? Number(agent.session.seq)
        : current.lastEventSeq
      current.recovery.duplicateGuardActive =
        config.duplicateToolPolicy === 'deny-on-recovery'
      schedulePersist(current, 'goal-rearmed', true)
      log('debug', `goal rearmed after readiness recovery (session=${shortId(agent.id)})`)
    }, 'recovery-rearm')
  }

  function scheduleRecovery(agent, state, source) {
    if (disposed || config.recoveryMode === 'off') return
    if (state.interruption?.autoResumeEligible !== true) return
    if (state.recovery.blockedReason !== null) return
    if (recoveryControllers.has(String(agent.id))) return
    if (!agentIsLive(agent)) return
    if (state.recovery.resumeAttempts >= config.maxAutoResumes) {
      void enqueue(agent.session, current => {
        terminateRecovery(
          current,
          'max-auto-resumes',
          `automatic resume limit (${config.maxAutoResumes}) reached; checkpoint retained for manual recovery`,
          current.recovery.lastProbe,
        )
      }, 'recovery-limit')
      return
    }
    const controller = new AbortController()
    recoveryControllers.set(String(agent.id), controller)
    const task = (async () => {
      const delayMs = source === 'agent-created' || source === 'mount' ? 0 : 50
      if (!await sleep(delayMs, controller.signal)) return
      await recoverOnce(agent, state, controller.signal)
    })()
      .catch(error => {
        if (!controller.signal.aborted) log('warn', `automatic recovery failed (session=${shortId(agent.id)})`, error)
      })
      .finally(() => {
        if (recoveryControllers.get(String(agent.id)) === controller) {
          recoveryControllers.delete(String(agent.id))
        }
      })
    track(task)
  }

  const offSessionEvent = ctx.on('session/event', (session, event) => {
    if (disposed) return
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      cancelRecovery(session.id, 'human input superseded automatic recovery')
    }
    if (event.type === 'turn/start') cancelRecovery(session.id, 'a turn started before recovery')
    void enqueue(session, state => {
      ingestEvent(state, event, limits)
      if (CHECKPOINT_EVENTS.has(event.type)) {
        schedulePersist(state, event.type, IMMEDIATE_EVENTS.has(event.type))
      }
    }, `event:${event.type}`)
  })

  const offAgentCreated = ctx.on('agent/created', async ({ agent }) => {
    if (disposed) return
    await enqueue(agent.session, state => {
      schedulePersist(state, 'agent-created', true)
      if (state.interruption?.autoResumeEligible) scheduleRecovery(agent, state, 'agent-created')
    }, 'agent-created')
  })

  const offAgentError = ctx.on('agent/error', ({ agent, turn, step, error }) => {
    if (disposed) return
    cancelRecovery(agent.id, 'a new agent error superseded recovery')
    void enqueue(agent.session, state => {
      recordAgentError(state, error, turn, step)
      schedulePersist(state, 'agent/error', true)
    }, 'agent-error')
  })

  const offAgentStatus = ctx.on('agent/status', ({ agent, status }) => {
    if (disposed || status !== 'idle') return
    void enqueue(agent.session, state => {
      if (state.interruption?.autoResumeEligible) scheduleRecovery(agent, state, 'idle')
    }, 'agent-idle')
  })

  const offAgentDisposed = ctx.on('agent/disposed', ({ agent }) => {
    cancelRecovery(agent.id, 'agent disposed')
    const key = String(agent.id)
    const task = (async () => {
      await enqueue(agent.session, state => schedulePersist(state, 'agent-disposed', true), 'agent-disposed')
      const writer = writers.get(key)
      if (writer !== undefined) await flushWriter(writer)
      states.delete(key)
      ensurePromises.delete(key)
      writers.delete(key)
    })().catch(error => log('warn', `agent disposal checkpoint failed (session=${shortId(key)})`, error))
    track(task)
  })

  const offPreTool = ctx.on('tools/pre-execute', async (exec, next) => {
    if (disposed || config.duplicateToolPolicy === 'off') return next()
    const session = exec?.agent?.session
    if (session === undefined) return next()
    const verdict = await enqueue(session, state => (
      duplicateToolDecision(state, exec.name, exec.arguments, config.duplicateToolPolicy)
    ), 'duplicate-tool-guard')
    if (verdict?.block === true) {
      const safeName = redact(exec.name, 160)
      log('debug', `blocked exact duplicate ${safeName} during recovery (session=${shortId(session.id)})`)
      return { kind: 'deny', reason: redact(verdict.reason, 800) }
    }
    return next()
  })

  const offs = [
    offSessionEvent,
    offAgentCreated,
    offAgentError,
    offAgentStatus,
    offAgentDisposed,
    offPreTool,
  ].filter(disposer => typeof disposer === 'function')

  // Reconstruct checkpoint contexts for agents that were already live when this
  // plugin mounted, then offer recovery if a durable interruption still exists.
  try {
    for (const agent of ctx.agents.list()) {
      const task = (async () => {
        const state = await ensureState(agent.session)
        schedulePersist(state, 'plugin-mounted', true)
        if (state.interruption?.autoResumeEligible) scheduleRecovery(agent, state, 'mount')
      })().catch(error => log('warn', `mount hydration failed (session=${shortId(agent.id)})`, error))
      track(task)
    }
  } catch (error) {
    log('warn', 'could not enumerate existing agents during plugin mount', error)
  }

  ctx.effect(() => async () => {
    if (disposed) return
    disposed = true
    lifetime.abort(new Error('plugin disposed'))
    for (const controller of recoveryControllers.values()) {
      controller.abort(new Error('plugin disposed'))
    }
    recoveryControllers.clear()
    for (const off of offs) {
      try {
        off()
      } catch {
        // Framework disposal is idempotent; a double dispose must not fail.
      }
    }
    for (const writer of writers.values()) {
      if (writer.timer !== null) {
        clearTimeout(writer.timer)
        writer.timer = null
      }
    }
    while (operations.size > 0) {
      await Promise.allSettled([...operations])
    }
    await flushAllWriters()
    while (operations.size > 0) {
      await Promise.allSettled([...operations])
    }
    states.clear()
    ensurePromises.clear()
    sessionOps.clear()
    writers.clear()
    log('debug', 'checkpoint guard disposed')
  })

  log('debug', `active (recoveryMode=${config.recoveryMode}, duplicateToolPolicy=${config.duplicateToolPolicy})`)
}
