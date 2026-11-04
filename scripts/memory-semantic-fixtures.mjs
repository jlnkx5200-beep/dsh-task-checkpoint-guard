/**
 * Reproducible fixtures for the opt-in real-model semantic pilot.
 *
 * The deterministic test suite checks the guard and injected context. This file
 * supplies the same cases to a public OpenAI-compatible chat endpoint so a
 * maintainer can record actual model outputs without putting a model call on
 * every session event.
 */
import { buildCaptureBundle } from '../src/memory-curation/capture.js'
import { createEmptyMemoryDocument } from '../src/memory-curation/schema.js'
import { integrateCapture } from '../src/memory-curation/merge-policy.js'
import { retrieveContext } from '../src/memory-curation/retrieval.js'

export const SEMANTIC_CASES = Object.freeze([
  {
    id: 'partial-derivative-isolation',
    prompt: '请解释偏导数的概念与几何意义。只回答偏导数，不要展开链式法则。',
    capture: '请解释偏导数，并解释链式法则。',
    query: '偏导数',
    rubric: 'Do not use 链式法则 as an unexplained premise or claim the user already knows it.',
  },
  {
    id: 'multiple-prerequisites-order',
    prompt: '请解释多元复合函数的求导。',
    capture: '请解释多元复合函数的求导，理解它需要先掌握一元函数求导和多元函数。',
    query: '多元复合函数的求导',
    rubric: 'Identify 一元函数求导 and 多元函数 as prerequisites and place separate prerequisite explanations before the target.',
  },
  {
    id: 'goal-over-temporary',
    prompt: '这道题直接给我一个计算技巧。',
    capture: [
      '我的长期目标是系统理解高等数学理论体系，而不仅是题型技巧。',
      '这道题直接给我一个计算技巧。',
    ],
    query: '这道题怎么算',
    rubric: 'Retain the long-term theory goal while still respecting the current request for a technique.',
  },
  {
    id: 'unexplained-prerequisite',
    prompt: '请解释全微分。',
    capture: '请解释全微分，理解全微分需要先掌握偏导数。',
    query: '全微分',
    rubric: 'Do not treat 偏导数 as already mastered; explicitly separate the prerequisite explanation from the formal target chapter.',
  },
])

export function buildCase(caseDefinition) {
  const document = createEmptyMemoryDocument('semantic-eval')
  const messages = Array.isArray(caseDefinition.capture)
    ? caseDefinition.capture
    : [caseDefinition.capture]
  for (let index = 0; index < messages.length; index++) {
    const bundle = buildCaptureBundle({
      text: messages[index],
      sourceKind: 'USER_EXPLICIT',
      sessionId: 'semantic-eval',
      seq: index + 1,
    })
    integrateCapture(document, bundle, { now: index + 1, maxMemoryRecords: 500 })
  }
  const target = document.concepts.find(concept => (
    caseDefinition.query.includes(concept.name)
    || concept.name.includes(caseDefinition.query)
  ))
  const context = retrieveContext(document, {
    query: caseDefinition.query,
    conceptIds: target === undefined ? [] : [target.id],
    maxChars: 3000,
    maxTokens: 800,
  })
  return {
    document,
    targetConcept: target ?? null,
    context: context.text,
  }
}

export function buildSemanticFixtures() {
  return SEMANTIC_CASES.map(caseDefinition => ({
    ...caseDefinition,
    ...buildCase(caseDefinition),
  }))
}
