/**
 * Atomic local persistence for the independent v0.2.0 memory schema.
 *
 * Multiple agents in one DSH process share one per-file lock. Every mutation
 * reloads the latest valid document, so two captured concepts cannot overwrite
 * each other with a stale in-memory snapshot.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  atomicWriteText,
  readJsonWithPrevious,
} from '../storage.js'
import {
  MEMORY_KIND,
  MEMORY_SCHEMA_VERSION,
  createEmptyMemoryDocument,
  memoryPath,
  normalizeMemoryDocument,
} from './schema.js'

const locks = new Map()
const caches = new Map()

async function withLock(key, task) {
  const prior = locks.get(key)?.promise ?? Promise.resolve()
  const entry = {}
  entry.promise = prior.catch(() => {}).then(task)
  locks.set(key, entry)
  try {
    return await entry.promise
  } finally {
    if (locks.get(key) === entry) locks.delete(key)
  }
}

function validateMemoryDocument(scopeId) {
  return parsed => {
    if (parsed?.schemaVersion !== MEMORY_SCHEMA_VERSION) {
      throw new Error('memory document schemaVersion mismatch')
    }
    if (parsed?.kind !== MEMORY_KIND) throw new Error('memory document kind mismatch')
    if (String(parsed?.scopeId) !== String(scopeId)) throw new Error('memory document scope mismatch')
    return parsed
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

/** One durable memory scope backed by a separate JSON document. */
export class MemoryStore {
  constructor(options) {
    if (typeof options?.root !== 'string' || !path.isAbsolute(options.root)) {
      throw new TypeError('memory root must be an absolute path')
    }
    if (typeof options?.scopeId !== 'string' || options.scopeId.length === 0) {
      throw new TypeError('memory scopeId must be a non-empty string')
    }
    this.root = path.normalize(options.root)
    this.scopeId = options.scopeId
    this.file = memoryPath(this.root, this.scopeId)
    this.logger = options.logger
    this.options = {
      maxRecordChars: options.maxRecordChars ?? 2000,
      maxMemoryHistoryVersions: options.maxMemoryHistoryVersions ?? 20,
      maxMemoryAuditEntries: options.maxMemoryAuditEntries ?? 200,
    }
    this.cacheKey = `memory:${path.normalize(this.file)}`
  }

  async _loadUnlocked() {
    const result = await readJsonWithPrevious(
      this.file,
      validateMemoryDocument(this.scopeId),
    )
    if (result.value === undefined) {
      const empty = createEmptyMemoryDocument(this.scopeId)
      caches.set(this.cacheKey, empty)
      return { document: clone(empty), fromPrevious: false, existed: false }
    }
    const normalized = normalizeMemoryDocument(result.value, this.scopeId, this.options)
    caches.set(this.cacheKey, normalized)
    return {
      document: clone(normalized),
      fromPrevious: result.fromPrevious,
      existed: true,
    }
  }

  /**
   * Synchronous startup read used only to make persisted memory available to
   * the first prompt assembly. Mutations still use the async lock + atomic path.
   */
  readSync() {
    const candidates = [this.file, `${this.file}.previous`]
    const failures = []
    for (const [index, candidate] of candidates.entries()) {
      let text
      try {
        text = readFileSync(candidate, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        failures.push({ file: candidate, error })
        continue
      }
      try {
        const parsed = JSON.parse(text)
        if (parsed?.schemaVersion !== MEMORY_SCHEMA_VERSION
          || parsed?.kind !== MEMORY_KIND
          || String(parsed?.scopeId) !== String(this.scopeId)) {
          throw new Error('memory document identity mismatch')
        }
        const normalized = normalizeMemoryDocument(parsed, this.scopeId, this.options)
        caches.set(this.cacheKey, normalized)
        return {
          document: clone(normalized),
          existed: true,
          fromPrevious: index > 0,
          file: this.file,
          failures,
        }
      } catch (error) {
        failures.push({ file: candidate, error })
      }
    }
    if (failures.length > 0) {
      const error = new Error('no valid memory document could be loaded synchronously')
      error.failures = failures
      throw error
    }
    const empty = createEmptyMemoryDocument(this.scopeId)
    caches.set(this.cacheKey, empty)
    return {
      document: clone(empty),
      existed: false,
      fromPrevious: false,
      file: this.file,
      failures: [],
    }
  }

  /**
   * Read the latest valid document. Callers receive a clone so concurrent
   * readers cannot mutate the cache or one another's state.
   */
  async read() {
    return withLock(this.cacheKey, async () => {
      const loaded = await this._loadUnlocked()
      return {
        document: loaded.document,
        fromPrevious: loaded.fromPrevious,
        existed: loaded.existed,
        file: this.file,
      }
    })
  }

  /**
   * Atomically mutate one document under the shared per-file lock.
   *
   * @param {(document: object) => ({result?: unknown, changed?: boolean} | void)} mutator
   * @returns {Promise<{result: unknown, document: object, changed: boolean, file: string}>}
   */
  async update(mutator) {
    return withLock(this.cacheKey, async () => {
      const loaded = await this._loadUnlocked()
      const draft = clone(loaded.document)
      const outcome = await mutator(draft)
      const changed = outcome?.changed !== false
      if (!changed) {
        return {
          result: outcome?.result,
          document: loaded.document,
          changed: false,
          file: this.file,
        }
      }
      draft.schemaVersion = MEMORY_SCHEMA_VERSION
      draft.kind = MEMORY_KIND
      draft.scopeId = this.scopeId
      draft.revision = Math.max(1, Number(loaded.document.revision ?? 0) + 1)
      draft.updatedAt = Date.now()
      const normalized = normalizeMemoryDocument(draft, this.scopeId, this.options)
      const serialized = `${JSON.stringify(normalized, null, 2)}\n`
      await atomicWriteText(this.file, serialized, {
        mode: 0o600,
        validatePrior: text => {
          try {
            const parsed = JSON.parse(text)
            return parsed?.schemaVersion === MEMORY_SCHEMA_VERSION
              && parsed?.kind === MEMORY_KIND
              && String(parsed?.scopeId) === String(this.scopeId)
          } catch {
            return false
          }
        },
      })
      caches.set(this.cacheKey, normalized)
      return {
        result: outcome?.result,
        document: clone(normalized),
        changed: true,
        file: this.file,
      }
    })
  }

  /** Cached snapshot for synchronous prompt assembly. */
  snapshot() {
    const value = caches.get(this.cacheKey)
    return value === undefined ? null : clone(value)
  }

  /** Ensure the feature can report whether an on-disk document already exists. */
  async exists() {
    return await this.read().then(loaded => loaded.existed)
  }
}

export function clearMemoryStoreCacheForTests() {
  caches.clear()
}
