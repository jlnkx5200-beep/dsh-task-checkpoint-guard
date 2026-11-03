/**
 * Local checkpoint persistence.
 *
 * Durability properties in this module:
 * - each document is written to a unique same-directory temporary file,
 *   fsynced, then renamed into place;
 * - the previous valid copy is retained as `<target>.previous`;
 * - an in-process per-target lock serializes writers;
 * - loaders validate the JSON and fall back to the previous copy;
 * - session pointers store relative task paths, never absolute workspace paths.
 *
 * Multi-process writers are not supported. This is documented in SECURITY.md.
 */
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { checkpointDocuments, normalizeLoadedState, safeFileId } from './state.js'

const locks = new Map()

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

async function writeTempFile(directory, text, mode) {
  const temporary = path.join(directory, `.tmp-${process.pid}-${randomUUID()}`)
  let handle
  try {
    handle = await open(temporary, 'wx', mode)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    return temporary
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function fsyncDirectory(directory) {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Best-effort replace that tolerates Windows' refusal to rename over a file. */
async function replaceFile(source, destination) {
  try {
    await rename(source, destination)
    return
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error?.code)) {
      await rm(source, { force: true }).catch(() => {})
      throw error
    }
  }

  const parked = `${destination}.parked-${process.pid}-${randomUUID()}`
  let parkedExisting = false
  try {
    try {
      await rename(destination, parked)
      parkedExisting = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await rename(source, destination)
    if (parkedExisting) await rm(parked, { force: true }).catch(() => {})
  } catch (error) {
    if (parkedExisting) await rename(parked, destination).catch(() => {})
    await rm(source, { force: true }).catch(() => {})
    throw error
  }
}

function isJsonObject(text) {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

async function writeAtomicUnlocked(target, text, options = {}) {
  const directory = path.dirname(target)
  const mode = options.mode ?? 0o600
  await mkdir(directory, { recursive: true, mode: 0o700 })

  let current
  try {
    current = await readFile(target, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  if (current !== undefined && (options.validatePrior?.(current) ?? true)) {
    const previous = `${target}.previous`
    const previousTemp = await writeTempFile(directory, current, mode)
    await replaceFile(previousTemp, previous)
  }

  const temporary = await writeTempFile(directory, text, mode)
  await replaceFile(temporary, target)
  await fsyncDirectory(directory).catch(() => {})
}

/**
 * Atomically replace one text file and retain the previous valid copy.
 * @param {string} target absolute target path
 * @param {string} text UTF-8 content
 * @param {{mode?: number, validatePrior?: (text: string) => boolean}} [options]
 * @returns {Promise<void>}
 */
export async function atomicWriteText(target, text, options = {}) {
  if (!path.isAbsolute(target)) throw new TypeError('atomicWriteText target must be absolute')
  await withLock(`file:${path.normalize(target)}`, () => writeAtomicUnlocked(target, text, options))
}

function checkpointJsonValidator(taskId, sessionId) {
  return text => {
    if (!isJsonObject(text)) return false
    try {
      const parsed = JSON.parse(text)
      return parsed.taskId === taskId && parsed.sessionId === sessionId
    } catch {
      return false
    }
  }
}

function pointerValidator(sessionId, taskId) {
  return text => {
    if (!isJsonObject(text)) return false
    try {
      const parsed = JSON.parse(text)
      return parsed.sessionId === sessionId && (taskId === undefined || parsed.taskId === taskId)
    } catch {
      return false
    }
  }
}

/**
 * Persist one structured task, its Markdown projection, and the session pointer.
 * @param {string} root absolute checkpoint root
 * @param {object} state task state
 * @param {object} [limits] size limits
 * @returns {Promise<{taskJson: string, taskMd: string, sessionPointer: string}>}
 */
export async function persistCheckpoint(root, state, limits) {
  if (!path.isAbsolute(root)) throw new TypeError('checkpointRoot must be absolute')
  const { json, md } = checkpointDocuments(state, limits)
  const taskId = safeFileId(state.taskId)
  const sessionId = safeFileId(state.sessionId)
  const taskJson = path.join(root, 'tasks', `${taskId}.json`)
  const taskMd = path.join(root, 'tasks', `${taskId}.md`)
  const sessionPointer = path.join(root, 'sessions', `${sessionId}.json`)
  const jsonText = `${JSON.stringify(json, null, 2)}\n`
  const mdText = `${md}\n`
  const pointerText = `${JSON.stringify({
    schemaVersion: 1,
    sessionId: state.sessionId,
    taskId: state.taskId,
    status: state.status,
    updatedAt: json.updatedAt,
    taskFile: `tasks/${path.basename(taskJson)}`,
    markdownFile: `tasks/${path.basename(taskMd)}`,
  }, null, 2)}\n`

  // One lock per session serializes both the task document and the shared
  // session pointer even if a goal switch changes the task id mid-flight.
  const lockKey = `checkpoint:${path.normalize(root)}:${sessionId}`
  await withLock(lockKey, async () => {
    await atomicWriteText(taskJson, jsonText, {
      validatePrior: checkpointJsonValidator(state.taskId, state.sessionId),
    })
    await atomicWriteText(taskMd, mdText, {
      validatePrior: text => text.startsWith('# DSH task checkpoint'),
    })
    await atomicWriteText(sessionPointer, pointerText, {
      validatePrior: pointerValidator(state.sessionId, state.taskId),
    })
  })
  return { taskJson, taskMd, sessionPointer }
}

/** Read and validate a JSON file, trying the previous copy on failure. */
export async function readJsonWithPrevious(file, validate) {
  const failures = []
  for (const [candidate, fromPrevious] of [[file, false], [`${file}.previous`, true]]) {
    let text
    try {
      text = await readFile(candidate, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') failures.push({ file: candidate, error })
      continue
    }
    try {
      const parsed = JSON.parse(text)
      const value = validate(parsed)
      return { value, path: candidate, fromPrevious, text }
    } catch (error) {
      failures.push({ file: candidate, error })
    }
  }
  return { value: undefined, failures }
}

function taskPath(root, taskId) {
  return path.join(root, 'tasks', `${safeFileId(taskId)}.json`)
}

function pointerPath(root, sessionId) {
  return path.join(root, 'sessions', `${safeFileId(sessionId)}.json`)
}

async function loadTaskCandidate(root, taskId, session, limits) {
  const file = taskPath(root, taskId)
  const result = await readJsonWithPrevious(file, parsed => {
    const state = normalizeLoadedState(session, parsed, limits)
    if (state.taskId !== taskId) {
      throw new Error('checkpoint task identity does not match its pointer')
    }
    return state
  })
  if (result.value === undefined) return { state: undefined, file, failures: result.failures }
  return {
    state: result.value,
    file: result.path,
    taskFile: file,
    fromPrevious: result.fromPrevious,
    failures: [],
  }
}

async function scanForLatestTask(root, session, limits) {
  const directory = path.join(root, 'tasks')
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: undefined, failures: [] }
    throw error
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(directory, entry.name)
    try {
      const text = await readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      if (parsed?.schemaVersion !== 1 || parsed?.sessionId !== String(session.id)) continue
      if (typeof parsed.taskId !== 'string' || parsed.taskId.length === 0) continue
      candidates.push({ taskId: parsed.taskId, updatedAt: Number(parsed.updatedAt) || 0 })
    } catch {
      // A corrupt candidate is ignored; the pointer and previous copies remain.
    }
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt)
  const failures = []
  for (const candidate of candidates.slice(0, 20)) {
    const loaded = await loadTaskCandidate(root, candidate.taskId, session, limits)
    if (loaded.state !== undefined) {
      return { ...loaded, scanned: true }
    }
    failures.push(...loaded.failures)
  }
  return { state: undefined, failures }
}

/**
 * Load the newest valid checkpoint for one session.
 * @param {string} root absolute checkpoint root
 * @param {object} session live session-like object with id and header
 * @param {object} [limits] size limits
 * @returns {Promise<object | undefined>} hydrated state and load provenance
 */
export async function loadCheckpoint(root, session, limits) {
  if (!path.isAbsolute(root)) throw new TypeError('checkpointRoot must be absolute')
  const sessionId = String(session.id)
  const pointer = pointerPath(root, sessionId)
  const pointerResult = await readJsonWithPrevious(pointer, parsed => {
    if (!isJsonObject(JSON.stringify(parsed))) throw new Error('pointer must be an object')
    if (parsed.sessionId !== sessionId) throw new Error('pointer sessionId mismatch')
    if (typeof parsed.taskId !== 'string' || parsed.taskId.length === 0) {
      throw new Error('pointer taskId is missing')
    }
    return parsed
  })
  const failures = [...(pointerResult.failures ?? [])]
  if (pointerResult.value !== undefined) {
    const loaded = await loadTaskCandidate(root, pointerResult.value.taskId, session, limits)
    if (loaded.state !== undefined) {
      return {
        state: loaded.state,
        fromPrevious: loaded.fromPrevious || pointerResult.fromPrevious,
        pointerFile: pointerResult.path,
        taskFile: loaded.taskFile,
        via: 'pointer',
      }
    }
    failures.push(...loaded.failures)
  }
  const scanned = await scanForLatestTask(root, session, limits)
  if (scanned.state !== undefined) {
    return {
      state: scanned.state,
      fromPrevious: scanned.fromPrevious,
      pointerFile: null,
      taskFile: scanned.taskFile,
      via: 'scan',
      scanned: true,
    }
  }
  failures.push(...(scanned.failures ?? []))
  if (failures.length > 0) {
    const error = new Error('no valid checkpoint document could be loaded')
    error.failures = failures
    throw error
  }
  return undefined
}

/** Read both copies of a task document for diagnostics/tests. */
export async function readCheckpointTexts(root, taskId) {
  const file = taskPath(root, taskId)
  const target = await readFile(file, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  const previous = await readFile(`${file}.previous`, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  return { file, target, previous }
}
