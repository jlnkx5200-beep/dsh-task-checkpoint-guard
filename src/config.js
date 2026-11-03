/**
 * Configuration schema and runtime path resolution.
 *
 * This file implements the Standard Schema interface Cordis expects from a
 * plugin's exported `Config`. Keeping the schema dependency-free is deliberate:
 * the plugin can be installed into a profile without adding a second copy of a
 * schema library or any other runtime package.
 */
import { homedir } from 'node:os'
import path from 'node:path'

export const CONFIG_DEFAULTS = Object.freeze({
  recoveryMode: 'off',
  probeMethod: 'GET',
  probeAuth: 'none',
  probeExpectedStatuses: Object.freeze([]),
  probeTimeoutMs: 5000,
  maxProbeAttempts: 5,
  initialProbeDelayMs: 1000,
  maxProbeDelayMs: 30000,
  jitterRatio: 0.2,
  maxAutoResumes: 3,
  providerFilter: null,
  duplicateToolPolicy: 'deny-on-recovery',
  maxToolHistory: 80,
  maxToolResultChars: 2000,
  maxToolArgumentChars: 1000,
  maxRecoveryContextChars: 16000,
  persistDebounceMs: 100,
  reconstructFromSessionQuery: true,
})

const ALLOWED_KEYS = new Set([
  'checkpointRoot',
  ...Object.keys(CONFIG_DEFAULTS),
  'probeUrl',
  'credentialRef',
])

const RECOVERY_MODES = new Set(['off', 'probe', 'deferred'])
const PROBE_METHODS = new Set(['GET', 'HEAD'])
const PROBE_AUTH_MODES = new Set(['none', 'bearer'])
const DUPLICATE_POLICIES = new Set(['off', 'deny-on-recovery'])
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function issue(message, field) {
  return { message, path: field === undefined ? undefined : [field] }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readBoolean(raw, key, fallback, issues) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    issues.push(issue(`${key} must be a boolean`, key))
    return fallback
  }
  return value
}

function readInteger(raw, key, fallback, minimum, maximum, issues) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issues.push(issue(`${key} must be an integer between ${minimum} and ${maximum}`, key))
    return fallback
  }
  return value
}

function readNumber(raw, key, fallback, minimum, maximum, issues) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    issues.push(issue(`${key} must be a finite number between ${minimum} and ${maximum}`, key))
    return fallback
  }
  return value
}

function readEnum(raw, key, fallback, allowed, issues) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.has(value)) {
    issues.push(issue(`${key} must be one of ${[...allowed].join(', ')}`, key))
    return fallback
  }
  return value
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]'
}

function normalizeProbeUrl(rawUrl, issues) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    issues.push(issue('probeUrl must be a non-empty absolute http(s) URL', 'probeUrl'))
    return undefined
  }
  let parsed
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    issues.push(issue('probeUrl must be a valid absolute URL', 'probeUrl'))
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    issues.push(issue('probeUrl must use http: or https:', 'probeUrl'))
    return undefined
  }
  if (parsed.username || parsed.password) {
    issues.push(issue('probeUrl must not embed credentials; use probeAuth and credentialRef', 'probeUrl'))
    return undefined
  }
  if (parsed.hash) {
    issues.push(issue('probeUrl must not contain a fragment', 'probeUrl'))
    return undefined
  }
  return parsed.toString()
}

function normalizeCheckpointRootInput(raw, issues) {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') {
    issues.push(issue('checkpointRoot must be an absolute path or start with ~/', 'checkpointRoot'))
    return undefined
  }
  try {
    return normalizeAbsolutePath(raw)
  } catch (error) {
    issues.push(issue(String(error?.message ?? error), 'checkpointRoot'))
    return undefined
  }
}

/**
 * Expand a leading tilde and require an absolute path.
 * @param {string} raw raw path
 * @returns {string} normalized absolute path
 */
export function normalizeAbsolutePath(raw) {
  let value = String(raw).trim()
  if (value.includes('\0')) throw new Error('path must not contain NUL bytes')
  if (value === '~') value = homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(homedir(), value.slice(2))
  if (!path.isAbsolute(value)) {
    throw new Error('path must be absolute (or start with ~/); relative paths depend on the launch directory')
  }
  return path.normalize(value)
}

/**
 * Resolve the effective local checkpoint root.
 *
 * The DSH home is resolved at plugin start so a launcher-selected home is
 * honoured. The DSH_HOME environment variable and the platform home are
 * fallbacks for standalone tests and non-Hub launches.
 * @param {string | undefined} configured normalized configured path, if any
 * @param {string | undefined} [dshHomePath] host-provided DSH home
 * @returns {string} absolute checkpoint root
 */
export function resolveCheckpointRoot(configured, dshHomePath) {
  if (configured !== undefined && configured !== null && configured !== '') {
    return normalizeAbsolutePath(configured)
  }
  const rawHome = typeof dshHomePath === 'string' && dshHomePath.trim().length > 0
    ? dshHomePath
    : process.env.DSH_HOME
  const home = rawHome && rawHome.trim().length > 0
    ? normalizeAbsolutePath(rawHome)
    : path.join(homedir(), '.dsh')
  return path.join(home, 'task-checkpoints')
}

/**
 * Validate and materialize one raw bundle configuration.
 * @param {unknown} raw raw plugin config
 * @returns {{value?: object, issues?: Array<{message: string, path?: string[]}>}} Standard Schema result
 */
export function validateAndNormalizeConfig(raw) {
  const issues = []
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    return { issues: [issue('configuration must be an object')] }
  }
  const input = raw ?? {}
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) issues.push(issue(`unknown configuration field "${key}"`, key))
  }

  const recoveryMode = readEnum(input, 'recoveryMode', CONFIG_DEFAULTS.recoveryMode, RECOVERY_MODES, issues)
  const probeMethod = readEnum(input, 'probeMethod', CONFIG_DEFAULTS.probeMethod, PROBE_METHODS, issues)
  const probeAuth = readEnum(input, 'probeAuth', CONFIG_DEFAULTS.probeAuth, PROBE_AUTH_MODES, issues)
  const duplicateToolPolicy = readEnum(
    input,
    'duplicateToolPolicy',
    CONFIG_DEFAULTS.duplicateToolPolicy,
    DUPLICATE_POLICIES,
    issues,
  )

  let probeUrl
  if (input.probeUrl !== undefined && input.probeUrl !== null) {
    probeUrl = normalizeProbeUrl(input.probeUrl, issues)
  }
  if (recoveryMode === 'probe' && probeUrl === undefined) {
    issues.push(issue('recoveryMode "probe" requires probeUrl', 'probeUrl'))
  }

  let credentialRef
  if (input.credentialRef !== undefined && input.credentialRef !== null && input.credentialRef !== '') {
    if (typeof input.credentialRef !== 'string' || !CREDENTIAL_REF_PATTERN.test(input.credentialRef)) {
      issues.push(issue('credentialRef must be an environment-variable-style identifier', 'credentialRef'))
    } else {
      credentialRef = input.credentialRef
    }
  }
  if (probeAuth === 'bearer' && credentialRef === undefined) {
    issues.push(issue('probeAuth "bearer" requires credentialRef', 'credentialRef'))
  }
  if (probeAuth === 'none' && credentialRef !== undefined) {
    issues.push(issue('credentialRef requires probeAuth "bearer"', 'probeAuth'))
  }
  if (probeAuth === 'bearer' && probeUrl !== undefined) {
    const parsed = new URL(probeUrl)
    if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
      issues.push(issue('bearer-authenticated probes must use https unless the host is loopback', 'probeUrl'))
    }
  }

  let probeExpectedStatuses = []
  if (input.probeExpectedStatuses !== undefined && input.probeExpectedStatuses !== null) {
    if (!Array.isArray(input.probeExpectedStatuses)) {
      issues.push(issue('probeExpectedStatuses must be an array of HTTP status codes', 'probeExpectedStatuses'))
    } else {
      const unique = new Set()
      for (const status of input.probeExpectedStatuses) {
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          issues.push(issue('probeExpectedStatuses entries must be integers from 100 to 599', 'probeExpectedStatuses'))
          break
        }
        unique.add(status)
      }
      probeExpectedStatuses = [...unique]
    }
  }

  const probeTimeoutMs = readInteger(input, 'probeTimeoutMs', CONFIG_DEFAULTS.probeTimeoutMs, 250, 60000, issues)
  const maxProbeAttempts = readInteger(input, 'maxProbeAttempts', CONFIG_DEFAULTS.maxProbeAttempts, 1, 12, issues)
  const initialProbeDelayMs = readInteger(
    input,
    'initialProbeDelayMs',
    CONFIG_DEFAULTS.initialProbeDelayMs,
    0,
    60000,
    issues,
  )
  const maxProbeDelayMs = readInteger(input, 'maxProbeDelayMs', CONFIG_DEFAULTS.maxProbeDelayMs, 0, 300000, issues)
  if (maxProbeDelayMs < initialProbeDelayMs) {
    issues.push(issue('maxProbeDelayMs must be greater than or equal to initialProbeDelayMs', 'maxProbeDelayMs'))
  }
  const jitterRatio = readNumber(input, 'jitterRatio', CONFIG_DEFAULTS.jitterRatio, 0, 1, issues)
  const maxAutoResumes = readInteger(input, 'maxAutoResumes', CONFIG_DEFAULTS.maxAutoResumes, 0, 10, issues)
  const maxToolHistory = readInteger(input, 'maxToolHistory', CONFIG_DEFAULTS.maxToolHistory, 1, 200, issues)
  const maxToolResultChars = readInteger(
    input,
    'maxToolResultChars',
    CONFIG_DEFAULTS.maxToolResultChars,
    100,
    20000,
    issues,
  )
  const maxToolArgumentChars = readInteger(
    input,
    'maxToolArgumentChars',
    CONFIG_DEFAULTS.maxToolArgumentChars,
    0,
    10000,
    issues,
  )
  const maxRecoveryContextChars = readInteger(
    input,
    'maxRecoveryContextChars',
    CONFIG_DEFAULTS.maxRecoveryContextChars,
    1000,
    50000,
    issues,
  )
  const persistDebounceMs = readInteger(
    input,
    'persistDebounceMs',
    CONFIG_DEFAULTS.persistDebounceMs,
    0,
    5000,
    issues,
  )
  const reconstructFromSessionQuery = readBoolean(
    input,
    'reconstructFromSessionQuery',
    CONFIG_DEFAULTS.reconstructFromSessionQuery,
    issues,
  )

  let providerFilter = CONFIG_DEFAULTS.providerFilter
  if (input.providerFilter !== undefined && input.providerFilter !== null && input.providerFilter !== '') {
    if (typeof input.providerFilter !== 'string' || input.providerFilter.trim().length === 0) {
      issues.push(issue('providerFilter must be a non-empty string or null', 'providerFilter'))
    } else if (input.providerFilter.length > 200) {
      issues.push(issue('providerFilter must be at most 200 characters', 'providerFilter'))
    } else {
      providerFilter = input.providerFilter.trim()
    }
  }

  const checkpointRoot = normalizeCheckpointRootInput(input.checkpointRoot, issues)

  if (issues.length > 0) return { issues }

  return {
    value: Object.freeze({
      ...(checkpointRoot === undefined ? {} : { checkpointRoot }),
      recoveryMode,
      ...(probeUrl === undefined ? {} : { probeUrl }),
      probeMethod,
      probeAuth,
      ...(credentialRef === undefined ? {} : { credentialRef }),
      probeExpectedStatuses: Object.freeze(probeExpectedStatuses),
      probeTimeoutMs,
      maxProbeAttempts,
      initialProbeDelayMs,
      maxProbeDelayMs,
      jitterRatio,
      maxAutoResumes,
      providerFilter,
      duplicateToolPolicy,
      maxToolHistory,
      maxToolResultChars,
      maxToolArgumentChars,
      maxRecoveryContextChars,
      persistDebounceMs,
      reconstructFromSessionQuery,
    }),
  }
}

/** Cordis-loadable Standard Schema object. */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-task-checkpoint-guard',
    validate: validateAndNormalizeConfig,
  }),
})
