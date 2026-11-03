/**
 * Bounded, defensive text projection and secret redaction.
 *
 * Everything that can reach a checkpoint, a recovery prompt, or a log passes
 * through this module first. The functions are deliberately independent of
 * DSH so they can be unit-tested without a host.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

const DEFAULT_MAX_TEXT = 6000
const DEFAULT_MAX_STRING = 4000
const DEFAULT_MAX_DEPTH = 8
const DEFAULT_MAX_ITEMS = 100

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi

const SECRET_PATTERNS = [
  [PRIVATE_KEY_PATTERN, '<redacted-private-key>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, '<redacted-api-key>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<redacted-github-token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<redacted-github-token>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<redacted-slack-token>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted-aws-key>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<redacted-jwt>'],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<redacted>@'],
  [/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key)=)[^&\s#]+/gi, '$1<redacted>'],
  [
    /(["']?(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie|credential)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi,
    '$1<redacted>',
  ],
]

const SECRET_KEY_PATTERN =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|proxy-authorization|cookie|set-cookie|credential|private[_-]?key)$/i

/** Whether a JSON key conventionally names a credential. */
export function isSecretKey(key) {
  return SECRET_KEY_PATTERN.test(String(key))
}

/**
 * Redact common credential shapes and bound the result.
 * @param {unknown} value text or value to stringify
 * @param {number} [max] maximum returned characters
 * @returns {string} redacted, truncated text
 */
export function redact(value, max = DEFAULT_MAX_TEXT) {
  let text
  if (typeof value === 'string') {
    text = value
  } else if (value === undefined) {
    text = ''
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (typeof text !== 'string') text = String(text)
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement)
  }
  if (text.length > max) {
    return `${text.slice(0, max)}\n…[${text.length - max} chars omitted]`
  }
  return text
}

/**
 * Recursively redact a JSON-like value. Secret-looking keys replace their whole
 * value; string values also pass through the shape-based redactor.
 * @param {unknown} value input value
 * @param {{maxDepth?: number, maxString?: number, maxItems?: number}} [options]
 * @returns {unknown} a JSON-safe redacted value
 */
export function redactJson(value, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxString = options.maxString ?? DEFAULT_MAX_STRING
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS
  const seen = new WeakSet()

  function walk(candidate, depth, key) {
    if (isSecretKey(key)) return '<redacted>'
    if (candidate === null || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'string') return redact(candidate, maxString)
    if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : null
    if (typeof candidate === 'bigint') return `${candidate.toString()}n`
    if (typeof candidate === 'undefined' || typeof candidate === 'function' || typeof candidate === 'symbol') {
      return null
    }
    if (depth >= maxDepth) return '<max-depth>'
    if (typeof candidate === 'object') {
      if (seen.has(candidate)) return '<circular>'
      seen.add(candidate)
      if (Array.isArray(candidate)) {
        return candidate.slice(0, maxItems).map(item => walk(item, depth + 1, undefined))
      }
      const output = {}
      let count = 0
      for (const [childKey, childValue] of Object.entries(candidate)) {
        if (count++ >= maxItems) {
          output.__truncated__ = true
          break
        }
        output[redact(childKey, 200)] = walk(childValue, depth + 1, childKey)
      }
      return output
    }
    return redact(String(candidate), maxString)
  }

  return walk(value, 0, undefined)
}

/**
 * Render one thrown value without exposing headers, credentials, or a full
 * object graph.
 * @param {unknown} error thrown value
 * @param {number} [max] maximum returned characters
 * @returns {string} redacted error summary
 */
export function safeError(error, max = 800) {
  if (error instanceof Error) {
    const code = typeof error.code === 'string' ? ` [${error.code}]` : ''
    return redact(`${error.name}${code}: ${error.message}`, max)
  }
  if (error && typeof error === 'object') {
    const name = typeof error.name === 'string' ? error.name : 'Error'
    const code = typeof error.code === 'string' ? ` [${error.code}]` : ''
    const message = typeof error.message === 'string' ? error.message : undefined
    return redact(message === undefined ? error : `${name}${code}: ${message}`, max)
  }
  return redact(String(error), max)
}

/**
 * Use only origin + pathname in a log. Query strings and fragments can carry
 * access tokens and must never be persisted.
 * @param {string} rawUrl URL to sanitize
 * @returns {string} a safe endpoint label
 */
export function safeUrlForLog(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return '<invalid-url>'
  }
}

/**
 * Replace local home-directory prefixes in a diagnostic string. This keeps
 * public bug reports from leaking the machine's directory layout.
 * @param {string} value text to sanitize
 * @returns {string} sanitized text
 */
export function redactHomePath(value) {
  let text = String(value ?? '')
  const home = homedir()
  if (home) {
    text = text.split(home).join('<home>')
    text = text.split(home.replaceAll('\\', '/')).join('<home>')
  }
  if (process.env.DSH_HOME) {
    text = text.split(process.env.DSH_HOME).join('<dsh-home>')
    text = text.split(process.env.DSH_HOME.replaceAll('\\', '/')).join('<dsh-home>')
  }
  return text
}

/**
 * Extract visible text blocks only. Reasoning, image data, and provider
 * metadata are deliberately excluded from durable checkpoints.
 * @param {unknown} content message content blocks
 * @returns {string} concatenated visible text
 */
export function visibleText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Count reasoning blocks and their characters without preserving the text.
 * @param {unknown} content message content blocks
 * @returns {{blocks: number, chars: number}} reasoning facts
 */
export function reasoningFacts(content) {
  if (!Array.isArray(content)) return { blocks: 0, chars: 0 }
  let blocks = 0
  let chars = 0
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'reasoning') continue
    blocks++
    if (typeof block.text === 'string') chars += block.text.length
  }
  return { blocks, chars }
}

/**
 * Stable JSON canonicalization for tool-call fingerprints. Object keys are
 * sorted recursively; arrays keep their order.
 * @param {unknown} value JSON-like value
 * @returns {string} canonical JSON text
 */
export function canonicalJson(value) {
  function sort(candidate) {
    if (Array.isArray(candidate)) return candidate.map(sort)
    if (candidate && typeof candidate === 'object') {
      const result = {}
      for (const key of Object.keys(candidate).sort()) result[key] = sort(candidate[key])
      return result
    }
    return candidate
  }
  try {
    return JSON.stringify(sort(value))
  } catch {
    return JSON.stringify(redact(String(value), DEFAULT_MAX_TEXT))
  }
}

/**
 * Parse raw JSON tool arguments, falling back to the raw string when malformed.
 * @param {unknown} raw raw model argument text
 * @returns {unknown} parsed value or raw text
 */
export function parseArguments(raw) {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Hash a tool name and its canonical arguments. Only the digest is persisted
 * for duplicate detection; the checkpoint keeps a bounded redacted preview.
 * @param {string} name tool name
 * @param {unknown} args parsed or raw arguments
 * @returns {string} sha256-prefixed fingerprint
 */
export function toolFingerprint(name, args) {
  const material = `${String(name)}\u0000${canonicalJson(args)}`
  return `sha256:${createHash('sha256').update(material).digest('hex')}`
}
