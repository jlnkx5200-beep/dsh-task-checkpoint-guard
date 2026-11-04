/**
 * Hard prerequisite checks for concept explanations.
 *
 * The guard accepts explicit concept ids and (when available) the visible draft
 * text. It never calls a model and never treats a concept mentioned in history
 * as understood.
 */
import {
  prerequisitesFor,
} from '../memory-curation/dependency-graph.js'
import { normalizeConceptName } from '../memory-curation/schema.js'

const SATISFIED = new Set(['EXPLAINED', 'VERIFIED'])

function conceptById(document, id) {
  return document.concepts.find(concept => concept.id === id)
}

function conceptByName(document, value) {
  const normalized = normalizeConceptName(value)
  return document.concepts.find(concept => (
    normalizeConceptName(concept.name) === normalized
    || (concept.aliases ?? []).some(alias => normalizeConceptName(alias) === normalized)
  ))
}

function transitivePrerequisites(document, targetId) {
  const result = []
  const seen = new Set()
  const stack = [...prerequisitesFor(targetId, document.relations)]
  while (stack.length > 0) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const concept = conceptById(document, id)
    if (concept === undefined) {
      result.push({ id, concept: undefined })
      continue
    }
    result.push({ id, concept })
    stack.push(...prerequisitesFor(id, document.relations))
  }
  return result
}

export function checkPrerequisites(document, targetConceptId) {
  const target = conceptById(document, targetConceptId)
  if (target === undefined) {
    return {
      ok: false,
      reason: 'unknown-concept',
      targetConceptId,
      target: undefined,
      blocking: [],
      satisfied: [],
    }
  }
  const blocking = []
  const satisfied = []
  for (const item of transitivePrerequisites(document, targetConceptId)) {
    if (item.concept === undefined) {
      blocking.push({
        conceptId: item.id,
        name: '(missing prerequisite)',
        reason: 'missing-prerequisite-node',
      })
    } else if (SATISFIED.has(item.concept.status)) {
      satisfied.push(item.concept)
    } else {
      blocking.push({
        conceptId: item.concept.id,
        name: item.concept.name,
        status: item.concept.status,
        reason: 'prerequisite-not-explained',
      })
    }
  }
  return {
    ok: blocking.length === 0,
    reason: blocking.length === 0 ? 'ready' : 'needs-prerequisite',
    targetConceptId,
    target,
    blocking,
    satisfied,
  }
}

function mentionedConcepts(document, text) {
  const normalizedText = String(text ?? '').normalize('NFKC').toLowerCase()
  if (normalizedText.length === 0) return []
  return document.concepts.filter(concept => {
    const names = [concept.name, ...(concept.aliases ?? [])]
    return names.some(name => {
      const normalizedName = String(name ?? '').normalize('NFKC').toLowerCase().trim()
      return normalizedName.length >= 2 && normalizedText.includes(normalizedName)
    })
  })
}

/**
 * Check whether one proposed explanation is allowed.
 *
 * @param {object} document memory document
 * @param {{
 *   targetConceptId: string,
 *   usedConceptIds?: string[],
 *   plannedText?: string,
 *   exemptConceptIds?: string[],
 *   explanationOrder?: number
 * }} input
 */
export function checkExplanationGuard(document, input = {}) {
  const target = conceptById(document, input.targetConceptId)
  if (target === undefined) {
    return {
      allowed: false,
      reason: 'unknown-concept',
      targetConceptId: input.targetConceptId,
      blockingPrerequisiteIds: [],
      satisfiedPrerequisiteIds: [],
      undeclaredConceptIds: [],
      violations: [{ kind: 'unknown-concept', id: input.targetConceptId }],
    }
  }
  const prerequisites = checkPrerequisites(document, target.id)
  const satisfiedIds = new Set(prerequisites.satisfied.map(concept => concept.id))
  const blockingIds = new Set(prerequisites.blocking.map(item => item.conceptId))
  const exempt = new Set(input.exemptConceptIds ?? [])
  const usedIds = new Set((input.usedConceptIds ?? []).filter(id => id !== target.id))
  const mentioned = mentionedConcepts(document, input.plannedText)
  const undeclared = new Map()

  const consider = (concept, origin) => {
    if (concept === undefined || concept.id === target.id) return
    if (exempt.has(concept.id)) return
    if (SATISFIED.has(concept.status)) return
    if (satisfiedIds.has(concept.id)) return
    const declaredBlocking = blockingIds.has(concept.id)
    if (declaredBlocking) return
    undeclared.set(concept.id, {
      conceptId: concept.id,
      name: concept.name,
      status: concept.status,
      origin,
      kind: 'undeclared-unready-concept',
    })
  }

  for (const id of usedIds) consider(conceptById(document, id), 'usedConceptIds')
  for (const concept of mentioned) consider(concept, 'plannedText')

  const violations = [
    ...prerequisites.blocking.map(item => ({
      kind: item.reason,
      conceptId: item.conceptId,
      name: item.name,
      status: item.status ?? null,
    })),
    ...undeclared.values(),
  ]
  const allowed = violations.length === 0
  const requiredActions = []
  if (prerequisites.blocking.length > 0) {
    requiredActions.push(
      `Explain the prerequisite(s) separately first: ${prerequisites.blocking.map(item => item.name).join(', ')}.`,
      'Do not mark the target EXPLAINED or VERIFIED until those prerequisite explanations are complete.',
    )
  }
  if (undeclared.size > 0) {
    requiredActions.push(
      `Do not use undeclared unready concept(s) as premises: ${[...undeclared.values()].map(item => item.name).join(', ')}.`,
      'Either explain each listed concept separately or rewrite the target explanation using only already explained concepts.',
    )
  }
  return {
    allowed,
    reason: allowed
      ? 'ready'
      : prerequisites.blocking.length > 0
        ? 'needs-prerequisite'
        : 'undeclared-concept-use',
    targetConceptId: target.id,
    targetName: target.name,
    blockingPrerequisiteIds: prerequisites.blocking.map(item => item.conceptId),
    satisfiedPrerequisiteIds: [...satisfiedIds],
    undeclaredConceptIds: [...undeclared.keys()],
    violations,
    requiredActions,
    explanationOrder: input.explanationOrder ?? null,
  }
}
