/**
 * Build structured capture candidates from a human message or from explicit
 * model-supplied items. This module is pure; persistence and conflict handling
 * live in merge-policy.js.
 */
import {
  classifyFragment,
  confidenceForUserText,
  detectIntent,
  extractDependencyHints,
  layerForIntent,
  priorityForIntent,
  splitUserMessage,
} from './classifier.js'
import { normalizeConceptName } from './schema.js'

const USER_SOURCES = new Set(['USER_EXPLICIT'])
const CONFIDENCE_RANK = { UNCERTAIN: 0, INFERRED: 1, VERIFIED: 2, EXPLICIT: 3 }

function confidenceRank(value) {
  return CONFIDENCE_RANK[value] ?? 0
}

export function sourceFor(kind, sessionId = null, seq = null, ref = null) {
  return {
    kind,
    sessionId: sessionId === null ? null : String(sessionId),
    seq: Number.isSafeInteger(seq) ? seq : null,
    ref: ref === null ? null : String(ref),
  }
}

export function sourceRefFor(sessionId, seq) {
  if (sessionId === null || sessionId === undefined) return null
  return Number.isSafeInteger(seq)
    ? `session:${sessionId}/event:${seq}`
    : `session:${sessionId}`
}

export function confidenceForSource(sourceKind, userText = '') {
  if (sourceKind === 'USER_EXPLICIT') return confidenceForUserText(userText)
  if (sourceKind === 'VERIFIED_SOURCE') return 'VERIFIED'
  if (sourceKind === 'TEMPORARY_ASSUMPTION') return 'UNCERTAIN'
  return 'INFERRED'
}

function aggregateConcepts(records) {
  const byName = new Map()
  for (const record of records) {
    for (const concept of record.concepts) {
      const key = normalizeConceptName(concept.name)
      if (key.length === 0) continue
      const existing = byName.get(key)
      if (existing === undefined) {
        byName.set(key, {
          ...concept,
          aliases: [],
          sourceRefs: [...record.sourceRefs],
          userOrder: record.userOrder,
        })
      } else {
        existing.sourceRefs = [...new Set([...existing.sourceRefs, ...record.sourceRefs])]
        if (concept.layer === 'L2' && existing.layer !== 'L1') existing.layer = 'L2'
        if (concept.status === 'QUEUED') existing.status = 'QUEUED'
        if (concept.priority === 'CRITICAL') existing.priority = 'CRITICAL'
      }
    }
  }
  return [...byName.values()]
}

function conceptForRecord(record) {
  return record.concepts.map(concept => ({
    name: concept.name,
    layer: concept.layer,
    priority: concept.priority,
    confidence: record.confidence,
    status: concept.status,
    sourceRefs: record.sourceRefs,
    userOrder: record.userOrder,
  }))
}

function recordFromClassification(classification, context) {
  const concepts = conceptForRecord({
    ...classification,
    concepts: classification.concepts,
    confidence: classification.confidence,
    sourceRefs: context.sourceRefs,
    userOrder: context.userOrder,
  })
  return {
    content: classification.content,
    userOriginal: classification.userOriginal,
    layer: classification.layer,
    topic: classification.topic,
    intent: classification.intent,
    temporalScope: classification.temporalScope,
    priority: classification.priority,
    confidence: classification.confidence,
    feasibility: classification.feasibility,
    feasibilityReason: classification.feasibilityReason,
    source: context.source,
    sourceRefs: context.sourceRefs,
    relatedConcepts: concepts.map(concept => concept.name),
    dependencyConcepts: [],
    concepts,
    userOrder: context.userOrder,
  }
}

/**
 * Build a capture bundle for one human message. If one fragment asks about
 * multiple listed concepts, one independent L1 record is produced per concept.
 */
export function buildCaptureBundle(input = {}) {
  const sourceKind = USER_SOURCES.has(input.sourceKind) ? input.sourceKind : 'MODEL_INFERRED'
  const source = input.source ?? sourceFor(sourceKind, input.sessionId, input.seq)
  const baseRef = sourceRefFor(input.sessionId, input.seq)
  const sourceRefs = [...new Set([
    ...(Array.isArray(input.sourceRefs) ? input.sourceRefs : []),
    ...(baseRef === null ? [] : [baseRef]),
  ])]
  const knownConcepts = Array.isArray(input.knownConcepts) ? input.knownConcepts : []
  const records = []
  let userOrder = Number.isSafeInteger(input.userOrderStart) ? input.userOrderStart : 0

  const explicitItems = Array.isArray(input.items) ? input.items : []
  if (explicitItems.length > 0) {
    for (const item of explicitItems) {
      const content = String(item?.content ?? '').trim()
      if (content.length === 0) continue
      const itemSourceKind = USER_SOURCES.has(item?.sourceKind) && USER_SOURCES.has(sourceKind)
        ? item.sourceKind
        : sourceKind
      const intent = item?.intent ?? detectIntent(content)
      const conceptNames = Array.isArray(item?.concepts)
        ? item.concepts.map(value => typeof value === 'string' ? value : value?.name).filter(Boolean)
        : Array.isArray(item?.relatedConcepts)
          ? item.relatedConcepts.map(value => typeof value === 'string' ? value : value?.name).filter(Boolean)
          : []
      const layer = item?.layer ?? layerForIntent(intent, conceptNames)
      const requestedConfidence = item?.confidence ?? confidenceForSource(itemSourceKind, content)
      const confidenceCap = itemSourceKind === 'USER_EXPLICIT'
        ? 'EXPLICIT'
        : itemSourceKind === 'VERIFIED_SOURCE'
          ? 'VERIFIED'
          : itemSourceKind === 'TEMPORARY_ASSUMPTION'
            ? 'UNCERTAIN'
            : 'INFERRED'
      const confidence = confidenceRank(requestedConfidence) > confidenceRank(confidenceCap)
        ? confidenceCap
        : requestedConfidence
      const priority = item?.priority ?? priorityForIntent(intent, layer, content)
      const conceptSpecs = conceptNames.map(name => ({
        name,
        layer: layer === 'L2' ? 'L2' : 'L1',
        priority: layer === 'L0' ? 'HIGH' : priority,
        confidence,
        status: item?.conceptStatus
          ?? (intent === 'question' || intent === 'prerequisite' ? 'QUEUED' : 'CAPTURED'),
        sourceRefs,
        userOrder,
      }))
      userOrder += 1
      records.push({
        content,
        userOriginal: String(item?.userOriginal ?? content),
        layer,
        topic: item?.topic ?? conceptNames[0] ?? content.slice(0, 80),
        intent,
        temporalScope: item?.temporalScope
          ?? (intent === 'goal' || intent === 'constraint' ? 'long_term' : 'task'),
        priority,
        confidence,
        feasibility: item?.feasibility ?? 'READY',
        feasibilityReason: item?.feasibilityReason ?? null,
        source: itemSourceKind === sourceKind
          ? source
          : sourceFor(itemSourceKind, input.sessionId, input.seq),
        sourceRefs,
        relatedConcepts: conceptNames,
        dependencyConcepts: Array.isArray(item?.prerequisiteConcepts)
          ? item.prerequisiteConcepts.map(value => typeof value === 'string' ? value : value?.name).filter(Boolean)
          : [],
        concepts: conceptSpecs,
        userOrder: item?.userOrder ?? userOrder - 1,
        targetMemoryId: item?.targetMemoryId ?? null,
        conflictWith: Array.isArray(item?.conflictWith) ? item.conflictWith : [],
        correctionOf: item?.correctionOf ?? null,
      })
    }
  } else {
    const fragments = splitUserMessage(input.text)
    for (const fragment of fragments) {
      const classification = classifyFragment(fragment, {
        knownConcepts,
        maxChars: input.maxChars,
        confidence: input.confidence,
        priority: input.priority,
        layer: input.layer,
        intent: input.intent,
      })
      const multiConceptQuestion = classification.intent === 'question' && classification.concepts.length > 1
      if (multiConceptQuestion) {
        for (const concept of classification.concepts) {
          const record = recordFromClassification({
            ...classification,
            content: `关于「${concept.name}」：${classification.content}`,
            topic: concept.name,
            concepts: [concept],
          }, {
            source,
            sourceRefs,
            userOrder,
          })
          userOrder += 1
          records.push(record)
        }
      } else {
        const record = recordFromClassification(classification, {
          source,
          sourceRefs,
          userOrder,
        })
        userOrder += 1
        records.push(record)
      }
    }
  }

  const concepts = aggregateConcepts(records)
  const conceptsByName = new Map(concepts.map(concept => [normalizeConceptName(concept.name), concept]))
  const relations = []
  const dependencyHints = records.flatMap(record => (
    extractDependencyHints(record.content).map(hint => ({ ...hint, record }))
  ))
  // Dependency wording is itself evidence for the two concept names. Add a
  // prerequisite node and (when needed) the dependent node, but never create an
  // edge from mere co-occurrence.
  for (const hint of dependencyHints) {
    const fromKey = normalizeConceptName(hint.from)
    if (!conceptsByName.has(fromKey)) {
      const concept = {
        name: hint.from,
        layer: 'L2',
        priority: hint.record.priority,
        confidence: hint.record.confidence,
        status: 'QUEUED',
        sourceRefs: hint.record.sourceRefs,
        userOrder: hint.record.userOrder,
        aliases: [],
      }
      concepts.push(concept)
      conceptsByName.set(fromKey, concept)
    }
    const toKey = normalizeConceptName(hint.to)
    if (!conceptsByName.has(toKey)) {
      const concept = {
        name: hint.to,
        layer: 'L1',
        priority: hint.record.priority,
        confidence: hint.record.confidence,
        status: 'QUEUED',
        sourceRefs: hint.record.sourceRefs,
        userOrder: hint.record.userOrder,
        aliases: [],
      }
      concepts.push(concept)
      conceptsByName.set(toKey, concept)
    }
    relations.push({
      type: 'PREREQUISITE_OF',
      fromConceptName: hint.from,
      toConceptName: hint.to,
      confidence: hint.confidence,
      source,
      evidence: hint.evidence,
    })
  }

  return {
    source,
    sourceRefs,
    records,
    concepts,
    relations,
    provenance: {
      sourceKind,
      automatic: explicitItems.length === 0,
      userOrderStart: userOrder,
    },
  }
}

/** Compare a tool's claimed explicit user text with recent human messages. */
export function userTextWasObserved(text, recentUserTexts = []) {
  const normalized = String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
  if (normalized.length === 0) return false
  return recentUserTexts.some(candidate => {
    const observed = String(candidate ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
    return observed.length > 0 && (observed.includes(normalized) || normalized.includes(observed))
  })
}
