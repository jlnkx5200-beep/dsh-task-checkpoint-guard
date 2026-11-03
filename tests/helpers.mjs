import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'

export async function makeTempRoot(prefix = 'dsh-checkpoint-test-') {
  return mkdtemp(path.join(tmpdir(), prefix))
}

export async function removeTempRoot(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

export function makeSession(id = 'session-test-1', seq = 0, header = { agentPreset: 'test-preset' }) {
  return {
    id,
    header: { id, isSeeded: false, ...header },
    seq,
    snapshotEvents() {
      throw new Error('the production plugin must not call deprecated snapshotEvents()')
    },
  }
}

export function makeAgent(session, initialStatus = 'idle') {
  const agent = {
    id: session.id,
    session,
    status: initialStatus,
    inbox: { nextTurn: [], nextStep: [] },
    injected: [],
    followups: [],
    cancels: [],
    inject(message) {
      this.injected.push(message)
      this.inbox.nextStep.push(message)
    },
    followup(message) {
      this.followups.push(message)
      this.inbox.nextTurn.push(message)
    },
    cancel(cause) {
      this.cancels.push(cause)
    },
    setStatus(status) {
      this.status = status
    },
    drainInbox() {
      this.inbox.nextTurn = []
      this.inbox.nextStep = []
    },
  }
  return agent
}

function listenerKey(event) {
  return String(event)
}

/**
 * Small Cordis-like context for plugin tests. It intentionally exposes only the
 * documented methods the plugin is allowed to use.
 */
export function makeFakeContext(options = {}) {
  const listeners = new Map()
  const disposers = []
  const logs = { debug: [], warn: [], error: [], info: [] }
  const services = {
    dshHomePath: options.dshHomePath,
    goals: options.goals,
    credentials: options.credentials,
    sessionQuery: options.sessionQuery,
  }

  const agents = options.agents ?? []
  const sessions = options.sessions ?? []

  const ctx = {
    services,
    logs,
    agents: {
      list: () => [...agents],
      get: id => agents.find(agent => agent.id === id),
    },
    sessions: {
      list: () => [...sessions],
      get: id => sessions.find(session => session.id === id),
    },
    logger: {
      debug: (...args) => logs.debug.push(args),
      warn: (...args) => logs.warn.push(args),
      error: (...args) => logs.error.push(args),
      info: (...args) => logs.info.push(args),
    },
    get(name) {
      return services[name]
    },
    on(event, handler) {
      const key = listenerKey(event)
      let set = listeners.get(key)
      if (set === undefined) {
        set = new Set()
        listeners.set(key, set)
      }
      set.add(handler)
      let removed = false
      const off = () => {
        if (removed) return
        removed = true
        set.delete(handler)
      }
      disposers.push(off)
      return off
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    async emit(event, payload, ...rest) {
      const set = listeners.get(listenerKey(event))
      if (set === undefined) return []
      const results = []
      for (const handler of [...set]) {
        results.push(await handler(payload, ...rest))
      }
      return results
    },
    listenerCount(event) {
      return listeners.get(listenerKey(event))?.size ?? 0
    },
    async dispose() {
      for (const dispose of [...disposers].reverse()) {
        await dispose()
      }
      disposers.length = 0
      listeners.clear()
    },
    async emitSession(session, event) {
      session.seq = Math.max(session.seq, Number(event.seq) + 1)
      await ctx.emit('session/event', session, event)
    },
  }

  return ctx
}

export function textMessageEvent(seq, text, source = { kind: 'user' }, time = Date.now()) {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      id: `message-${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source,
    },
    surfaceOp: 'append',
  }
}

export function goalChangeEvent(seq, goal, operation = 'create', roundsStarted = 0, time = Date.now()) {
  return {
    type: 'goal/change',
    seq,
    time,
    data: {
      kind: 'goal/change',
      version: 1,
      operation,
      goal: { ...goal },
      roundsStarted,
      createdAt: time,
      updatedAt: time,
    },
  }
}

export function toolCallEvent(seq, callId, name, args, time = Date.now()) {
  return {
    type: 'tool/call',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  }
}

export function toolResultEvent(seq, callId, content, options = {}) {
  return {
    type: 'tool/result',
    seq,
    time: options.time ?? Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `tool-message-${seq}`,
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: content }],
        ...(options.isError === true ? { isError: true } : {}),
      },
      ...(options.error ? { error: options.error } : {}),
    },
  }
}

export async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw lastError ?? new Error('waitFor timed out')
}

export async function startProbeServer(options = {}) {
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
    })
    const respond = () => {
      const status = typeof options.status === 'function' ? options.status(request) : (options.status ?? 200)
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(options.body ?? '{"ok":true}')
    }
    if (options.delayMs > 0) setTimeout(respond, options.delayMs)
    else respond()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/health`
  return {
    url,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    }),
  }
}

export function makeFakeGoals(ctx, options = {}) {
  let goal = {
    id: options.id ?? 'goal-test-1',
    revision: 1,
    objective: options.objective ?? 'Finish the multi-stage task.',
    phase: options.phase ?? 'active',
    activation: options.activation ?? 'disarmed',
    maxGoalRounds: options.maxGoalRounds ?? 12,
    roundsStarted: options.roundsStarted ?? 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const calls = { get: 0, resume: 0, disarm: 0, pause: 0 }
  const service = {
    get() {
      calls.get++
      return goal === undefined ? undefined : { ...goal }
    },
    resume(agent, ref) {
      calls.resume++
      if (goal === undefined || ref.id !== goal.id || ref.revision !== goal.revision) {
        const error = new Error('goal revision is stale')
        error.code = 'GOAL_STALE_REVISION'
        throw error
      }
      goal = {
        ...goal,
        revision: goal.revision + 1,
        phase: 'active',
        activation: 'armed',
        updatedAt: Date.now(),
      }
      const event = goalChangeEvent(
        Number.isSafeInteger(agent.session.seq) ? agent.session.seq : 0,
        goal,
        'resume',
        goal.roundsStarted,
      )
      void ctx.emitSession(agent.session, event)
      return { ...goal }
    },
    disarm() {
      calls.disarm++
      goal = { ...goal, activation: 'disarmed' }
      return { ...goal }
    },
    pause(agent, ref) {
      calls.pause++
      goal = { ...goal, phase: 'paused', activation: 'disarmed', revision: ref.revision + 1 }
      return { ...goal }
    },
    snapshot() {
      return goal === undefined ? undefined : { ...goal }
    },
  }
  return { service, calls, get goal() { return goal } }
}
