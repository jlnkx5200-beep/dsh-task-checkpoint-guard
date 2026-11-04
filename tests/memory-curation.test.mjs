import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCaptureBundle } from '../src/memory-curation/capture.js'
import { createEmptyMemoryDocument } from '../src/memory-curation/schema.js'
import {
  deleteMemoryEntity,
  integrateCapture,
  updateMemoryRecord,
} from '../src/memory-curation/merge-policy.js'
import { retrieveContext, searchMemory } from '../src/memory-curation/retrieval.js'

function capture(document, text, seq, options = {}) {
  const bundle = buildCaptureBundle({
    text,
    sourceKind: 'USER_EXPLICIT',
    sessionId: 'memory-test-session',
    seq,
    ...options,
  })
  return { bundle, result: integrateCapture(document, bundle, { now: seq, ...options }) }
}

test('D: a temporary L3 request cannot overwrite a long-term L0 learning goal', () => {
  const document = createEmptyMemoryDocument('curation-test')
  capture(document, '我学习数学时更注重理论推导，希望深入理解高等数学的理论体系。', 1)
  const l0 = document.records.find(record => record.layer === 'L0')
  assert.ok(l0)
  assert.equal(l0.content, '我学习数学时更注重理论推导，希望深入理解高等数学的理论体系。')
  const l0Version = l0.version

  capture(document, '这道题直接给我一个计算技巧。', 2)
  const l3 = document.records.find(record => record.layer === 'L3')
  assert.ok(l3)
  assert.equal(l3.intent, 'temporary_request')
  assert.equal(l0.content, '我学习数学时更注重理论推导，希望深入理解高等数学的理论体系。')
  assert.equal(l0.version, l0Version)
  assert.equal(document.records.filter(record => record.layer === 'L0').length, 1)
})

test('E: an explicit user correction updates content and retains history', () => {
  const document = createEmptyMemoryDocument('curation-test')
  capture(document, '我学习数学时更注重理论推导。', 1)
  const original = document.records.find(record => record.layer === 'L0')
  assert.ok(original)

  const { result } = capture(document, '更正：我学习数学时更注重严格证明和形式化推导。', 2)
  assert.equal(result.actions[0].action, 'CORRECTION')
  const corrected = document.records.find(record => record.id === original.id)
  assert.match(corrected.content, /严格证明/)
  assert.equal(corrected.layer, 'L0')
  assert.equal(corrected.version, 2)
  assert.equal(corrected.history.length, 1)
  assert.match(corrected.history[0].content, /理论推导/)
})

test('model inference cannot silently correct an explicit user goal', () => {
  const document = createEmptyMemoryDocument('inference-test')
  capture(document, '我学习数学时更注重理论推导，希望深入理解理论体系。', 1)
  const original = document.records.find(record => record.layer === 'L0')
  assert.ok(original)

  const bundle = buildCaptureBundle({
    sourceKind: 'MODEL_INFERRED',
    sessionId: 'inference-test',
    seq: 2,
    items: [{
      content: '我学习数学时只想刷题。',
      topic: '学习偏好',
      layer: 'L3',
      confidence: 'EXPLICIT',
      intent: 'correction',
    }],
  })
  const result = integrateCapture(document, bundle, { now: 2 })
  const unchanged = document.records.find(record => record.id === original.id)
  assert.match(unchanged.content, /理论推导/)
  assert.equal(unchanged.version, 1)
  assert.notEqual(result.actions[0].action, 'CORRECTION')
  assert.ok(document.audit.some(entry => entry.action === 'inferred-correction-blocked'))
})

test('same-layer contradictory user statements create a conflict instead of an overwrite', () => {
  const document = createEmptyMemoryDocument('conflict-test')
  let bundle = buildCaptureBundle({
    items: [{
      content: '学习应以例题为主。',
      topic: '学习方式',
      layer: 'L1',
      priority: 'HIGH',
      intent: 'statement',
      relatedConcepts: ['数学学习'],
    }],
    sourceKind: 'USER_EXPLICIT',
    sessionId: 'conflict-test',
    seq: 1,
  })
  integrateCapture(document, bundle, { now: 1 })
  const original = document.records.find(record => record.id)
  assert.ok(original)

  bundle = buildCaptureBundle({
    items: [{
      content: '学习不应以例题为主。',
      topic: '学习方式',
      layer: 'L1',
      priority: 'HIGH',
      intent: 'statement',
      relatedConcepts: ['数学学习'],
    }],
    sourceKind: 'USER_EXPLICIT',
    sessionId: 'conflict-test',
    seq: 2,
  })
  const result = integrateCapture(document, bundle, { now: 2 })
  assert.equal(result.actions[0].action, 'CONFLICT')
  assert.equal(document.conflicts.length, 1)
  assert.equal(document.records.length, 2)
  assert.ok(document.records.some(record => record.content === '学习应以例题为主。'))
  assert.ok(document.records.some(record => record.content === '学习不应以例题为主。'))
})

test('H: capacity pressure compresses/evicts L3 but preserves L0, L1, and prerequisite records', () => {
  const document = createEmptyMemoryDocument('capacity-test')
  capture(document, '我的长期目标是系统学习高等数学理论体系。', 1)
  capture(document, '请解释全微分，理解全微分需要先掌握偏导数。', 2)
  const protectedBefore = document.records.filter(record => ['L0', 'L1'].includes(record.layer))
  const prerequisiteIds = document.concepts
    .filter(concept => concept.layer === 'L2')
    .map(concept => concept.id)
  assert.ok(protectedBefore.length >= 2)
  assert.ok(prerequisiteIds.length >= 1)

  const items = Array.from({ length: 40 }, (_, index) => ({
    content: `补充案例 ${index}: 这是一个低优先级重复细节，用于验证容量压缩。`,
    topic: `重复案例 ${index}`,
    layer: 'L3',
    priority: 'LOW',
    intent: 'detail',
    relatedConcepts: [],
  }))
  const bundle = buildCaptureBundle({
    items,
    sourceKind: 'USER_EXPLICIT',
    sessionId: 'capacity-test',
    seq: 3,
  })
  integrateCapture(document, bundle, {
    now: 3,
    maxMemoryRecords: 12,
    maxMemoryConcepts: 10,
  })

  assert.ok(document.records.length <= 12, `expected bounded records, got ${document.records.length}`)
  for (const record of protectedBefore) {
    assert.ok(document.records.some(item => item.id === record.id), `protected record ${record.id} was evicted`)
  }
  assert.ok(document.capacity.compressions > 0)
  assert.ok(document.audit.some(entry => entry.action === 'capacity-evicted'))
})

test('I: layered retrieval prioritizes L0/L1/L2 and rejects unrelated same-keyword L3', () => {
  const document = createEmptyMemoryDocument('retrieval-test')
  capture(document, '我的长期目标是深入理解高等数学理论体系。', 1)
  capture(document, '请解释全微分，理解全微分需要先掌握偏导数。', 2)
  const target = document.concepts.find(concept => concept.name === '全微分')
  assert.ok(target)
  const relatedBundle = buildCaptureBundle({
    items: [{
      content: '全微分的计算例题：先计算偏导数，再组合微分。',
      topic: '全微分例题',
      layer: 'L3',
      priority: 'NORMAL',
      intent: 'detail',
      relatedConcepts: ['全微分'],
    }, {
      content: '全微分关键词碰巧也出现在一段无关的饮料广告里。',
      topic: '饮料广告',
      layer: 'L3',
      priority: 'LOW',
      intent: 'detail',
      relatedConcepts: [],
    }],
    sourceKind: 'USER_EXPLICIT',
    sessionId: 'retrieval-test',
    seq: 3,
  })
  integrateCapture(document, relatedBundle, { now: 3, maxMemoryRecords: 100 })
  const unrelated = document.records.find(record => record.topic === '饮料广告')
  assert.ok(unrelated)

  const context = retrieveContext(document, {
    query: '全微分怎么计算',
    maxChars: 1300,
    maxTokens: 400,
  })
  assert.match(context.text, /L0 goals and constraints/)
  assert.match(context.text, /L1 core questions and concepts/)
  assert.match(context.text, /L2 prerequisite knowledge|Concept preparation state/)
  assert.ok(context.omitted.includes(unrelated.id))
  assert.ok(context.selected.some(record => record.layer === 'L0'))
  assert.ok(context.selected.some(record => record.layer === 'L1'))
  const selectedText = context.text
  assert.ok(selectedText.indexOf('L0 goals') < selectedText.indexOf('L1 core'))
  assert.ok(selectedText.indexOf('L1 core') < selectedText.indexOf('L2 prerequisite'))

  const explicit = searchMemory(document, '饮料广告', { layers: ['L3'] })
  assert.ok(explicit.records.some(record => record.id === unrelated.id))
})

test('K: correction, priority lowering, and deletion synchronize indexes', () => {
  const document = createEmptyMemoryDocument('delete-test')
  capture(document, '请解释全微分，理解全微分需要先掌握偏导数。', 1)
  capture(document, '请解释偏导数。', 2)
  const target = document.records.find(record => record.layer === 'L1')
  assert.ok(target)

  const lowered = updateMemoryRecord(document, target.id, {
    priority: 'LOW',
    expectedVersion: target.version,
    reason: 'user asked to lower this priority',
  }, { now: 3 })
  assert.equal(lowered.ok, true)
  assert.equal(target.priority, 'LOW')

  const prerequisite = document.concepts.find(concept => concept.name === '偏导数')
  const targetConcept = document.concepts.find(concept => concept.name === '全微分')
  assert.ok(prerequisite)
  assert.ok(targetConcept)
  assert.ok(document.relations.some(relation => (
    relation.fromConceptId === prerequisite.id && relation.toConceptId === targetConcept.id
  )))

  const deleted = deleteMemoryEntity(document, prerequisite.id, { now: 4 })
  assert.equal(deleted.ok, true)
  assert.equal(document.concepts.some(concept => concept.id === prerequisite.id), false)
  assert.equal(document.relations.some(relation => (
    relation.fromConceptId === prerequisite.id || relation.toConceptId === prerequisite.id
  )), false)
  assert.equal(document.records.some(record => (
    record.relatedConceptIds.includes(prerequisite.id)
    || record.dependencyConceptIds.includes(prerequisite.id)
  )), false)

  const recordDeleted = deleteMemoryEntity(document, target.id, { now: 5, cascade: true })
  assert.equal(recordDeleted.ok, true)
  assert.equal(document.records.some(record => record.id === target.id), false)
})
