import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCaptureBundle } from '../src/memory-curation/capture.js'
import { createEmptyMemoryDocument } from '../src/memory-curation/schema.js'
import { integrateCapture } from '../src/memory-curation/merge-policy.js'
import { retrieveContext } from '../src/memory-curation/retrieval.js'
import { checkExplanationGuard } from '../src/concept-guard/prerequisite-check.js'
import { planConceptExplanation } from '../src/concept-guard/explanation-order.js'

function capture(document, text, seq = 1) {
  const bundle = buildCaptureBundle({
    text,
    sourceKind: 'USER_EXPLICIT',
    sessionId: 'semantic-fixture',
    seq,
  })
  return integrateCapture(document, bundle, { now: seq })
}

/**
 * These are deterministic semantic-regression fixtures. They verify what the
 * plugin would inject and which explanations the guard permits; they are not a
 * substitute for the opt-in real-model harness in scripts/.
 */
test('semantic fixture: derivative explanation separates a queued chain rule', () => {
  const document = createEmptyMemoryDocument('semantic-fixture')
  capture(document, '请解释偏导数，并解释链式法则。')
  const partial = document.concepts.find(concept => concept.name === '偏导数')
  const chain = document.concepts.find(concept => concept.name === '链式法则')
  assert.ok(partial && chain)
  const context = retrieveContext(document, {
    query: '请解释偏导数',
    maxChars: 2500,
    maxTokens: 700,
  })
  assert.match(context.text, /Explanation guard/)
  assert.match(context.text, /链式法则/)
  const guard = checkExplanationGuard(document, {
    targetConceptId: partial.id,
    plannedText: '根据链式法则，偏导数可以这样计算。',
  })
  assert.equal(guard.allowed, false)
  assert.ok(guard.undeclaredConceptIds.includes(chain.id))
})

test('semantic fixture: a high-level goal remains present when a temporary request arrives', () => {
  const document = createEmptyMemoryDocument('semantic-fixture')
  capture(document, '我的长期目标是系统理解高等数学理论体系，而不仅是题型技巧。')
  capture(document, '这道题直接给我一个计算技巧。', 2)
  const goal = document.records.find(record => record.layer === 'L0')
  assert.ok(goal)
  const context = retrieveContext(document, {
    query: '这道题怎么算',
    maxChars: 1200,
    maxTokens: 350,
  })
  assert.ok(context.selected.some(record => record.id === goal.id))
  assert.match(context.text, /系统理解高等数学理论体系/)
})

test('semantic fixture: multivariate chain-rule lesson orders prerequisites before the target', () => {
  const document = createEmptyMemoryDocument('semantic-fixture')
  capture(document, '请解释多元复合函数的求导，理解它需要先掌握一元函数求导和多元函数。')
  const target = document.concepts.find(concept => concept.name === '多元复合函数的求导')
    ?? document.concepts.find(concept => /多元复合函数/.test(concept.name))
  assert.ok(target, JSON.stringify(document.concepts.map(concept => concept.name)))
  const plan = planConceptExplanation(document, [target.id])
  assert.equal(plan.ok, true)
  assert.equal(plan.order.at(-1).conceptId, target.id)
  assert.ok(plan.separatePrerequisiteNoteIds.length >= 1)
  assert.ok(plan.order.slice(0, -1).every(item => (
    item.layer === 'L2' || item.roles.includes('prerequisite')
  )))
})

test('semantic fixture: irrelevant same-keyword detail stays out of the automatic context', () => {
  const document = createEmptyMemoryDocument('semantic-fixture')
  capture(document, '请解释全微分，理解全微分需要先掌握偏导数。')
  const bundle = buildCaptureBundle({
    sourceKind: 'USER_EXPLICIT',
    sessionId: 'semantic-fixture',
    seq: 2,
    items: [{
      content: '全微分也是一个饮料品牌的关键词测试句。',
      topic: '饮料广告',
      layer: 'L3',
      priority: 'LOW',
      intent: 'detail',
      relatedConcepts: [],
    }],
  })
  integrateCapture(document, bundle, { now: 2 })
  const unrelated = document.records.find(record => record.topic === '饮料广告')
  assert.ok(unrelated)
  const context = retrieveContext(document, {
    query: '全微分怎么计算',
    maxChars: 1400,
    maxTokens: 420,
  })
  assert.equal(context.selected.some(record => record.id === unrelated.id), false)
  assert.ok(context.omitted.includes(unrelated.id))
})
