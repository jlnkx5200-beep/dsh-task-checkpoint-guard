/**
 * Durable schema for the optional hierarchical memory subsystem.
 *
 * This schema is deliberately independent from the checkpoint schema. The
 * memory document is local-only, never contains hidden reasoning, and is read
 * only when memoryEnabled is true.
 */
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { redact } from '../redact.js'

export const MEMORY_SCHEMA_VERSION = 1
export const MEMORY_KIND = 'dsh-hierarchical-memory'

export const LAYERS = Object.freeze(['L0', 'L1', 'L2', 'L3'])
export const PRIORITIES = Object.freeze(['CRITICAL', 'HIGH', 'NORMAL', 'LOW'])
export const CONFIDENCES = Object.freeze(['EXPLICIT', 'VERIFIED', 'INFERRED', 'UNCERTAIN'])
export const FEASIBILITIES = Object.freeze([
  'READY',
  'NEEDS_PREREQUISITE',
  'NEEDS_CLARIFICATION',
  'BLOCKED',
  'OUT_OF_SCOPE',
])
export const CONCEPT_STATUSES = Object.freeze([
  'CAPTURED',
  'QUEUED',
  'INTRODUCED',
  'EXPLAINED',
  'VERIFIED',
  'DEFERRED',
  'BLOCKED',
])
export const PROCESSING_STATUSES = Object.freeze([
  'CAPTURED',
  'QUEUED',
  'IN_PROGRESS',
  'DONE',
  'DEFERRED',
  'BLOCKED',
])
export const RELATION_TYPES = Object.freeze([
  'PREREQUISITE_OF',
  'PART_OF',
  'ELABORATES',
  'EXAMPLE_OF',
  'RELATED_TO',
  'CONFLICTS_WITH',
])
export const SOURCE_KINDS = Object.freeze([
  'USER_EXPLICIT',
  'VERIFIED_SOURCE',
  'MODEL_INFERRED',
  'TOOL_INFERRED',
  'TEMPORARY_ASSUMPTION',
])
export const INTENTS = Object.freeze([
  'question',
  'goal',
  'constraint',
  'statement',
  'prerequisite',
  'detail',
  'correction',
  'temporary_request',
  'unclassified',
])

const MAX_ID = 160
const MAX_SHORT_TEXT = 300
const MAX_CONTENT = 20000
const SET_LAYERS = new Set(LAYERS)
const SET_PRIORITIES = new Set(PRIORITIES)
const SET_CONFIDENCES = new Set(CONFIDENCES)
const SET_FEASIBILITIES = new Set(FEASIBILITIES)
const SET_CONCEPT_STATUSES = new Set(CONCEPT_STATUSES)
const SET_PROCESSING_STATUSES = new Set(PROCESSING_STATUSES)
const SET_RELATION_TYPES = new Set(RELATION_TYPES)
const SET_SOURCE_KINDS = new Set(SOURCE_KINDS)
const SET_INTENTS = new Set(INTENTS)

function text(value, max = MAX_SHORT_TEXT) {
  return typeof value === 'string' ? redact(value, max) : ''
}

function optionalText(value, max = MAX_SHORT_TEXT) {
  const result = text(value, max)
  return result.length === 0 ? null : result
}

function integer(value, fallback = 0, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback
}

function boolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function uniqueStrings(value, maxItems = 100, maxLength = MAX_ID) {
  const seen = new Set()
  const result = []
  for (const item of array(value)) {
    if (typeof item !== 'string') continue
    const candidate = item.slice(0, maxLength)
    if (candidate.length === 0 || seen.has(candidate)) continue
    seen.add(candidate)
    result.push(candidate)
    if (result.length >= maxItems) break
  }
  return result
}

function enumValue(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

/** Stable hash used for ids and content fingerprints. */
export function stableHash(value, length = 16) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length)
}

/** One opaque ID with a useful prefix and no user text in the filename. */
export function newMemoryId(prefix = 'mem') {
  return `${prefix}_${stableHash(`${Date.now()}\u0000${randomUUID()}`, 20)}`
}

/** Normalize a concept name for deduplication; display casing is preserved. */
export function normalizeConceptName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[“”"'`]/g, '')
}

export function conceptIdFor(name) {
  return `concept_${stableHash(normalizeConceptName(name), 20)}`
}

export function relationIdFor(type, fromConceptId, toConceptId) {
  return `rel_${stableHash(`${type}\u0000${fromConceptId}\u0000${toConceptId}`, 20)}`
}

export function memoryFileName(scopeId) {
  const safe = String(scopeId ?? 'default-user')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 120)
    .replace(/[. ]+$/g, '_') || 'default-user'
  return `${safe}-${stableHash(String(scopeId ?? 'default-user'), 12)}.json`
}

export function createEmptyMemoryDocument(scopeId = 'default-user', now = Date.now()) {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: MEMORY_KIND,
    scopeId: String(scopeId),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    records: [],
    concepts: [],
    relations: [],
    conflicts: [],
    audit: [],
    capacity: {
      compressions: 0,
      evictions: 0,
    },
  }
}

function normalizeSource(raw) {
  if (typeof raw === 'string') {
    return {
      kind: SET_SOURCE_KINDS.has(raw) ? raw : 'TOOL_INFERRED',
      sessionId: null,
      seq: null,
      ref: null,
    }
  }
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    kind: enumValue(source.kind, SET_SOURCE_KINDS, 'TOOL_INFERRED'),
    sessionId: optionalText(source.sessionId, MAX_ID),
    seq: Number.isSafeInteger(source.seq) ? source.seq : null,
    ref: optionalText(source.ref, 500),
  }
}

function normalizeHistory(raw, maxVersions, maxChars) {
  return array(raw).slice(-maxVersions).map(item => ({
    version: integer(item?.version, 1, 1),
    content: text(item?.content, maxChars),
    layer: enumValue(item?.layer, SET_LAYERS, 'L3'),
    priority: enumValue(item?.priority, SET_PRIORITIES, 'NORMAL'),
    confidence: enumValue(item?.confidence, SET_CONFIDENCES, 'UNCERTAIN'),
    reason: optionalText(item?.reason, 500),
    source: normalizeSource(item?.source),
    at: integer(item?.at, 0),
  }))
}

function normalizeRecord(raw, options) {
  const layer = enumValue(raw?.layer, SET_LAYERS, 'L3')
  return {
    id: optionalText(raw?.id, MAX_ID) ?? newMemoryId('mem'),
    layer,
    topic: text(raw?.topic, 300),
    content: text(raw?.content, options.maxRecordChars),
    userOriginal: text(raw?.userOriginal, options.maxRecordChars),
    source: normalizeSource(raw?.source),
    sourceRefs: uniqueStrings(raw?.sourceRefs, 100, 500),
    confidence: enumValue(raw?.confidence, SET_CONFIDENCES, 'UNCERTAIN'),
    priority: enumValue(raw?.priority, SET_PRIORITIES, layer === 'L0' ? 'CRITICAL' : 'NORMAL'),
    feasibility: enumValue(raw?.feasibility, SET_FEASIBILITIES, 'READY'),
    feasibilityReason: optionalText(raw?.feasibilityReason, 1000),
    processingStatus: enumValue(raw?.processingStatus, SET_PROCESSING_STATUSES, 'CAPTURED'),
    relatedConceptIds: uniqueStrings(raw?.relatedConceptIds),
    dependencyConceptIds: uniqueStrings(raw?.dependencyConceptIds),
    intent: enumValue(raw?.intent, SET_INTENTS, 'unclassified'),
    temporalScope: ['long_term', 'task', 'temporary'].includes(raw?.temporalScope)
      ? raw.temporalScope
      : 'task',
    userOrder: integer(raw?.userOrder, 0, 0),
    version: integer(raw?.version, 1, 1),
    createdAt: integer(raw?.createdAt, 0),
    updatedAt: integer(raw?.updatedAt, 0),
    compressed: boolean(raw?.compressed),
    compression: raw?.compression && typeof raw.compression === 'object'
      ? {
          originalChars: integer(raw.compression.originalChars, 0, 0),
          contentHash: optionalText(raw.compression.contentHash, 100),
          compressedAt: integer(raw.compression.compressedAt, 0),
        }
      : null,
    conflictsWith: uniqueStrings(raw?.conflictsWith),
    history: normalizeHistory(raw?.history, options.maxVersions, options.maxRecordChars),
    protected: boolean(raw?.protected, layer === 'L0' || layer === 'L1'),
  }
}

function normalizeConcept(raw, options) {
  return {
    id: optionalText(raw?.id, MAX_ID) ?? conceptIdFor(raw?.name ?? ''),
    name: text(raw?.name, 300),
    aliases: uniqueStrings(raw?.aliases, 50, 300),
    layer: enumValue(raw?.layer, new Set(['L1', 'L2']), 'L1'),
    priority: enumValue(raw?.priority, SET_PRIORITIES, 'HIGH'),
    feasibility: enumValue(raw?.feasibility, SET_FEASIBILITIES, 'READY'),
    confidence: enumValue(raw?.confidence, SET_CONFIDENCES, 'UNCERTAIN'),
    status: enumValue(raw?.status, SET_CONCEPT_STATUSES, 'CAPTURED'),
    prerequisiteIds: uniqueStrings(raw?.prerequisiteIds),
    relatedConceptIds: uniqueStrings(raw?.relatedConceptIds),
    sourceRefs: uniqueStrings(raw?.sourceRefs, 100, 500),
    userOrder: integer(raw?.userOrder, 0, 0),
    explanationOrder: raw?.explanationOrder === null || raw?.explanationOrder === undefined
      ? null
      : integer(raw.explanationOrder, null, 1),
    version: integer(raw?.version, 1, 1),
    createdAt: integer(raw?.createdAt, 0),
    updatedAt: integer(raw?.updatedAt, 0),
    statusHistory: array(raw?.statusHistory).slice(-options.maxVersions).map(item => ({
      from: enumValue(item?.from, SET_CONCEPT_STATUSES, 'CAPTURED'),
      to: enumValue(item?.to, SET_CONCEPT_STATUSES, 'CAPTURED'),
      reason: optionalText(item?.reason, 500),
      evidenceKind: optionalText(item?.evidenceKind, 80),
      at: integer(item?.at, 0),
    })),
    uncertainty: optionalText(raw?.uncertainty, 1000),
  }
}

function normalizeRelation(raw) {
  const type = enumValue(raw?.type, SET_RELATION_TYPES, 'RELATED_TO')
  return {
    id: optionalText(raw?.id, MAX_ID) ?? relationIdFor(type, raw?.fromConceptId, raw?.toConceptId),
    type,
    fromConceptId: optionalText(raw?.fromConceptId, MAX_ID) ?? '',
    toConceptId: optionalText(raw?.toConceptId, MAX_ID) ?? '',
    confidence: enumValue(raw?.confidence, SET_CONFIDENCES, 'UNCERTAIN'),
    source: normalizeSource(raw?.source),
    createdAt: integer(raw?.createdAt, 0),
    updatedAt: integer(raw?.updatedAt, 0),
    version: integer(raw?.version, 1, 1),
    uncertain: boolean(raw?.uncertain),
    cycleDiagnostic: raw?.cycleDiagnostic && typeof raw.cycleDiagnostic === 'object'
      ? raw.cycleDiagnostic
      : null,
  }
}

function normalizeConflict(raw) {
  return {
    id: optionalText(raw?.id, MAX_ID) ?? newMemoryId('conflict'),
    memoryId: optionalText(raw?.memoryId, MAX_ID),
    existingMemoryId: optionalText(raw?.existingMemoryId, MAX_ID),
    conceptIds: uniqueStrings(raw?.conceptIds),
    reason: text(raw?.reason, 1000),
    status: ['OPEN', 'RESOLVED', 'DISMISSED'].includes(raw?.status) ? raw.status : 'OPEN',
    createdAt: integer(raw?.createdAt, 0),
    updatedAt: integer(raw?.updatedAt, 0),
    resolution: optionalText(raw?.resolution, 1000),
  }
}

export function normalizeMemoryDocument(raw, scopeId, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('memory document must be a JSON object')
  }
  if (raw.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    throw new Error(`unsupported memory schemaVersion ${String(raw.schemaVersion)}`)
  }
  if (raw.kind !== MEMORY_KIND) throw new Error('memory document kind mismatch')
  if (String(raw.scopeId) !== String(scopeId)) throw new Error('memory scopeId does not match the configured scope')
  const settings = {
    maxRecordChars: options.maxRecordChars ?? 2000,
    maxVersions: options.maxMemoryHistoryVersions ?? 20,
    maxAuditEntries: options.maxMemoryAuditEntries ?? 200,
  }
  const now = Date.now()
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: MEMORY_KIND,
    scopeId: String(scopeId),
    revision: integer(raw.revision, 0, 0),
    createdAt: integer(raw.createdAt, now),
    updatedAt: integer(raw.updatedAt, now),
    records: array(raw.records).map(item => normalizeRecord(item, settings)),
    concepts: array(raw.concepts).map(item => normalizeConcept(item, settings)),
    relations: array(raw.relations).map(normalizeRelation).filter(relation => (
      relation.fromConceptId.length > 0 && relation.toConceptId.length > 0
    )),
    conflicts: array(raw.conflicts).map(normalizeConflict),
    audit: array(raw.audit).slice(-settings.maxAuditEntries).map(item => ({
      at: integer(item?.at, 0),
      action: optionalText(item?.action, 100),
      memoryId: optionalText(item?.memoryId, MAX_ID),
      conceptId: optionalText(item?.conceptId, MAX_ID),
      detail: optionalText(item?.detail, 1000),
    })),
    capacity: {
      compressions: integer(raw.capacity?.compressions, 0, 0),
      evictions: integer(raw.capacity?.evictions, 0, 0),
    },
  }
}

export function safeMemoryFileName(scopeId) {
  return memoryFileName(scopeId)
}

export function memoryPath(root, scopeId) {
  return path.join(root, memoryFileName(scopeId))
}
