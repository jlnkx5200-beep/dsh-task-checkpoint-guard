/**
 * Lightweight concept graph and dynamic explanation-order planner.
 *
 * PREREQUISITE_OF is the only relation that changes teaching order:
 * `from` is a prerequisite of `to`. Other relation types enrich the graph but
 * never fabricate a prerequisite.
 */
import { PRIORITY_WEIGHT } from './hierarchy.js'
import { normalizeConceptName } from './schema.js'

export function relationKey(type, fromConceptId, toConceptId) {
  return `${type}\u0000${fromConceptId}\u0000${toConceptId}`
}

export function prerequisitesFor(conceptId, relations) {
  return [...new Set(
    relations
      .filter(relation => relation.type === 'PREREQUISITE_OF' && relation.toConceptId === conceptId)
      .map(relation => relation.fromConceptId),
  )]
}

export function dependentsFor(conceptId, relations) {
  return [...new Set(
    relations
      .filter(relation => relation.type === 'PREREQUISITE_OF' && relation.fromConceptId === conceptId)
      .map(relation => relation.toConceptId),
  )]
}

export function relatedFor(conceptId, relations) {
  return [...new Set(
    relations
      .filter(relation => (
        relation.type === 'RELATED_TO'
        || relation.type === 'PART_OF'
        || relation.type === 'ELABORATES'
        || relation.type === 'EXAMPLE_OF'
        || relation.type === 'CONFLICTS_WITH'
      ))
      .flatMap(relation => {
        if (relation.fromConceptId === conceptId) return [relation.toConceptId]
        if (relation.toConceptId === conceptId) return [relation.fromConceptId]
        return []
      }),
  )]
}

export function buildGraph(concepts, relations) {
  const nodes = new Map()
  for (const concept of concepts) nodes.set(concept.id, concept)
  const validRelations = relations.filter(relation => (
    nodes.has(relation.fromConceptId)
    && nodes.has(relation.toConceptId)
    && relation.fromConceptId !== relation.toConceptId
  ))
  const prerequisiteMap = new Map()
  const dependentMap = new Map()
  for (const concept of concepts) {
    // Keep relations to missing concepts visible as unresolved dependencies.
    prerequisiteMap.set(concept.id, prerequisitesFor(concept.id, relations))
    dependentMap.set(concept.id, dependentsFor(concept.id, relations))
  }
  return {
    nodes,
    relations: validRelations,
    prerequisiteMap,
    dependentMap,
    missingRelations: relations.filter(relation => (
      !nodes.has(relation.fromConceptId) || !nodes.has(relation.toConceptId)
    )),
  }
}

/** Return every directed cycle reachable in the PREREQUISITE_OF graph. */
export function findCycles(graphOrConcepts, maybeRelations) {
  const graph = graphOrConcepts?.nodes instanceof Map
    ? graphOrConcepts
    : buildGraph(graphOrConcepts, maybeRelations)
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map([...graph.nodes.keys()].map(id => [id, WHITE]))
  const stack = []
  const cycles = []
  const seenCycles = new Set()

  function visit(id) {
    color.set(id, GRAY)
    stack.push(id)
    for (const next of graph.dependentMap.get(id) ?? []) {
      if (color.get(next) === GRAY) {
        const start = stack.indexOf(next)
        const cycle = [...stack.slice(start), next]
        const signature = [...new Set(cycle)].sort().join('\u0000')
        if (!seenCycles.has(signature)) {
          seenCycles.add(signature)
          cycles.push(cycle)
        }
      } else if (color.get(next) === WHITE) {
        visit(next)
      }
    }
    stack.pop()
    color.set(id, BLACK)
  }

  for (const id of graph.nodes.keys()) {
    if (color.get(id) === WHITE) visit(id)
  }
  return cycles
}

/** Whether adding prerequisite `from -> to` would close a prerequisite cycle. */
export function wouldCreatePrerequisiteCycle(relations, fromConceptId, toConceptId) {
  if (fromConceptId === toConceptId) return true
  const adjacency = new Map()
  for (const relation of relations) {
    if (relation.type !== 'PREREQUISITE_OF') continue
    if (!adjacency.has(relation.fromConceptId)) adjacency.set(relation.fromConceptId, [])
    adjacency.get(relation.fromConceptId).push(relation.toConceptId)
  }
  const stack = [toConceptId]
  const seen = new Set()
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === fromConceptId) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of adjacency.get(current) ?? []) stack.push(next)
  }
  return false
}

function conceptSortKey(concept, targetOrder) {
  return [
    targetOrder.get(concept.id) ?? Number.MAX_SAFE_INTEGER,
    Number(concept.userOrder ?? Number.MAX_SAFE_INTEGER),
    -(PRIORITY_WEIGHT[concept.priority] ?? 0),
    concept.name ?? '',
    concept.id,
  ]
}

function compareSortKey(left, right) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

/**
 * Build a prerequisite closure and a deterministic topological order.
 *
 * @param {Array<object>} concepts concept nodes
 * @param {Array<object>} relations graph relations
 * @param {Array<string>} targetIds concepts the user asked to explain
 * @param {{preserveUserOrder?: boolean}} [options]
 */
export function planExplanationOrder(concepts, relations, targetIds, options = {}) {
  const graph = buildGraph(concepts, relations)
  const requested = [...new Set(targetIds)].filter(id => graph.nodes.has(id))
  if (requested.length === 0) {
    return {
      ok: false,
      reason: 'unknown-target',
      order: [],
      cycles: [],
      missingTargetIds: [...new Set(targetIds)],
      separatePrerequisiteNoteIds: [],
    }
  }

  const closure = new Set()
  const missingPrerequisiteIds = new Set()
  function collect(id) {
    if (closure.has(id)) return
    closure.add(id)
    for (const prerequisiteId of graph.prerequisiteMap.get(id) ?? []) {
      if (!graph.nodes.has(prerequisiteId)) {
        missingPrerequisiteIds.add(prerequisiteId)
        continue
      }
      collect(prerequisiteId)
    }
  }
  for (const id of requested) collect(id)

  const closureConcepts = [...closure].map(id => graph.nodes.get(id)).filter(Boolean)
  const closureRelations = graph.relations.filter(relation => (
    relation.type === 'PREREQUISITE_OF'
    && closure.has(relation.fromConceptId)
    && closure.has(relation.toConceptId)
  ))
  const cycles = findCycles(closureConcepts, closureRelations)
  if (cycles.length > 0) {
    return {
      ok: false,
      reason: 'cycle',
      order: [],
      cycles,
      missingPrerequisiteIds: [...missingPrerequisiteIds],
      separatePrerequisiteNoteIds: [],
    }
  }
  if (missingPrerequisiteIds.size > 0) {
    return {
      ok: false,
      reason: 'missing-prerequisite',
      order: [],
      cycles: [],
      missingPrerequisiteIds: [...missingPrerequisiteIds],
      separatePrerequisiteNoteIds: [],
    }
  }

  const requestedConcepts = requested
    .map(id => graph.nodes.get(id))
    .filter(Boolean)
    .sort((left, right) => {
      const userOrderDiff = Number(left.userOrder ?? Number.MAX_SAFE_INTEGER)
        - Number(right.userOrder ?? Number.MAX_SAFE_INTEGER)
      return userOrderDiff || compareSortKey(
        conceptSortKey(left, new Map()),
        conceptSortKey(right, new Map()),
      )
    })
  const targetOrder = new Map(requestedConcepts.map((concept, index) => [concept.id, index]))
  const ordered = []
  const emitted = new Set()
  const prerequisiteRoles = new Set()
  const emit = conceptId => {
    if (emitted.has(conceptId)) return
    const prerequisites = [...(graph.prerequisiteMap.get(conceptId) ?? [])]
      .filter(id => graph.nodes.has(id))
      .map(id => graph.nodes.get(id))
      .sort((left, right) => compareSortKey(
        conceptSortKey(left, targetOrder),
        conceptSortKey(right, targetOrder),
      ))
    for (const prerequisite of prerequisites) {
      prerequisiteRoles.add(prerequisite.id)
      emit(prerequisite.id)
    }
    if (emitted.has(conceptId)) return
    emitted.add(conceptId)
    const concept = graph.nodes.get(conceptId)
    if (concept !== undefined) ordered.push(concept)
  }
  for (const concept of requestedConcepts) emit(concept.id)
  if (ordered.length !== closureConcepts.length) {
    return {
      ok: false,
      reason: 'cycle',
      order: [],
      cycles: findCycles(closureConcepts, closureRelations),
      missingPrerequisiteIds: [],
      separatePrerequisiteNoteIds: [],
    }
  }

  const targetSet = new Set(requested)
  const separatePrerequisiteNoteIds = ordered
    .filter(concept => !targetSet.has(concept.id) && prerequisiteRoles.has(concept.id))
    .map(concept => concept.id)
  const requestedOrderBefore = requestedConcepts.map(concept => concept.userOrder ?? null)
  const requestedOrderAfter = ordered
    .filter(concept => targetSet.has(concept.id))
    .map(concept => concept.userOrder ?? null)
  const userOrderAdjusted = options.preserveUserOrder !== false
    && requestedOrderBefore.some((value, index) => value !== requestedOrderAfter[index])

  return {
    ok: true,
    reason: 'ok',
    order: ordered.map((concept, index) => ({
      conceptId: concept.id,
      name: concept.name,
      layer: concept.layer,
      status: concept.status,
      userOrder: concept.userOrder,
      explanationOrder: index + 1,
      roles: [
        ...(targetSet.has(concept.id) ? ['target'] : []),
        ...(prerequisiteRoles.has(concept.id) ? ['prerequisite'] : []),
      ],
      prerequisiteIds: graph.prerequisiteMap.get(concept.id) ?? [],
    })),
    cycles: [],
    missingPrerequisiteIds: [],
    separatePrerequisiteNoteIds,
    targetPrerequisiteIds: ordered
      .filter(concept => targetSet.has(concept.id) && prerequisiteRoles.has(concept.id))
      .map(concept => concept.id),
    userOrderAdjusted,
    userOrderBefore: requestedOrderBefore,
    userOrderAfter: requestedOrderAfter,
  }
}

/**
 * Read-only graph projection with computed prerequisites and relations.
 */
export function graphView(concepts, relations, options = {}) {
  const graph = buildGraph(concepts, relations)
  const selectedIds = Array.isArray(options.conceptIds) && options.conceptIds.length > 0
    ? new Set(options.conceptIds)
    : null
  const nodes = concepts
    .filter(concept => selectedIds === null || selectedIds.has(concept.id))
    .map(concept => ({
      ...concept,
      aliases: [...concept.aliases],
      prerequisiteIds: graph.prerequisiteMap.get(concept.id) ?? [],
      relatedConceptIds: relatedFor(concept.id, graph.relations),
    }))
  return {
    ok: true,
    concepts: nodes,
    relations: graph.relations.filter(relation => (
      selectedIds === null
      || selectedIds.has(relation.fromConceptId)
      || selectedIds.has(relation.toConceptId)
    )),
    cycles: findCycles(graph),
    missingRelations: graph.missingRelations,
    unresolvedDependencies: concepts
      .filter(concept => options.includeUnresolved !== false)
      .filter(concept => (graph.prerequisiteMap.get(concept.id) ?? []).some(id => !graph.nodes.has(id)))
      .map(concept => ({ conceptId: concept.id, name: concept.name })),
  }
}

/** Case-insensitive concept lookup by display name or alias. */
export function findConceptByName(concepts, name) {
  const normalized = normalizeConceptName(name)
  if (normalized.length === 0) return undefined
  return concepts.find(concept => (
    normalizeConceptName(concept.name) === normalized
    || concept.aliases.some(alias => normalizeConceptName(alias) === normalized)
  ))
}
