/**
 * Layer semantics and protection rules.
 *
 * Layer controls authority and retention, not teaching order. Explanation order
 * is computed from PREREQUISITE_OF edges in dependency-graph.js.
 */
export const LAYER_ORDER = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3 })
export const LAYER_WEIGHT = Object.freeze({ L0: 1000, L1: 600, L2: 300, L3: 100 })
export const PRIORITY_WEIGHT = Object.freeze({
  CRITICAL: 400,
  HIGH: 200,
  NORMAL: 50,
  LOW: 0,
})
export const CONFIDENCE_WEIGHT = Object.freeze({
  EXPLICIT: 120,
  VERIFIED: 100,
  INFERRED: 30,
  UNCERTAIN: 0,
})

export const ROOT_LAYER = 'L0'
export const CORE_LAYER = 'L1'
export const PREREQUISITE_LAYER = 'L2'
export const DETAIL_LAYER = 'L3'

/** L0 and L1 are never displaced by lower-layer material. */
export function isProtectedLayer(layer) {
  return layer === ROOT_LAYER || layer === CORE_LAYER
}

/** Whether a candidate layer may revise an existing layer without a correction. */
export function canReviseLayer(existingLayer, incomingLayer) {
  if (existingLayer === ROOT_LAYER) return incomingLayer === ROOT_LAYER
  if (existingLayer === CORE_LAYER) return incomingLayer === CORE_LAYER || incomingLayer === PREREQUISITE_LAYER
  if (existingLayer === PREREQUISITE_LAYER) return incomingLayer === PREREQUISITE_LAYER || incomingLayer === DETAIL_LAYER
  return true
}

/** Lower number wins for stable presentation. */
export function compareByLayerAndPriority(left, right) {
  const layerDiff = (LAYER_ORDER[left.layer] ?? 99) - (LAYER_ORDER[right.layer] ?? 99)
  if (layerDiff !== 0) return layerDiff
  const priorityDiff = (PRIORITY_WEIGHT[right.priority] ?? 0) - (PRIORITY_WEIGHT[left.priority] ?? 0)
  if (priorityDiff !== 0) return priorityDiff
  return (left.userOrder ?? 0) - (right.userOrder ?? 0)
}

/** Protected records survive capacity pressure regardless of age. */
export function isCapacityProtected(record, concepts = []) {
  if (record?.layer === ROOT_LAYER || record?.layer === CORE_LAYER) return true
  if (record?.protected === true) return true
  if (record?.feasibility === 'BLOCKED' || record?.feasibility === 'NEEDS_CLARIFICATION') return true
  if (!Array.isArray(record?.relatedConceptIds)) return false
  const byId = new Map(concepts.map(concept => [concept.id, concept]))
  return record.relatedConceptIds.some(id => {
    const concept = byId.get(id)
    return concept !== undefined
      && concept.layer === CORE_LAYER
      && !['EXPLAINED', 'VERIFIED'].includes(concept.status)
  })
}
