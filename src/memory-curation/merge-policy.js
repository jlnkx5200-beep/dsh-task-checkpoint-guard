/**
 * Layered merge, correction, conflict, deletion, and capacity policy.
 *
 * The central invariant is monotonic authority: lower-layer information may add
 * context but cannot silently rewrite L0/L1. Corrections are explicit and keep
 * a bounded history.
 */
import { createHash } from 'node:crypto'
import {
  conceptIdFor,
  newMemoryId,
  normalizeConceptName,
  relationIdFor,
  stableHash,
} from './schema.js'
import {
  findConceptByName,
  wouldCreatePrerequisiteCycle,
} from './dependency-graph.js'
import {
  CONFIDENCE_WEIGHT,
  isCapacityProtected,
} from './hierarchy.js'

const PRIORITY_RANK = { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 }
const LAYER_RANK = { L0: 3, L1: 2, L2: 1, L3: 0 }
const CONFIDENCE_RANK = { UNCERTAIN: 0, INFERRED: 1, VERIFIED: 2, EXPLICIT: 3 }
const NEGATION = /(?:不是|并不|没有|不要|不能|不|并非|never|not|no longer)/i

function now(options) {
  return Number.isSafeInteger(options?.now) ? options.now : Date.now()
}

function normalizedContent(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s。！？!?；;，,：:、"'“”‘’()（）[\]【】]/g, '')
}

function contentDigest(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`
}

function addAudit(document, entry, options) {
  const max = options?.maxMemoryAuditEntries ?? 200
  if (max <= 0) return
  document.audit.push({
    at: now(options),
    action: entry.action ?? null,
    memoryId: entry.memoryId ?? null,
    conceptId: entry.conceptId ?? null,
    detail: entry.detail ?? null,
  })
  document.audit = document.audit.slice(-max)
}

function unionStrings(...values) {
  return [...new Set(values.flat().filter(value => typeof value === 'string' && value.length > 0))]
}

function hasNegation(text) {
  return NEGATION.test(String(text ?? ''))
}

function conflictShape(left, right) {
  if (left.layer !== right.layer) return false
  if (left.topic.length > 0 && right.topic.length > 0
    && normalizeConceptName(left.topic) !== normalizeConceptName(right.topic)) return false
  return hasNegation(left.content) !== hasNegation(right.content)
}

function recordHistoryEntry(record, reason) {
  return {
    version: record.version,
    content: record.content,
    layer: record.layer,
    priority: record.priority,
    confidence: record.confidence,
    reason,
    source: record.source,
    at: now(),
  }
}

export function createConceptNode(document, spec, options = {}) {
  const name = String(spec?.name ?? '').trim()
  if (name.length === 0) return undefined
  const existing = findConceptByName(document.concepts, name)
    ?? document.concepts.find(concept => concept.id === spec?.id)
  const sourceRefs = unionStrings(spec?.sourceRefs ?? [])
  if (existing !== undefined) {
    let changed = false
    const aliases = unionStrings(existing.aliases, spec?.aliases ?? [], normalizeConceptName(name) === normalizeConceptName(existing.name) ? [] : [name])
    if (aliases.length !== existing.aliases.length) {
      existing.aliases = aliases
      changed = true
    }
    if (sourceRefs.some(ref => !existing.sourceRefs.includes(ref))) {
      existing.sourceRefs = unionStrings(existing.sourceRefs, sourceRefs)
      changed = true
    }
    if (spec?.layer === 'L2' && existing.layer !== 'L1') {
      if (existing.layer !== 'L2') {
        existing.layer = 'L2'
        changed = true
      }
    }
    if (PRIORITY_RANK[spec?.priority] > PRIORITY_RANK[existing.priority]) {
      existing.priority = spec.priority
      changed = true
    }
    if (CONFIDENCE_RANK[spec?.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      existing.confidence = spec.confidence
      changed = true
    }
    if (spec?.status === 'QUEUED' && existing.status === 'CAPTURED') {
      existing.status = 'QUEUED'
      changed = true
    }
    if (Number.isSafeInteger(spec?.userOrder)
      && (existing.userOrder === 0 || spec.userOrder < existing.userOrder)) {
      existing.userOrder = spec.userOrder
      changed = true
    }
    if (changed) {
      existing.version += 1
      existing.updatedAt = now(options)
    }
    return existing
  }

  const concept = {
    id: conceptIdFor(name),
    name,
    aliases: unionStrings(spec?.aliases ?? [], normalizeConceptName(name) === normalizeConceptName(spec?.name ?? '') ? [] : [spec?.name]),
    layer: spec?.layer === 'L2' ? 'L2' : 'L1',
    priority: spec?.priority ?? 'HIGH',
    feasibility: spec?.feasibility ?? 'READY',
    confidence: spec?.confidence ?? 'UNCERTAIN',
    status: spec?.status ?? 'CAPTURED',
    prerequisiteIds: [],
    relatedConceptIds: [],
    sourceRefs,
    userOrder: Number.isSafeInteger(spec?.userOrder) ? spec.userOrder : 0,
    explanationOrder: null,
    version: 1,
    createdAt: now(options),
    updatedAt: now(options),
    statusHistory: [],
    uncertainty: null,
  }
  document.concepts.push(concept)
  addAudit(document, {
    action: 'concept-created',
    conceptId: concept.id,
    detail: concept.name,
  }, options)
  return concept
}

export function addConceptRelation(document, spec, options = {}) {
  const from = document.concepts.find(concept => concept.id === spec?.fromConceptId)
  const to = document.concepts.find(concept => concept.id === spec?.toConceptId)
  if (from === undefined || to === undefined || from.id === to.id) {
    return {
      accepted: false,
      relation: undefined,
      error: 'missing-concept',
    }
  }
  const type = spec?.type ?? 'RELATED_TO'
  const existing = document.relations.find(relation => (
    relation.type === type
    && relation.fromConceptId === from.id
    && relation.toConceptId === to.id
  ))
  if (existing !== undefined) {
    if (CONFIDENCE_RANK[spec?.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      existing.confidence = spec.confidence
      existing.updatedAt = now(options)
      existing.version += 1
    }
    return { accepted: true, relation: existing, duplicate: true }
  }

  let cycle = null
  if (type === 'PREREQUISITE_OF' && wouldCreatePrerequisiteCycle(document.relations, from.id, to.id)) {
    cycle = { fromConceptId: from.id, toConceptId: to.id }
    if (options.allowCycleDiagnostic !== true) {
      addAudit(document, {
        action: 'relation-cycle-rejected',
        conceptId: to.id,
        detail: `${from.name} -> ${to.name}`,
      }, options)
      return {
        accepted: false,
        relation: undefined,
        error: 'prerequisite-cycle',
        cycle,
      }
    }
  }

  const relation = {
    id: relationIdFor(type, from.id, to.id),
    type,
    fromConceptId: from.id,
    toConceptId: to.id,
    confidence: spec?.confidence ?? 'UNCERTAIN',
    source: spec?.source ?? {
      kind: 'TOOL_INFERRED',
      sessionId: null,
      seq: null,
      ref: null,
    },
    createdAt: now(options),
    updatedAt: now(options),
    version: 1,
    uncertain: Boolean(cycle),
    cycleDiagnostic: cycle,
  }
  document.relations.push(relation)
  addAudit(document, {
    action: 'relation-created',
    conceptId: to.id,
    detail: `${type}: ${from.name} -> ${to.name}`,
  }, options)
  return { accepted: true, relation, cycle }
}

function conceptMap(document) {
  return new Map(document.concepts.map(concept => [normalizeConceptName(concept.name), concept]))
}

function ensureConceptForName(document, name, options, spec = {}) {
  return findConceptByName(document.concepts, name)
    ?? createConceptNode(document, {
      name,
      layer: spec.layer ?? 'L2',
      priority: spec.priority ?? 'NORMAL',
      confidence: spec.confidence ?? 'UNCERTAIN',
      status: spec.status ?? 'CAPTURED',
      sourceRefs: spec.sourceRefs ?? [],
      userOrder: spec.userOrder ?? 0,
    }, options)
}

function buildRecord(candidate, conceptIds, dependencyIds, options) {
  const timestamp = now(options)
  return {
    id: newMemoryId('mem'),
    layer: candidate.layer ?? 'L3',
    topic: String(candidate.topic ?? candidate.content ?? '').slice(0, 300),
    content: String(candidate.content ?? ''),
    userOriginal: String(candidate.userOriginal ?? candidate.content ?? ''),
    source: candidate.source ?? { kind: 'MODEL_INFERRED', sessionId: null, seq: null, ref: null },
    sourceRefs: unionStrings(candidate.sourceRefs ?? []),
    confidence: candidate.confidence ?? 'UNCERTAIN',
    priority: candidate.priority ?? 'NORMAL',
    feasibility: candidate.feasibility ?? 'READY',
    feasibilityReason: candidate.feasibilityReason ?? null,
    processingStatus: candidate.processingStatus ?? (
      candidate.layer === 'L0' || candidate.layer === 'L3' ? 'CAPTURED' : 'QUEUED'
    ),
    relatedConceptIds: conceptIds,
    dependencyConceptIds: dependencyIds,
    intent: candidate.intent ?? 'unclassified',
    temporalScope: candidate.temporalScope ?? 'task',
    userOrder: Number.isSafeInteger(candidate.userOrder) ? candidate.userOrder : 0,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    compressed: false,
    compression: null,
    conflictsWith: [],
    history: [],
    protected: candidate.layer === 'L0' || candidate.layer === 'L1',
  }
}

function findCorrectionTarget(document, candidate) {
  const directId = candidate.correctionOf ?? candidate.targetMemoryId
  if (typeof directId === 'string') {
    return document.records.find(record => record.id === directId)
  }
  if (candidate.intent !== 'correction') return undefined
  const topic = normalizeConceptName(candidate.topic ?? '')
  const content = normalizedContent(candidate.content ?? '').replace(/^(?:更正|纠正|改正|其实)/u, '')
  return [...document.records].reverse().find(record => {
    const existingTopic = normalizeConceptName(record.topic ?? '')
    const existingContent = normalizedContent(record.content ?? '')
    const prefixLength = Math.min(8, content.length, existingContent.length)
    const commonPrefix = prefixLength >= 5 && content.slice(0, prefixLength) === existingContent.slice(0, prefixLength)
    return (topic.length > 0 && existingTopic === topic) || commonPrefix
  })
}

function findConflictTarget(document, candidate) {
  if (Array.isArray(candidate.conflictWith) && candidate.conflictWith.length > 0) {
    return document.records.find(record => candidate.conflictWith.includes(record.id))
  }
  const topic = normalizeConceptName(candidate.topic ?? '')
  return [...document.records].reverse().find(record => (
    topic.length > 0
    && normalizeConceptName(record.topic) === topic
    && conflictShape(record, candidate)
  ))
}

function makeConflict(document, existing, incoming, options) {
  const conflict = {
    id: newMemoryId('conflict'),
    memoryId: incoming.id,
    existingMemoryId: existing.id,
    conceptIds: unionStrings(existing.relatedConceptIds, incoming.relatedConceptIds),
    reason: `Conflicting ${incoming.layer} information for the same topic. Both sources are retained for confirmation.`,
    status: 'OPEN',
    createdAt: now(options),
    updatedAt: now(options),
    resolution: null,
  }
  document.conflicts.push(conflict)
  incoming.conflictsWith = unionStrings(incoming.conflictsWith, [existing.id])
  existing.conflictsWith = unionStrings(existing.conflictsWith, [incoming.id])
  addAudit(document, {
    action: 'conflict-recorded',
    memoryId: incoming.id,
    conceptId: incoming.relatedConceptIds[0] ?? null,
    detail: `conflict with ${existing.id}`,
  }, options)
  return conflict
}

function applyCorrection(existing, candidate, conceptIds, dependencyIds, options) {
  existing.history.push(recordHistoryEntry(existing, 'explicit correction'))
  existing.content = candidate.content
  existing.userOriginal = candidate.userOriginal ?? candidate.content
  // A user correction keeps the original authority layer unless the correction
  // explicitly reclassifies it. Lower-layer supplemental text must not demote L0.
  existing.layer = existing.layer === 'L0'
    ? (candidate.layer === 'L0' ? 'L0' : existing.layer)
    : (candidate.layer ?? existing.layer)
  existing.topic = candidate.topic ?? existing.topic
  existing.priority = candidate.priority ?? existing.priority
  existing.confidence = candidate.confidence ?? existing.confidence
  existing.feasibility = candidate.feasibility ?? existing.feasibility
  existing.feasibilityReason = candidate.feasibilityReason ?? existing.feasibilityReason
  existing.processingStatus = candidate.processingStatus ?? existing.processingStatus
  existing.relatedConceptIds = unionStrings(existing.relatedConceptIds, conceptIds)
  existing.dependencyConceptIds = unionStrings(existing.dependencyConceptIds, dependencyIds)
  existing.source = candidate.source ?? existing.source
  existing.sourceRefs = unionStrings(existing.sourceRefs, candidate.sourceRefs ?? [])
  existing.version += 1
  existing.updatedAt = now(options)
  existing.compressed = false
  existing.compression = null
  return existing
}

function mergeOneRecord(document, candidate, conceptIds, dependencyIds, options) {
  const exact = document.records.find(record => (
    normalizedContent(record.content) === normalizedContent(candidate.content)
    && record.layer === candidate.layer
  ))
  if (exact !== undefined) {
    exact.sourceRefs = unionStrings(exact.sourceRefs, candidate.sourceRefs ?? [])
    exact.relatedConceptIds = unionStrings(exact.relatedConceptIds, conceptIds)
    exact.dependencyConceptIds = unionStrings(exact.dependencyConceptIds, dependencyIds)
    exact.updatedAt = now(options)
    return { action: 'DUPLICATE', record: exact }
  }

  const correctionTarget = findCorrectionTarget(document, candidate)
  if (correctionTarget !== undefined) {
    const canCorrectProtected = correctionTarget.layer !== 'L0'
      || candidate.layer === 'L0'
      || (candidate.intent === 'correction' && candidate.source?.kind === 'USER_EXPLICIT')
    const authoritativeCorrection = ['EXPLICIT', 'VERIFIED'].includes(candidate.confidence)
      && ['USER_EXPLICIT', 'VERIFIED_SOURCE'].includes(candidate.source?.kind)
    if (canCorrectProtected && authoritativeCorrection) {
      applyCorrection(correctionTarget, candidate, conceptIds, dependencyIds, options)
      return { action: 'CORRECTION', record: correctionTarget }
    }
    addAudit(document, {
      action: authoritativeCorrection ? 'correction-protected' : 'inferred-correction-blocked',
      memoryId: correctionTarget.id,
      detail: authoritativeCorrection
        ? 'lower-layer correction retained as supplement; L0 content unchanged'
        : 'model inference cannot overwrite an existing record; retained separately',
    }, options)
  }

  const conflictTarget = findConflictTarget(document, candidate)
  const record = buildRecord(candidate, conceptIds, dependencyIds, options)
  if (conflictTarget !== undefined) {
    document.records.push(record)
    const conflict = makeConflict(document, conflictTarget, record, options)
    for (const conceptId of conflict.conceptIds) {
      addConceptRelation(document, {
        type: 'CONFLICTS_WITH',
        fromConceptId: conflictTarget.relatedConceptIds[0] ?? conceptId,
        toConceptId: record.relatedConceptIds[0] ?? conceptId,
        confidence: 'EXPLICIT',
        source: record.source,
      }, { ...options, allowCycleDiagnostic: true })
    }
    return { action: 'CONFLICT', record, conflict }
  }

  // Lower-layer material about a protected topic is a supplement, never an
  // overwrite. It stays an independent record and keeps its own source.
  const higher = document.records.find(existing => (
    LAYER_RANK[existing.layer] > LAYER_RANK[record.layer]
    && normalizeConceptName(existing.topic) === normalizeConceptName(record.topic)
  ))
  document.records.push(record)
  return {
    action: higher === undefined ? 'NEW' : 'SUPPLEMENT',
    record,
    supplementsMemoryId: higher?.id ?? null,
  }
}

/**
 * Merge one capture bundle into a memory document. The function is pure with
 * respect to I/O, so a store can wrap it in its atomic update lock.
 */
export function integrateCapture(document, bundle, options = {}) {
  const capturedIds = []
  const conceptIds = []
  const relationIds = []
  const conflicts = []
  const actions = []
  const conceptSpecs = Array.isArray(bundle?.concepts) ? bundle.concepts : []
  const nameToConcept = new Map()

  for (const spec of conceptSpecs) {
    const concept = createConceptNode(document, spec, options)
    if (concept !== undefined) {
      nameToConcept.set(normalizeConceptName(concept.name), concept)
      for (const alias of concept.aliases) nameToConcept.set(normalizeConceptName(alias), concept)
      if (!conceptIds.includes(concept.id)) conceptIds.push(concept.id)
    }
  }
  for (const record of bundle?.records ?? []) {
    for (const name of [...(record.relatedConcepts ?? []), ...(record.dependencyConcepts ?? [])]) {
      const concept = ensureConceptForName(document, name, options, {
        layer: (record.dependencyConcepts ?? []).includes(name) ? 'L2' : 'L1',
        priority: record.priority,
        confidence: record.confidence,
        status: record.intent === 'question' ? 'QUEUED' : 'CAPTURED',
        sourceRefs: record.sourceRefs,
        userOrder: record.userOrder,
      })
      if (concept !== undefined) {
        nameToConcept.set(normalizeConceptName(name), concept)
        if (!conceptIds.includes(concept.id)) conceptIds.push(concept.id)
      }
    }
  }

  for (const relationSpec of bundle?.relations ?? []) {
    const from = findConceptByName(document.concepts, relationSpec.fromConceptName)
      ?? nameToConcept.get(normalizeConceptName(relationSpec.fromConceptName))
    const to = findConceptByName(document.concepts, relationSpec.toConceptName)
      ?? nameToConcept.get(normalizeConceptName(relationSpec.toConceptName))
    if (from === undefined || to === undefined) continue
    const added = addConceptRelation(document, {
      ...relationSpec,
      fromConceptId: from.id,
      toConceptId: to.id,
    }, options)
    if (!added.accepted) {
      actions.push({
        action: 'UNRESOLVED_RELATION',
        reason: added.error,
        fromConceptId: from.id,
        toConceptId: to.id,
        cycle: added.cycle ?? null,
      })
      continue
    }
    if (!relationIds.includes(added.relation.id)) relationIds.push(added.relation.id)
  }

  for (const candidate of bundle?.records ?? []) {
    const relatedIds = []
    const dependencyIds = []
    for (const name of candidate.relatedConcepts ?? []) {
      const concept = findConceptByName(document.concepts, name)
        ?? nameToConcept.get(normalizeConceptName(name))
      if (concept !== undefined) relatedIds.push(concept.id)
    }
    for (const name of candidate.dependencyConcepts ?? []) {
      const concept = ensureConceptForName(document, name, options, {
        layer: 'L2',
        priority: candidate.priority,
        confidence: candidate.confidence,
        status: 'CAPTURED',
        sourceRefs: candidate.sourceRefs,
        userOrder: candidate.userOrder,
      })
      if (concept !== undefined) dependencyIds.push(concept.id)
    }
    // Explicit prerequisite input is a user/tool-declared edge. It is not
    // inferred from co-occurrence, and a cycle is rejected by addConceptRelation.
    for (const dependencyId of dependencyIds) {
      for (const relatedId of relatedIds) {
        const added = addConceptRelation(document, {
          type: 'PREREQUISITE_OF',
          fromConceptId: dependencyId,
          toConceptId: relatedId,
          confidence: candidate.confidence,
          source: candidate.source,
        }, options)
        if (added.accepted && !relationIds.includes(added.relation.id)) relationIds.push(added.relation.id)
      }
    }
    const merged = mergeOneRecord(
      document,
      candidate,
      [...new Set(relatedIds)],
      [...new Set(dependencyIds)],
      options,
    )
    capturedIds.push(merged.record.id)
    actions.push({
      action: merged.action,
      memoryId: merged.record.id,
      supplementsMemoryId: merged.supplementsMemoryId ?? null,
    })
    if (merged.conflict !== undefined) conflicts.push(merged.conflict)
  }

  for (const concept of document.concepts) {
    concept.prerequisiteIds = document.relations
      .filter(relation => relation.type === 'PREREQUISITE_OF' && relation.toConceptId === concept.id)
      .map(relation => relation.fromConceptId)
    concept.relatedConceptIds = document.relations
      .filter(relation => (
        relation.type !== 'PREREQUISITE_OF'
        && (relation.fromConceptId === concept.id || relation.toConceptId === concept.id)
      ))
      .flatMap(relation => (
        relation.fromConceptId === concept.id ? [relation.toConceptId] : [relation.fromConceptId]
      ))
    concept.relatedConceptIds = [...new Set(concept.relatedConceptIds)]
  }

  const capacity = enforceCapacity(document, options)
  addAudit(document, {
    action: 'capture-merged',
    memoryId: capturedIds[0] ?? null,
    conceptId: conceptIds[0] ?? null,
    detail: `${capturedIds.length} record(s), ${actions.map(item => item.action).join(',')}`,
  }, options)

  return {
    ok: true,
    capturedIds: [...new Set(capturedIds)],
    conceptIds: [...new Set(conceptIds)],
    relationIds: [...new Set(relationIds)],
    conflicts,
    actions,
    capacity,
  }
}

/** Update one record with optimistic concurrency and a retained history entry. */
export function updateMemoryRecord(document, id, patch, options = {}) {
  const record = document.records.find(item => item.id === id)
  if (record === undefined) return { ok: false, error: 'not-found' }
  if (Number.isSafeInteger(patch?.expectedVersion)
    && patch.expectedVersion !== record.version) {
    return {
      ok: false,
      error: 'stale-version',
      expectedVersion: patch.expectedVersion,
      actualVersion: record.version,
    }
  }
  if (record.layer === 'L0' && patch?.layer !== undefined && patch.layer !== 'L0'
    && options.userCorrection !== true) {
    return { ok: false, error: 'protected-layer' }
  }
  const changesSemanticContent = ['content', 'userOriginal', 'topic', 'layer'].some(key => (
    patch?.[key] !== undefined && patch[key] !== record[key]
  ))
  const promotesConfidence = patch?.confidence !== undefined
    && (CONFIDENCE_RANK[patch.confidence] ?? 0) > (CONFIDENCE_RANK[record.confidence] ?? 0)
  if ((changesSemanticContent || promotesConfidence) && options.userCorrection !== true) {
    return {
      ok: false,
      error: 'user-correction-required',
      message: 'Semantic content and confidence upgrades require an explicit user correction.',
    }
  }
  const reason = String(patch?.reason ?? 'manual update')
  record.history.push(recordHistoryEntry(record, reason))
  let changed = false
  for (const key of [
    'content', 'userOriginal', 'topic', 'priority', 'layer', 'confidence',
    'feasibility', 'processingStatus',
  ]) {
    if (patch?.[key] === undefined || patch[key] === record[key]) continue
    record[key] = patch[key]
    changed = true
  }
  if (Array.isArray(patch?.relatedConceptIds)) {
    record.relatedConceptIds = unionStrings(patch.relatedConceptIds)
    changed = true
  }
  if (Array.isArray(patch?.dependencyConceptIds)) {
    record.dependencyConceptIds = unionStrings(patch.dependencyConceptIds)
    changed = true
  }
  if (!changed) return { ok: true, record, changed: false }
  record.version += 1
  record.updatedAt = now(options)
  addAudit(document, {
    action: 'memory-updated',
    memoryId: record.id,
    detail: reason,
  }, options)
  return { ok: true, record, changed: true }
}

function removeRelation(document, relationId) {
  const index = document.relations.findIndex(relation => relation.id === relationId)
  if (index >= 0) document.relations.splice(index, 1)
}

function pruneConceptIndexes(document, conceptId) {
  document.records = document.records.map(record => ({
    ...record,
    relatedConceptIds: record.relatedConceptIds.filter(id => id !== conceptId),
    dependencyConceptIds: record.dependencyConceptIds.filter(id => id !== conceptId),
  }))
  document.conflicts = document.conflicts.map(conflict => ({
    ...conflict,
    conceptIds: conflict.conceptIds.filter(id => id !== conceptId),
  }))
}

/**
 * Delete one memory record or concept and synchronize all indexes.
 * `cascade` removes concepts orphaned by the deleted record.
 */
export function deleteMemoryEntity(document, id, options = {}) {
  const recordIndex = document.records.findIndex(record => record.id === id)
  if (recordIndex >= 0) {
    const [record] = document.records.splice(recordIndex, 1)
    const remainingRefs = new Set(
      document.records.flatMap(item => [
        ...(item.relatedConceptIds ?? []),
        ...(item.dependencyConceptIds ?? []),
      ]),
    )
    const remainingSourceRefs = new Set(document.records.flatMap(item => item.sourceRefs ?? []))
    const removedConceptIds = []
    for (const concept of document.concepts) {
      concept.sourceRefs = concept.sourceRefs.filter(ref => remainingSourceRefs.has(ref))
      const orphaned = concept.sourceRefs.length === 0
        && !remainingRefs.has(concept.id)
        && !document.relations.some(relation => (
          relation.fromConceptId === concept.id || relation.toConceptId === concept.id
        ))
      if (orphaned && options.cascade !== false) removedConceptIds.push(concept.id)
    }
    for (const conceptId of removedConceptIds) {
      document.concepts = document.concepts.filter(concept => concept.id !== conceptId)
      document.relations = document.relations.filter(relation => (
        relation.fromConceptId !== conceptId && relation.toConceptId !== conceptId
      ))
      pruneConceptIndexes(document, conceptId)
    }
    document.conflicts = document.conflicts.filter(conflict => (
      conflict.memoryId !== id && conflict.existingMemoryId !== id
    ))
    addAudit(document, {
      action: 'memory-deleted',
      memoryId: id,
      detail: `layer=${record.layer}; concepts=${removedConceptIds.length}`,
    }, options)
    return {
      ok: true,
      deleted: 'record',
      id,
      removedConceptIds,
    }
  }

  const concept = document.concepts.find(item => item.id === id)
  if (concept === undefined) return { ok: false, error: 'not-found' }
  document.concepts = document.concepts.filter(item => item.id !== id)
  document.relations = document.relations.filter(relation => (
    relation.fromConceptId !== id && relation.toConceptId !== id
  ))
  pruneConceptIndexes(document, id)
  addAudit(document, {
    action: 'concept-deleted',
    conceptId: id,
    detail: concept.name,
  }, options)
  return { ok: true, deleted: 'concept', id, removedConceptIds: [] }
}

/**
 * Compress low-priority L3 details first, then evict only already-compressed,
 * unprotected L3 records. Protected content is never removed to satisfy the cap.
 */
export function enforceCapacity(document, options = {}) {
  const maxRecords = Number.isSafeInteger(options.maxMemoryRecords)
    ? options.maxMemoryRecords
    : 500
  const maxConcepts = Number.isSafeInteger(options.maxMemoryConcepts)
    ? options.maxMemoryConcepts
    : 300
  let compressions = 0
  let evictions = 0

  const compressible = document.records
    .filter(record => (
      record.layer === 'L3'
      && !record.compressed
      && !isCapacityProtected(record, document.concepts)
    ))
    .sort((left, right) => (
      (PRIORITY_RANK[left.priority] ?? 0) - (PRIORITY_RANK[right.priority] ?? 0)
      || left.updatedAt - right.updatedAt
    ))
  for (const record of compressible) {
    if (document.records.length <= maxRecords) break
    const originalChars = record.content.length
    record.content = record.content.length > 240
      ? `${record.content.slice(0, 239)}…`
      : record.content
    record.userOriginal = record.userOriginal.length > 240
      ? `${record.userOriginal.slice(0, 239)}…`
      : record.userOriginal
    record.compressed = true
    record.compression = {
      originalChars,
      contentHash: contentDigest(record.content),
      compressedAt: now(options),
    }
    record.updatedAt = now(options)
    compressions += 1
  }

  while (document.records.length > maxRecords) {
    const victim = document.records
      .filter(record => (
        record.layer === 'L3'
        && record.compressed
        && !isCapacityProtected(record, document.concepts)
      ))
      .sort((left, right) => (
        (PRIORITY_RANK[left.priority] ?? 0) - (PRIORITY_RANK[right.priority] ?? 0)
        || left.updatedAt - right.updatedAt
      ))[0]
    if (victim === undefined) break
    document.records = document.records.filter(record => record.id !== victim.id)
    addAudit(document, {
      action: 'capacity-evicted',
      memoryId: victim.id,
      detail: `${victim.topic}; ${contentDigest(victim.content)}; refs=${victim.sourceRefs.join('|')}`,
    }, options)
    evictions += 1
  }

  while (document.concepts.length > maxConcepts) {
    const protectedIds = new Set([
      ...document.concepts.filter(concept => concept.layer === 'L1').map(concept => concept.id),
      ...document.relations
        .filter(relation => relation.type === 'PREREQUISITE_OF')
        .map(relation => relation.fromConceptId),
    ])
    const victim = document.concepts
      .filter(concept => concept.layer === 'L2' && !protectedIds.has(concept.id))
      .sort((left, right) => (
        (PRIORITY_RANK[left.priority] ?? 0) - (PRIORITY_RANK[right.priority] ?? 0)
        || left.updatedAt - right.updatedAt
      ))[0]
    if (victim === undefined) break
    document.concepts = document.concepts.filter(concept => concept.id !== victim.id)
    document.relations = document.relations.filter(relation => (
      relation.fromConceptId !== victim.id && relation.toConceptId !== victim.id
    ))
    addAudit(document, {
      action: 'capacity-evicted-concept',
      conceptId: victim.id,
      detail: victim.name,
    }, options)
    evictions += 1
  }

  document.capacity.compressions += compressions
  document.capacity.evictions += evictions
  return {
    compressions,
    evictions,
    recordCount: document.records.length,
    conceptCount: document.concepts.length,
    protectedOverflow: document.records.length > maxRecords,
  }
}

/** Return a human-readable digest for a record without exposing raw content. */
export function recordDigest(record) {
  return stableHash(`${record?.id ?? ''}\u0000${record?.content ?? ''}`, 20)
}

export { PRIORITY_RANK, LAYER_RANK, CONFIDENCE_WEIGHT, CONFIDENCE_RANK }
