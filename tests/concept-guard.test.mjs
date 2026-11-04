import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCaptureBundle } from '../src/memory-curation/capture.js'
import { createEmptyMemoryDocument } from '../src/memory-curation/schema.js'
import {
  addConceptRelation,
  createConceptNode,
  integrateCapture,
} from '../src/memory-curation/merge-policy.js'
import { checkExplanationGuard } from '../src/concept-guard/prerequisite-check.js'
import { planConceptExplanation } from '../src/concept-guard/explanation-order.js'
import { reopenConceptsForDoubt, transitionConcept } from '../src/concept-guard/state-transition.js'

function capture(document, text, seq = 1) {
  const bundle = buildCaptureBundle({
    text,
    sourceKind: 'USER_EXPLICIT',
    sessionId: 'guard-test-session',
    seq,
  })
  return integrateCapture(document, bundle, { now: seq })
}

test('A: partial derivative explanation cannot use unexplained chain rule as a premise', () => {
  const document = createEmptyMemoryDocument('guard-test')
  capture(document, '请解释偏导数，并解释链式法则。')
  const partial = document.concepts.find(concept => concept.name === '偏导数')
  const chain = document.concepts.find(concept => concept.name === '链式法则')
  assert.ok(partial)
  assert.ok(chain)
  assert.equal(partial.prerequisiteIds.length, 0)
  assert.equal(chain.prerequisiteIds.length, 0)

  const result = checkExplanationGuard(document, {
    targetConceptId: partial.id,
    plannedText: '偏导数描述固定其他变量后某一方向的变化率；由链式法则可以直接得到这个结论。',
  })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'undeclared-concept-use')
  assert.ok(result.undeclaredConceptIds.includes(chain.id))

  const blockedTransition = transitionConcept(document, partial.id, 'INTRODUCED', {
    plannedText: '由链式法则可以直接得到偏导数。',
  })
  assert.equal(blockedTransition.ok, false)
  assert.equal(blockedTransition.error, 'concept-guard-blocked')
  assert.equal(partial.status, 'QUEUED')
})

test('B: a concept with multiple prerequisites produces a complete prerequisite order', () => {
  const document = createEmptyMemoryDocument('guard-test')
  capture(document, '请解释全微分，理解全微分需要先掌握偏导数和多元函数。')
  const target = document.concepts.find(concept => concept.name === '全微分')
  const partial = document.concepts.find(concept => concept.name === '偏导数')
  const multivariate = document.concepts.find(concept => concept.name === '多元函数')
  assert.ok(target && partial && multivariate)
  assert.deepEqual(new Set(target.prerequisiteIds), new Set([partial.id, multivariate.id]))

  const plan = planConceptExplanation(document, [target.id])
  assert.equal(plan.ok, true)
  assert.deepEqual(
    new Set(plan.separatePrerequisiteNoteIds),
    new Set([partial.id, multivariate.id]),
  )
  assert.equal(plan.order.at(-1).conceptId, target.id)
  assert.equal(plan.prerequisiteSections.every(item => item.isSeparateSection), true)

  const blocked = transitionConcept(document, target.id, 'INTRODUCED', {
    usedConceptIds: [partial.id, multivariate.id],
    plannedText: '使用偏导数和多元函数说明全微分。',
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.guard.reason, 'needs-prerequisite')

  for (const prerequisite of [partial, multivariate]) {
    assert.equal(transitionConcept(document, prerequisite.id, 'INTRODUCED', {
      plannedText: `${prerequisite.name}的基础定义。`,
    }).ok, true)
    assert.equal(transitionConcept(document, prerequisite.id, 'EXPLAINED', {
      plannedText: `${prerequisite.name}的基础定义已经说明。`,
    }).ok, true)
  }
  const allowed = transitionConcept(document, target.id, 'INTRODUCED', {
    usedConceptIds: [partial.id, multivariate.id],
    plannedText: '使用偏导数和多元函数说明全微分。',
  })
  assert.equal(allowed.ok, true)
  assert.equal(target.status, 'INTRODUCED')
})

test('C: user order is preserved unless a real prerequisite moves one concept, with a separate note marker', () => {
  const document = createEmptyMemoryDocument('guard-test')
  const fullDifferential = createConceptNode(document, {
    name: '全微分',
    layer: 'L1',
    priority: 'HIGH',
    confidence: 'EXPLICIT',
    status: 'QUEUED',
    userOrder: 1,
  })
  const chainRule = createConceptNode(document, {
    name: '链式法则',
    layer: 'L1',
    priority: 'HIGH',
    confidence: 'EXPLICIT',
    status: 'QUEUED',
    userOrder: 2,
  })
  const partial = createConceptNode(document, {
    name: '偏导数',
    layer: 'L2',
    priority: 'HIGH',
    confidence: 'EXPLICIT',
    status: 'QUEUED',
    userOrder: 3,
  })
  assert.ok(fullDifferential && chainRule && partial)
  const relation = addConceptRelation(document, {
    type: 'PREREQUISITE_OF',
    fromConceptId: partial.id,
    toConceptId: fullDifferential.id,
    confidence: 'EXPLICIT',
    source: { kind: 'USER_EXPLICIT' },
  })
  assert.equal(relation.accepted, true)

  const plan = planConceptExplanation(document, [fullDifferential.id, chainRule.id, partial.id])
  assert.equal(plan.ok, true)
  const order = plan.order.map(item => item.name)
  assert.ok(order.indexOf('偏导数') < order.indexOf('全微分'))
  // The prerequisite target is deliberately moved ahead; the moved node is
  // marked as a separate prerequisite note rather than silently reordered.
  assert.equal(plan.userOrderPreserved, false)
  assert.equal(plan.userOrderAdjusted, true)
  assert.deepEqual(plan.userOrderAfter, [3, 1, 2])
  assert.ok(plan.targetPrerequisiteIds.includes(partial.id))
  assert.ok(plan.prerequisiteSections.some(item => (
    item.conceptId === partial.id
    && item.isSeparateSection
    && item.alsoRequestedTarget
  )))
})

test('F2: a new user doubt reopens VERIFIED instead of treating mastery as permanent', () => {
  const document = createEmptyMemoryDocument('guard-test')
  const concept = createConceptNode(document, {
    name: '偏导数',
    layer: 'L1',
    priority: 'HIGH',
    confidence: 'EXPLICIT',
    status: 'VERIFIED',
  })
  assert.ok(concept)
  const result = reopenConceptsForDoubt(document, '我还是不太理解偏导数，请再解释一遍。')
  assert.deepEqual(result.reopened, [concept.id])
  assert.equal(concept.status, 'QUEUED')
  assert.equal(concept.statusHistory.at(-1).from, 'VERIFIED')
})

test('F: model inference cannot mark a concept VERIFIED', () => {
  const document = createEmptyMemoryDocument('guard-test')
  const concept = createConceptNode(document, {
    name: '极限',
    layer: 'L1',
    priority: 'HIGH',
    confidence: 'INFERRED',
    status: 'EXPLAINED',
  })
  assert.ok(concept)
  const rejected = transitionConcept(document, concept.id, 'VERIFIED', {
    evidence: { kind: 'USER_CONFIRMATION', sourceKind: 'MODEL_INFERRED' },
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, 'explicit-user-evidence-required')
  assert.equal(concept.status, 'EXPLAINED')

  const accepted = transitionConcept(document, concept.id, 'VERIFIED', {
    evidence: { kind: 'USER_CONFIRMATION', sourceKind: 'USER_EXPLICIT', note: '我会了' },
  })
  assert.equal(accepted.ok, true)
  assert.equal(concept.status, 'VERIFIED')
})

test('G: a prerequisite cycle is detected and no false topological order is returned', () => {
  const document = createEmptyMemoryDocument('guard-test')
  const a = createConceptNode(document, { name: '概念A', layer: 'L1', status: 'QUEUED' })
  const b = createConceptNode(document, { name: '概念B', layer: 'L2', status: 'QUEUED' })
  assert.ok(a && b)
  assert.equal(addConceptRelation(document, {
    type: 'PREREQUISITE_OF',
    fromConceptId: a.id,
    toConceptId: b.id,
    confidence: 'EXPLICIT',
    source: { kind: 'USER_EXPLICIT' },
  }).accepted, true)
  const forced = addConceptRelation(document, {
    type: 'PREREQUISITE_OF',
    fromConceptId: b.id,
    toConceptId: a.id,
    confidence: 'EXPLICIT',
    source: { kind: 'USER_EXPLICIT' },
  }, { allowCycleDiagnostic: true })
  assert.equal(forced.accepted, true)
  assert.equal(forced.relation.uncertain, true)

  const plan = planConceptExplanation(document, [a.id])
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'cycle')
  assert.deepEqual(plan.order, [])
  assert.ok(plan.cycles.length >= 1)
})
