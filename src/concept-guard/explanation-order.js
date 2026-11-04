/**
 * Explanation-order facade over dependency-graph.js.
 *
 * User order is the default tie-break. A concept is moved only when a real
 * prerequisite edge requires it, and every moved prerequisite is marked as a
 * separate prerequisite note rather than a completed requested chapter.
 */
import {
  planExplanationOrder,
} from '../memory-curation/dependency-graph.js'

export function planConceptExplanation(document, targetIds, options = {}) {
  const plan = planExplanationOrder(
    document.concepts,
    document.relations,
    targetIds,
    options,
  )
  if (!plan.ok) {
    return {
      ...plan,
      userOrderPreserved: false,
      prerequisiteSections: [],
    }
  }
  return {
    ...plan,
    userOrderPreserved: plan.userOrderAdjusted === false,
    prerequisiteSections: [
      ...plan.separatePrerequisiteNoteIds.map(id => ({ id, alsoRequestedTarget: false })),
      ...(plan.targetPrerequisiteIds ?? []).map(id => ({ id, alsoRequestedTarget: true })),
    ].map(({ id, alsoRequestedTarget }) => {
      const concept = document.concepts.find(item => item.id === id)
      return {
        conceptId: id,
        name: concept?.name ?? '(missing)',
        reason: 'prerequisite-before-target',
        isSeparateSection: true,
        alsoRequestedTarget,
        notACompleteRequestedChapter: options.preserveUserOrder !== false,
      }
    }),
  }
}

/** Persist the computed order only when the graph has no cycle/missing node. */
export function applyConceptExplanationOrder(document, targetIds, options = {}) {
  const plan = planConceptExplanation(document, targetIds, options)
  if (!plan.ok) return plan
  for (const item of plan.order) {
    const concept = document.concepts.find(conceptItem => conceptItem.id === item.conceptId)
    if (concept !== undefined) concept.explanationOrder = item.explanationOrder
  }
  return plan
}

/**
 * Return the first concept that can be introduced now. Prerequisites must be
 * EXPLAINED/VERIFIED and the concept must not already be complete.
 */
export function nextReadyConcept(document, targetIds) {
  const plan = planConceptExplanation(document, targetIds)
  if (!plan.ok) return { ok: false, reason: plan.reason, plan }
  for (const item of plan.order) {
    const concept = document.concepts.find(candidate => candidate.id === item.conceptId)
    if (concept === undefined) continue
    if (['EXPLAINED', 'VERIFIED'].includes(concept.status)) continue
    const prerequisites = (concept.prerequisiteIds ?? []).map(id => (
      document.concepts.find(candidate => candidate.id === id)
    ))
    const ready = prerequisites.every(prerequisite => (
      prerequisite !== undefined && ['EXPLAINED', 'VERIFIED'].includes(prerequisite.status)
    ))
    if (ready) return { ok: true, concept, plan }
  }
  return { ok: false, reason: 'all-explained', plan }
}
