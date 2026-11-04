import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { MemoryStore } from '../src/memory-curation/store.js'
import { createConceptNode, integrateCapture } from '../src/memory-curation/merge-policy.js'
import { buildCaptureBundle } from '../src/memory-curation/capture.js'
import { makeTempRoot, removeTempRoot } from './helpers.mjs'

test('J: concurrent stores merge writes atomically and a fresh store recovers them after restart', async () => {
  const root = await makeTempRoot('dsh-memory-concurrency-')
  try {
    const first = new MemoryStore({ root, scopeId: 'concurrent-user' })
    const second = new MemoryStore({ root, scopeId: 'concurrent-user' })
    const updates = [
      first.update(document => {
        createConceptNode(document, {
          name: '偏导数',
          layer: 'L1',
          status: 'QUEUED',
          confidence: 'EXPLICIT',
        })
        return { result: 'partial' }
      }),
      second.update(document => {
        createConceptNode(document, {
          name: '链式法则',
          layer: 'L1',
          status: 'QUEUED',
          confidence: 'EXPLICIT',
        })
        return { result: 'chain' }
      }),
      first.update(document => {
        createConceptNode(document, {
          name: '全微分',
          layer: 'L1',
          status: 'QUEUED',
          confidence: 'EXPLICIT',
        })
        return { result: 'full' }
      }),
    ]
    const results = await Promise.all(updates)
    assert.deepEqual(results.map(item => item.result).sort(), ['chain', 'full', 'partial'])

    const restarted = new MemoryStore({ root, scopeId: 'concurrent-user' })
    const loaded = await restarted.read()
    assert.equal(loaded.existed, true)
    assert.deepEqual(
      loaded.document.concepts.map(concept => concept.name).sort(),
      ['偏导数', '全微分', '链式法则'].sort(),
    )
    assert.ok(loaded.document.revision >= 3)

    const primary = await readFile(restarted.file, 'utf8')
    const previous = await readFile(`${restarted.file}.previous`, 'utf8')
    assert.doesNotThrow(() => JSON.parse(primary))
    assert.doesNotThrow(() => JSON.parse(previous))
  } finally {
    await removeTempRoot(root)
  }
})

test('memory persistence redacts credential-shaped text before writing', async () => {
  const root = await makeTempRoot('dsh-memory-privacy-')
  const secret = 'sk-1234567890abcdefghij'
  try {
    const store = new MemoryStore({ root, scopeId: 'privacy-user' })
    await store.update(document => {
      const bundle = buildCaptureBundle({
        text: `请解释偏导数。临时密钥是 ${secret}`,
        sourceKind: 'USER_EXPLICIT',
        sessionId: 'privacy-user',
        seq: 1,
      })
      integrateCapture(document, bundle, { now: 1 })
      return { result: 1 }
    })
    const text = await readFile(store.file, 'utf8')
    assert.doesNotMatch(text, new RegExp(secret))
    assert.match(text, /<redacted-api-key>/)
  } finally {
    await removeTempRoot(root)
  }
})

test('a corrupt primary memory document falls back to the valid previous copy', async () => {
  const root = await makeTempRoot('dsh-memory-recovery-')
  try {
    const store = new MemoryStore({ root, scopeId: 'recover-user' })
    await store.update(document => {
      createConceptNode(document, { name: '极限', layer: 'L1', status: 'QUEUED' })
      return { result: 1 }
    })
    await store.update(document => {
      createConceptNode(document, { name: '连续', layer: 'L1', status: 'QUEUED' })
      return { result: 2 }
    })
    await writeFile(store.file, '{ corrupted', 'utf8')

    const restarted = new MemoryStore({ root, scopeId: 'recover-user' })
    const loaded = await restarted.read()
    assert.equal(loaded.fromPrevious, true)
    assert.deepEqual(loaded.document.concepts.map(concept => concept.name), ['极限'])
  } finally {
    await removeTempRoot(root)
  }
})
