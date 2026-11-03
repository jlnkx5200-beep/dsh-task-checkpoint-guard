import assert from 'node:assert/strict'
import { readFile, stat, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  atomicWriteText,
  loadCheckpoint,
  persistCheckpoint,
  readCheckpointTexts,
} from '../src/storage.js'
import { createTaskState, safeFileId } from '../src/state.js'
import { makeSession, makeTempRoot, readJson, removeTempRoot, waitFor } from './helpers.mjs'

function stateFor(session, status = 'RUNNING') {
  const state = createTaskState(session)
  state.status = status
  state.phase = status
  state.originalInstruction = 'Persist a durable checkpoint.'
  state.lastEventSeq = 2
  state.lastCheckpoint = { seq: 2, time: Date.now(), eventType: 'tool/result' }
  state.tools = [{
    callId: 'call-1',
    name: 'shell',
    argumentsPreview: '{"cmd":"echo ok"}',
    argumentsHash: 'sha256:test',
    turn: 1,
    step: 1,
    status: 'completed',
    result: 'ok',
  }]
  return state
}

test('checkpoint write/read round trip stores the task and a relative pointer', async () => {
  const root = await makeTempRoot()
  try {
    const session = makeSession('roundtrip-session')
    const state = stateFor(session)
    const paths = await persistCheckpoint(root, state)
    const loaded = await loadCheckpoint(root, session)
    assert.ok(loaded)
    assert.equal(loaded.state.sessionId, 'roundtrip-session')
    assert.equal(loaded.state.originalInstruction, 'Persist a durable checkpoint.')
    assert.equal(loaded.state.tools[0].result, 'ok')
    const pointer = await readJson(paths.sessionPointer)
    assert.equal(pointer.sessionId, 'roundtrip-session')
    assert.equal(pointer.taskId, state.taskId)
    assert.match(pointer.taskFile, /^tasks\//)
    assert.doesNotMatch(JSON.stringify(pointer), /[A-Za-z]:\\|^\//)
  } finally {
    await removeTempRoot(root)
  }
})

test('the previous valid checkpoint copy survives a corrupt target', async () => {
  const root = await makeTempRoot()
  try {
    const session = makeSession('previous-session')
    const first = stateFor(session, 'RUNNING')
    first.originalInstruction = 'first version'
    await persistCheckpoint(root, first)

    const second = stateFor(session, 'INTERRUPTED')
    second.originalInstruction = 'second version'
    await persistCheckpoint(root, second)

    const fileName = `${safeFileId(second.taskId)}.json`
    const taskFile = path.join(root, 'tasks', fileName)
    const texts = await readCheckpointTexts(root, second.taskId)
    assert.match(texts.target, /second version/)
    assert.match(texts.previous, /first version/)

    await writeFile(taskFile, '{not-json', 'utf8')
    const loaded = await loadCheckpoint(root, session)
    assert.ok(loaded)
    assert.equal(loaded.fromPrevious, true)
    assert.equal(loaded.state.originalInstruction, 'first version')
  } finally {
    await removeTempRoot(root)
  }
})

test('session pointer previous copy is used when the primary pointer is corrupt', async () => {
  const root = await makeTempRoot()
  try {
    const session = makeSession('pointer-session')
    const first = stateFor(session)
    first.originalInstruction = 'pointer first'
    const paths = await persistCheckpoint(root, first)
    const second = stateFor(session, 'CHECKPOINTED')
    second.originalInstruction = 'pointer second'
    await persistCheckpoint(root, second)

    await writeFile(paths.sessionPointer, '{"broken":', 'utf8')
    await writeFile(paths.taskJson, '{broken-task-json', 'utf8')
    const loaded = await loadCheckpoint(root, session)
    assert.ok(loaded)
    assert.equal(loaded.via, 'pointer')
    assert.equal(loaded.fromPrevious, true)
    assert.equal(loaded.state.originalInstruction, 'pointer first')
  } finally {
    await removeTempRoot(root)
  }
})

test('task-file scan recovers the latest checkpoint when the pointer is missing', async () => {
  const root = await makeTempRoot()
  try {
    const session = makeSession('scan-session')
    const first = stateFor(session)
    first.originalInstruction = 'scan first'
    first.updatedAt = 10
    const firstPaths = await persistCheckpoint(root, first)

    const second = stateFor(session, 'CHECKPOINTED')
    second.originalInstruction = 'scan second'
    second.updatedAt = 20
    await persistCheckpoint(root, second)

    await rm(firstPaths.sessionPointer, { force: true })
    await rm(`${firstPaths.sessionPointer}.previous`, { force: true })
    const loaded = await loadCheckpoint(root, session)
    assert.ok(loaded)
    assert.equal(loaded.via, 'scan')
    assert.equal(loaded.state.originalInstruction, 'scan second')
  } finally {
    await removeTempRoot(root)
  }
})

test('concurrent writers leave a valid current document and valid previous copy', async () => {
  const root = await makeTempRoot()
  try {
    const session = makeSession('concurrent-session')
    const states = Array.from({ length: 24 }, (_, index) => {
      const state = stateFor(session, index % 2 === 0 ? 'RUNNING' : 'CHECKPOINTED')
      state.originalInstruction = `concurrent ${index}`
      state.updatedAt = 1_700_000_000_000 + index
      return state
    })
    await Promise.all(states.map(state => persistCheckpoint(root, state)))

    const taskId = states[0].taskId
    const taskFile = path.join(root, 'tasks', `${safeFileId(taskId)}.json`)
    await waitFor(async () => {
      const text = await readFile(taskFile, 'utf8')
      JSON.parse(text)
      return true
    })
    const current = JSON.parse(await readFile(taskFile, 'utf8'))
    const previous = JSON.parse(await readFile(`${taskFile}.previous`, 'utf8'))
    assert.match(current.originalInstruction, /^concurrent \d+$/)
    assert.match(previous.originalInstruction, /^concurrent \d+$/)
    assert.equal(current.sessionId, 'concurrent-session')
    assert.equal(previous.sessionId, 'concurrent-session')

    const loaded = await loadCheckpoint(root, session)
    assert.ok(loaded)
    assert.equal(loaded.state.sessionId, 'concurrent-session')
  } finally {
    await removeTempRoot(root)
  }
})

test('atomicWriteText keeps a complete previous file and enforces absolute paths', async () => {
  const root = await makeTempRoot()
  try {
    const target = path.join(root, 'nested', 'value.txt')
    await assert.rejects(() => atomicWriteText('relative.txt', 'x'), /absolute/)
    await atomicWriteText(target, 'one')
    await atomicWriteText(target, 'two')
    assert.equal(await readFile(target, 'utf8'), 'two')
    assert.equal(await readFile(`${target}.previous`, 'utf8'), 'one')
    if (process.platform !== 'win32') {
      assert.equal((await stat(target)).mode & 0o777, 0o600)
    }
  } finally {
    await removeTempRoot(root)
  }
})
