/**
 * Concept learning-state machine.
 *
 * The key safety rule is semantic: a completed explanation is not user mastery.
 * Only explicit user evidence may move a concept to VERIFIED.
 */
import { checkExplanationGuard } from './prerequisite-check.js'
import { addAuditEntry } from './audit.js'

export const ALLOWED_TRANSITIONS = Object.freeze({
  CAPTURED: ['QUEUED', 'DEFERRED', 'BLOCKED'],
  QUEUED: ['INTRODUCED', 'DEFERRED', 'BLOCKED'],
  INTRODUCED: ['EXPLAINED', 'DEFERRED', 'BLOCKED'],
  EXPLAINED: ['VERIFIED', 'QUEUED', 'INTRODUCED', 'DEFERRED', 'BLOCKED'],
  VERIFIED: ['QUEUED', 'INTRODUCED', 'DEFERRED', 'BLOCKED'],
  DEFERRED: ['QUEUED', 'BLOCKED'],
  BLOCKED: ['QUEUED', 'DEFERRED'],
})

export const USER_EVIDENCE_KINDS = Object.freeze([
  'USER_CONFIRMATION',
  'USER_APPLICATION',
  'USER_FEEDBACK',
])

export function canTransitionConcept(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to)
}

function findConcept(document, id) {
  return document.concepts.find(concept => concept.id === id)
}

/**
 * Transition one concept with guard enforcement.
 *
 * @param {object} document
 * @param {string} conceptId
 * @param {string} nextStatus
 * @param {{
 *   reason?: string,
 *   usedConceptIds?: string[],
 *   plannedText?: string,
 *   exemptConceptIds?: string[],
 *   evidence?: {kind?: string, sourceKind?: string, note?: string},
 *   explanationOrder?: number,
 *   now?: number
 * }} options
 */
export function transitionConcept(document, conceptId, nextStatus, options = {}) {
  const concept = findConcept(document, conceptId)
  if (concept === undefined) return { ok: false, error: 'not-found', conceptId }
  if (!canTransitionConcept(concept.status, nextStatus)) {
    return {
      ok: false,
      error: 'invalid-transition',
      conceptId,
      from: concept.status,
      to: nextStatus,
      allowed: ALLOWED_TRANSITIONS[concept.status] ?? [],
    }
  }

  let guard = null
  if (nextStatus === 'INTRODUCED' || nextStatus === 'EXPLAINED') {
    guard = checkExplanationGuard(document, {
      targetConceptId: conceptId,
      usedConceptIds: options.usedConceptIds ?? [],
      plannedText: options.plannedText ?? '',
      exemptConceptIds: options.exemptConceptIds ?? [],
      explanationOrder: options.explanationOrder,
    })
    if (!guard.allowed) {
      return {
        ok: false,
        error: 'concept-guard-blocked',
        conceptId,
        from: concept.status,
        to: nextStatus,
        guard,
      }
    }
  }

  if (nextStatus === 'VERIFIED') {
    const evidenceKind = options.evidence?.kind
    const sourceKind = options.evidence?.sourceKind
    if (!USER_EVIDENCE_KINDS.includes(evidenceKind) || sourceKind !== 'USER_EXPLICIT') {
      return {
        ok: false,
        error: 'explicit-user-evidence-required',
        conceptId,
        from: concept.status,
        to: nextStatus,
        allowedEvidenceKinds: USER_EVIDENCE_KINDS,
      }
    }
  }

  const at = Number.isSafeInteger(options.now) ? options.now : Date.now()
  concept.statusHistory.push({
    from: concept.status,
    to: nextStatus,
    reason: String(options.reason ?? 'manual transition').slice(0, 500),
    evidenceKind: options.evidence?.kind ?? null,
    at,
  })
  concept.status = nextStatus
  concept.version += 1
  concept.updatedAt = at
  if (nextStatus === 'BLOCKED') concept.feasibility = 'BLOCKED'
  else if (nextStatus === 'NEEDS_CLARIFICATION') concept.feasibility = 'NEEDS_CLARIFICATION'
  else if (nextStatus === 'EXPLAINED' || nextStatus === 'VERIFIED') concept.feasibility = 'READY'
  if (Number.isSafeInteger(options.explanationOrder)) {
    concept.explanationOrder = options.explanationOrder
  }
  concept.statusHistory = concept.statusHistory.slice(-50)
  addAuditEntry(document, {
    action: `concept-${nextStatus.toLowerCase()}`,
    conceptId: concept.id,
    detail: options.reason ?? null,
    at,
  }, options)
  return {
    ok: true,
    concept,
    from: concept.statusHistory.at(-1)?.from,
    to: nextStatus,
    guard,
  }
}

const DOUBT = /(?:还是|仍然|依然|有点|有些|不太|没有|没).{0,8}(?:懂|理解|明白|清楚|会)|再解释|重新讲|再讲一遍|confused|don't understand|do not understand|not sure|still (?:do not|don't) get/i

/**
 * Reopen explained/verified concepts when the user expresses doubt or asks for
 * another explanation. This prevents VERIFIED from becoming permanent.
 */
export function reopenConceptsForDoubt(document, userText, options = {}) {
  const input = String(userText ?? '')
  if (!DOUBT.test(input)) return { reopened: [] }
  const reopened = []
  for (const concept of document.concepts) {
    const names = [concept.name, ...(concept.aliases ?? [])]
    if (!names.some(name => name.length >= 2 && input.toLowerCase().includes(String(name).toLowerCase()))) continue
    if (!['EXPLAINED', 'VERIFIED'].includes(concept.status)) continue
    const result = transitionConcept(document, concept.id, 'QUEUED', {
      ...options,
      reason: options.reason ?? 'user expressed doubt or requested re-explanation',
      evidence: {
        kind: 'USER_CONFIRMATION',
        sourceKind: 'USER_EXPLICIT',
        note: input.slice(0, 500),
      },
    })
    if (result.ok) reopened.push(concept.id)
  }
  return { reopened }
}

export function conceptStatusView(document, conceptIds = []) {
  const selected = Array.isArray(conceptIds) && conceptIds.length > 0
    ? new Set(conceptIds)
    : null
  return document.concepts
    .filter(concept => selected === null || selected.has(concept.id))
    .map(concept => {
      const prerequisites = (concept.prerequisiteIds ?? []).map(id => {
        const prerequisite = findConcept(document, id)
        return {
          id,
          name: prerequisite?.name ?? '(missing)',
          status: prerequisite?.status ?? 'MISSING',
        }
      })
      return {
        ...concept,
        prerequisites,
        readiness: prerequisites.every(item => ['EXPLAINED', 'VERIFIED'].includes(item.status))
          ? 'READY'
          : 'NEEDS_PREREQUISITE',
      }
    })
}
