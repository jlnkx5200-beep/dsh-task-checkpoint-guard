/**
 * Bounded, provider-neutral readiness probing and recovery-message creation.
 * Credentials are resolved per probe and never copied into a result object.
 */
import { randomUUID } from 'node:crypto'
import { safeError, redact } from './redact.js'
import { RECOVERY_MARKER, renderRecoveryContext } from './state.js'

/**
 * Abortable sleep.
 * @param {number} ms delay in milliseconds
 * @param {AbortSignal} signal cancellation signal
 * @returns {Promise<boolean>} true when the delay elapsed, false when aborted
 */
export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const timer = setTimeout(() => finish(true), ms)
    const onAbort = () => finish(false)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Exponential backoff with bounded symmetric jitter.
 * @param {object} config normalized recovery config
 * @param {number} attempt 1-based attempt number
 * @param {() => number} [random] random source for tests
 * @returns {number} delay in milliseconds
 */
export function probeDelay(config, attempt, random = Math.random) {
  const base = Math.min(
    config.initialProbeDelayMs * 2 ** Math.max(0, attempt - 1),
    config.maxProbeDelayMs,
  )
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
  return Math.min(Math.round(base * jitter), config.maxProbeDelayMs)
}

function acceptedStatus(config, status) {
  if (config.probeExpectedStatuses.length > 0) {
    return config.probeExpectedStatuses.includes(status)
  }
  return status >= 200 && status < 300
}

async function resolveAuthorization(config, credentials) {
  if (config.probeAuth !== 'bearer') return { headers: {}, authenticated: false }
  if (credentials === undefined || typeof credentials.resolve !== 'function') {
    return {
      error: {
        name: 'CredentialUnavailable',
        code: 'CREDENTIAL_SERVICE_UNAVAILABLE',
        message: 'bearer probe configured but the credentials service is unavailable',
      },
      authenticated: false,
    }
  }
  try {
    const resolved = await credentials.resolve(config.credentialRef)
    if (typeof resolved?.value !== 'string' || resolved.value.length === 0) {
      return {
        error: {
          name: 'CredentialUnavailable',
          code: 'CREDENTIAL_NOT_CONFIGURED',
          message: 'configured credential reference did not resolve to a value',
        },
        authenticated: false,
      }
    }
    return {
      headers: { Authorization: `Bearer ${resolved.value}` },
      authenticated: true,
    }
  } catch (error) {
    return {
      error: {
        name: 'CredentialResolutionError',
        code: 'CREDENTIAL_RESOLUTION_FAILED',
        message: safeError(error, 500),
      },
      authenticated: false,
    }
  }
}

/**
 * Execute one bounded HEAD/GET probe. The response body is never read and
 * redirects are rejected so an authorization header cannot follow a redirect.
 * @param {object} config normalized config
 * @param {object|undefined} credentials optional credentials service
 * @param {AbortSignal} signal cancellation signal
 * @param {typeof fetch} [fetchImpl] injectable fetch for tests
 * @returns {Promise<object>} a credential-free probe result
 */
export async function probeOnce(config, credentials, signal, fetchImpl = fetch) {
  const started = Date.now()
  if (signal?.aborted) return { at: started, elapsedMs: 0, ok: false, reachable: false, aborted: true }
  const auth = await resolveAuthorization(config, credentials)
  if (auth.error) {
    return {
      at: started,
      elapsedMs: Date.now() - started,
      ok: false,
      reachable: false,
      authenticated: false,
      error: auth.error,
    }
  }

  const local = new AbortController()
  const timer = setTimeout(() => local.abort(new Error('probe timeout')), config.probeTimeoutMs)
  const fused = AbortSignal.any([signal, local.signal])
  try {
    const response = await fetchImpl(config.probeUrl, {
      method: config.probeMethod,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'dsh-task-checkpoint-guard/0.1.0',
        ...auth.headers,
      },
      redirect: 'error',
      signal: fused,
    })
    await response.body?.cancel().catch(() => {})
    return {
      at: Date.now(),
      elapsedMs: Date.now() - started,
      status: response.status,
      authenticated: auth.authenticated,
      ok: acceptedStatus(config, response.status),
      reachable: response.status < 500,
    }
  } catch (error) {
    return {
      at: Date.now(),
      elapsedMs: Date.now() - started,
      authenticated: auth.authenticated,
      ok: false,
      reachable: false,
      aborted: signal.aborted,
      error: {
        name: typeof error?.name === 'string' ? error.name : 'Error',
        code: typeof error?.code === 'string' ? error.code : undefined,
        message: safeError(error, 800),
      },
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wait for one successful readiness probe, or for the configured deferred
 * delay. A 401/403 is terminal: the network is reachable but credentials are
 * not good enough to justify a model round.
 * @param {object} config normalized config
 * @param {object|undefined} credentials optional credentials service
 * @param {AbortSignal} signal cancellation signal
 * @param {{fetchImpl?: typeof fetch, random?: () => number}} [options]
 * @returns {Promise<object>} readiness decision
 */
export async function waitForReadiness(config, credentials, signal, options = {}) {
  if (config.recoveryMode === 'off') {
    return { ready: false, terminal: true, reason: 'recovery-disabled', attempts: 0, probe: null }
  }
  if (config.recoveryMode === 'deferred') {
    if (!await sleep(config.initialProbeDelayMs, signal)) {
      return { ready: false, terminal: false, reason: 'aborted', attempts: 0, probe: null }
    }
    return { ready: true, terminal: false, reason: 'deferred', attempts: 0, probe: null }
  }

  let lastProbe = null
  for (let attempt = 1; attempt <= config.maxProbeAttempts; attempt++) {
    if (!await sleep(probeDelay(config, attempt, options.random), signal)) {
      return { ready: false, terminal: false, reason: 'aborted', attempts: attempt - 1, probe: lastProbe }
    }
    const probe = await probeOnce(config, credentials, signal, options.fetchImpl ?? fetch)
    lastProbe = probe
    if (probe.ok) {
      return { ready: true, terminal: false, reason: 'probe-ok', attempts: attempt, probe }
    }
    if (probe.status === 401 || probe.status === 403) {
      return {
        ready: false,
        terminal: true,
        reason: 'credential-rejected',
        attempts: attempt,
        probe,
      }
    }
    if (probe.error?.code === 'CREDENTIAL_SERVICE_UNAVAILABLE'
      || probe.error?.code === 'CREDENTIAL_NOT_CONFIGURED'
      || probe.error?.code === 'CREDENTIAL_RESOLUTION_FAILED') {
      return {
        ready: false,
        terminal: true,
        reason: 'credential-unavailable',
        attempts: attempt,
        probe,
      }
    }
    if (probe.aborted) {
      return { ready: false, terminal: false, reason: 'aborted', attempts: attempt, probe }
    }
  }
  return {
    ready: false,
    terminal: true,
    reason: 'probe-exhausted',
    attempts: config.maxProbeAttempts,
    probe: lastProbe,
  }
}

/**
 * Build the user-role context message injected before the resumed goal round.
 * The custom source identifies it as plugin context rather than a human prompt.
 * @param {object} state task state
 * @param {number} maxChars recovery-context bound
 * @returns {object} a DSH UserMessage-compatible plain object
 */
export function createRecoveryMessage(state, maxChars) {
  const text = renderRecoveryContext(state, maxChars)
  if (!text.startsWith(RECOVERY_MARKER)) {
    throw new Error('recovery message lost its system-generated marker')
  }
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: redact(text, maxChars) }],
    source: {
      kind: 'task-checkpoint-guard',
      form: 'notice',
      summary: 'Recovered durable task checkpoint',
    },
  }
}
