/**
 * Runtime coordinator for the optional hierarchical memory subsystem.
 *
 * It owns one atomic memory store, the latest human-query cache used by prompt
 * assembly, and the tool-facing operations. Every method is local and
 * deterministic; none invokes a model.
 */
import { MemoryStore } from './memory-curation/store.js'
import { buildCaptureBundle, userTextWasObserved } from './memory-curation/capture.js'
import { integrateCapture, addConceptRelation, deleteMemoryEntity, updateMemoryRecord } from './memory-curation/merge-policy.js'
import {
  graphView,
} from './memory-curation/dependency-graph.js'
import {
  retrieveContext,
  searchMemory,
} from './memory-curation/retrieval.js'
import {
  checkExplanationGuard,
} from './concept-guard/prerequisite-check.js'
import {
  conceptStatusView,
  reopenConceptsForDoubt,
  transitionConcept,
} from './concept-guard/state-transition.js'
import {
  applyConceptExplanationOrder,
  planConceptExplanation,
} from './concept-guard/explanation-order.js'
import { addAuditEntry } from './concept-guard/audit.js'

const MAX_RECENT_USER_TEXTS = 16
const MAX_RECENT_USER_TEXT_CHARS = 20000

function safeError(error) {
  return error instanceof Error ? error.message : String(error)
}

export class MemoryRuntime {
  constructor(options) {
    this.config = options.config
    this.logger = options.logger
    this.scopeId = options.config.memoryScopeId
    this.root = options.root
    this.store = new MemoryStore({
      root: options.root,
      scopeId: this.scopeId,
      logger: options.logger,
      maxRecordChars: options.config.maxMemoryRecordChars,
      maxMemoryHistoryVersions: options.config.maxMemoryHistoryVersions,
      maxMemoryAuditEntries: options.config.maxMemoryAuditEntries,
    })
    this.currentDocument = null
    this.recentUserTexts = new Map()
    this.lastQuery = new Map()
    this.initialized = false
    try {
      const loaded = this.store.readSync()
      this.currentDocument = loaded.document
    } catch (error) {
      this._log('warn', 'startup memory load failed; starting with an empty in-memory view', error)
    }
    this._readyPromise = this._initialize()
  }

  async _initialize() {
    const loaded = await this.store.read()
    this.currentDocument = loaded.document
    this.initialized = true
    return loaded
  }

  async ready() {
    await this._readyPromise
    return this
  }

  _log(level, message, error) {
    try {
      const method = this.logger?.[level] ?? this.logger?.debug
      if (typeof method === 'function') {
        method.call(this.logger, `task-checkpoint-guard memory: ${message}`, error)
      }
    } catch {
      // Logging must never break the host.
    }
  }

  _nextUserOrder() {
    return (this.currentDocument?.records ?? []).reduce(
      (max, record) => Math.max(max, Number(record.userOrder) || 0),
      0,
    ) + 1
  }

  _rememberUserText(sessionId, text) {
    if (sessionId === null || sessionId === undefined) return
    const key = String(sessionId)
    const list = this.recentUserTexts.get(key) ?? []
    list.push(String(text ?? '').slice(0, MAX_RECENT_USER_TEXT_CHARS))
    this.recentUserTexts.set(key, list.slice(-MAX_RECENT_USER_TEXTS))
  }

  async captureUserMessage(input) {
    await this.ready()
    const sessionId = input?.sessionId === undefined ? null : String(input.sessionId)
    const text = String(input?.text ?? '')
    if (text.trim().length === 0) {
      return { ok: true, skipped: true, reason: 'empty-message', capturedIds: [] }
    }
    this._rememberUserText(sessionId, text)
    this.lastQuery.set(sessionId ?? 'global', text)
    const knownConcepts = this.currentDocument?.concepts ?? []
    const bundle = buildCaptureBundle({
      text,
      sourceKind: 'USER_EXPLICIT',
      sessionId,
      seq: input?.seq,
      sourceRefs: input?.sourceRefs,
      userOrderStart: this._nextUserOrder(),
      knownConcepts,
      maxChars: this.config.maxMemoryRecordChars,
    })
    try {
      const updated = await this.store.update(document => {
        const result = integrateCapture(document, bundle, this._mergeOptions(input?.now))
        const doubt = reopenConceptsForDoubt(document, text, this._mergeOptions(input?.now))
        return {
          result: { ...result, reopenedConceptIds: doubt.reopened },
          changed: result.capturedIds.length > 0 || result.relationIds.length > 0 || doubt.reopened.length > 0,
        }
      })
      this.currentDocument = updated.document
      return { ok: true, ...updated.result }
    } catch (error) {
      this._log('warn', 'automatic user-message capture failed', error)
      throw error
    }
  }

  _mergeOptions(nowValue) {
    return {
      now: Number.isSafeInteger(nowValue) ? nowValue : Date.now(),
      maxMemoryRecords: this.config.maxMemoryRecords,
      maxMemoryConcepts: this.config.maxMemoryConcepts,
      maxMemoryHistoryVersions: this.config.maxMemoryHistoryVersions,
      maxMemoryAuditEntries: this.config.maxMemoryAuditEntries,
    }
  }

  /**
   * Capture explicit structured items from the model. Claims of USER_EXPLICIT
   * are checked against recently observed human messages; unverifiable claims
   * are downgraded, never promoted.
   */
  async captureTool(input, exec = {}) {
    await this.ready()
    const sessionId = exec?.agent?.session?.id === undefined
      ? input?.sessionId ?? null
      : String(exec.agent.session.id)
    const requestedSourceKind = String(input?.sourceKind ?? 'MODEL_INFERRED')
    const sourceKind = ['USER_EXPLICIT', 'VERIFIED_SOURCE', 'MODEL_INFERRED', 'TOOL_INFERRED', 'TEMPORARY_ASSUMPTION']
      .includes(requestedSourceKind)
      ? requestedSourceKind
      : 'MODEL_INFERRED'
    let provenance = 'accepted'
    const items = Array.isArray(input?.items) ? input.items : []
    const claimedExplicitTexts = [
      ...(typeof input?.text === 'string' ? [input.text] : []),
      ...items.map(item => String(item?.content ?? '')),
    ].filter(Boolean)
    const recent = this.recentUserTexts.get(String(sessionId)) ?? []
    const verified = claimedExplicitTexts.length === 0
      || claimedExplicitTexts.every(text => userTextWasObserved(text, recent))
    if (sourceKind === 'USER_EXPLICIT' && !verified) {
      provenance = 'downgraded-unverified-user-claim'
    }
    const effectiveSourceKind = provenance === 'downgraded-unverified-user-claim'
      ? 'MODEL_INFERRED'
      : sourceKind
    const bundle = buildCaptureBundle({
      text: input?.text,
      items,
      sourceKind: effectiveSourceKind,
      sessionId,
      seq: exec?.agent?.session?.seq,
      userOrderStart: this._nextUserOrder(),
      knownConcepts: this.currentDocument?.concepts ?? [],
      maxChars: this.config.maxMemoryRecordChars,
    })
    const updated = await this.store.update(document => {
      const result = integrateCapture(document, bundle, this._mergeOptions())
      addAuditEntry(document, {
        action: 'tool-memory-capture',
        detail: `${result.capturedIds.length} record(s); ${provenance}`,
      }, this._mergeOptions())
      return {
        result: { ...result, provenance },
        changed: result.capturedIds.length > 0 || result.relationIds.length > 0,
      }
    })
    this.currentDocument = updated.document
    return { ok: true, ...updated.result }
  }

  contextForAgent(agent) {
    if (this.currentDocument === null) return ''
    const sessionId = agent?.session?.id ?? agent?.id
    const query = this.lastQuery.get(String(sessionId)) ?? ''
    return retrieveContext(this.currentDocument, {
      query,
      maxChars: this.config.maxMemoryContextChars,
      maxTokens: this.config.maxMemoryContextTokens,
    }).text
  }

  async search(input = {}) {
    await this.ready()
    return searchMemory(this.currentDocument, input.query ?? '', {
      layers: input.layers,
      conceptIds: input.conceptIds,
      includeCompressed: input.includeCompressed === true,
      limit: input.limit,
    })
  }

  async graph(input = {}) {
    await this.ready()
    return graphView(this.currentDocument.concepts, this.currentDocument.relations, {
      conceptIds: input.conceptIds,
      includeUnresolved: input.includeUnresolved !== false,
    })
  }

  async conceptStatus(input = {}, exec = {}) {
    await this.ready()
    const conceptIds = Array.isArray(input.conceptIds) ? input.conceptIds : []
    if (input.action === 'check') {
      return {
        ok: true,
        checks: conceptIds.map(conceptId => checkExplanationGuard(this.currentDocument, {
          targetConceptId: conceptId,
          usedConceptIds: input.usedConceptIds ?? [],
          plannedText: input.plannedText ?? '',
          exemptConceptIds: input.exemptConceptIds ?? [],
        })),
      }
    }
    if (input.action === 'view' || input.action === undefined) {
      const plan = planConceptExplanation(this.currentDocument, conceptIds.length > 0
        ? conceptIds
        : this.currentDocument.concepts.map(concept => concept.id))
      return {
        ok: true,
        concepts: conceptStatusView(this.currentDocument, conceptIds),
        plan,
        cycles: plan.cycles ?? [],
      }
    }

    const mapped = {
      start: 'INTRODUCED',
      complete: 'EXPLAINED',
      verify: 'VERIFIED',
      defer: 'DEFERRED',
      block: 'BLOCKED',
      reopen: 'QUEUED',
      queue: 'QUEUED',
    }
    const nextStatus = mapped[input.action]
    if (nextStatus === undefined) return { ok: false, error: 'unsupported-action', action: input.action }
    if (conceptIds.length === 0) return { ok: false, error: 'conceptIds-required' }
    if (input.action === 'verify') {
      if (typeof input.userEvidence !== 'string' || input.userEvidence.trim().length === 0) {
        return { ok: false, error: 'explicit-user-evidence-required' }
      }
      const sessionId = exec?.agent?.session?.id
      const recent = this.recentUserTexts.get(String(sessionId)) ?? []
      if (!userTextWasObserved(input.userEvidence, recent)) {
        return {
          ok: false,
          error: 'unverified-user-evidence',
          message: 'VERIFIED requires evidence observed in a recent human message, not a model-generated claim.',
        }
      }
    }
    const updated = await this.store.update(document => {
      const results = []
      for (const conceptId of conceptIds) {
        results.push(transitionConcept(document, conceptId, nextStatus, {
          reason: input.reason,
          usedConceptIds: input.usedConceptIds ?? [],
          plannedText: input.plannedText ?? '',
          exemptConceptIds: input.exemptConceptIds ?? [],
          explanationOrder: input.explanationOrder,
          evidence: input.action === 'verify'
            ? {
                kind: input.evidenceKind ?? 'USER_CONFIRMATION',
                sourceKind: 'USER_EXPLICIT',
                note: input.userEvidence,
              }
            : undefined,
          ...this._mergeOptions(),
        }))
      }
      return {
        result: { results },
        changed: results.some(result => result.ok),
      }
    })
    this.currentDocument = updated.document
    return { ok: updated.result.results.every(result => result.ok), ...updated.result }
  }

  async memoryUpdate(input = {}, exec = {}) {
    await this.ready()
    if (typeof input.memoryId !== 'string') return { ok: false, error: 'memoryId-required' }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      return { ok: false, error: 'expectedVersion-required' }
    }
    if (input.userCorrection === true) {
      const sessionId = exec?.agent?.session?.id
      const recent = this.recentUserTexts.get(String(sessionId)) ?? []
      const evidence = typeof input.userRequest === 'string'
        ? input.userRequest
        : this.lastQuery.get(String(sessionId)) ?? ''
      const correctionLanguage = /(?:更正|纠正|改正|改成|改为|其实|不对|不是|should be|correct|instead)/i.test(evidence)
      if (!correctionLanguage || !userTextWasObserved(evidence, recent)) {
        return {
          ok: false,
          error: 'explicit-user-correction-required',
          message: 'Semantic corrections require a correction request observed in a recent human message.',
        }
      }
    }
    const updated = await this.store.update(document => {
      const result = updateMemoryRecord(document, input.memoryId, {
        ...input,
        reason: input.reason,
      }, {
        ...this._mergeOptions(),
        userCorrection: input.userCorrection === true,
      })
      let relations = []
      if (result.ok && Array.isArray(input.addRelations)) {
        relations = input.addRelations.map(relation => addConceptRelation(document, relation, {
          ...this._mergeOptions(),
          allowCycleDiagnostic: input.allowCycleDiagnostic === true,
        }))
      }
      return {
        result: { ...result, relations },
        changed: result.ok && (result.changed !== false || relations.some(item => item.accepted)),
      }
    })
    this.currentDocument = updated.document
    return { ok: updated.result.ok !== false, ...updated.result }
  }

  async memoryDelete(input = {}, exec = {}) {
    await this.ready()
    if (typeof input.id !== 'string') return { ok: false, error: 'id-required' }
    if (input.confirm !== true) {
      return {
        ok: false,
        error: 'confirmation-required',
        message: 'Pass confirm: true only after the user explicitly requests deletion.',
      }
    }
    const sessionId = exec?.agent?.session?.id
    const recent = this.recentUserTexts.get(String(sessionId)) ?? []
    const evidence = typeof input.userRequest === 'string'
      ? input.userRequest
      : this.lastQuery.get(String(sessionId)) ?? ''
    const deletionLanguage = /(?:删除|删掉|移除|忘记|清除|forget|delete|remove|erase)/i.test(evidence)
    if (!deletionLanguage || !userTextWasObserved(evidence, recent)) {
      return {
        ok: false,
        error: 'explicit-user-deletion-request-required',
        message: 'Deletion requires an explicit deletion request observed in a recent human message.',
      }
    }
    const updated = await this.store.update(document => {
      const result = deleteMemoryEntity(document, input.id, {
        ...this._mergeOptions(),
        cascade: input.cascade !== false,
      })
      return { result, changed: result.ok }
    })
    this.currentDocument = updated.document
    return updated.result
  }

  async observeAssistantMessage(input = {}) {
    await this.ready()
    const sessionId = input.sessionId === undefined ? null : String(input.sessionId)
    const query = this.lastQuery.get(sessionId) ?? ''
    if (query.trim().length === 0) return { audited: [] }
    const targets = this.currentDocument.concepts.filter(concept => (
      query.toLowerCase().includes(String(concept.name).toLowerCase())
    ))
    if (targets.length === 0) return { audited: [] }
    const preliminary = targets.map(concept => ({
      concept,
      check: checkExplanationGuard(this.currentDocument, {
        targetConceptId: concept.id,
        plannedText: input.text ?? '',
      }),
    })).filter(item => (
      !item.check.allowed
      && (item.check.undeclaredConceptIds.length > 0 || item.check.blockingPrerequisiteIds.length > 0)
    ))
    if (preliminary.length === 0) return { audited: [] }
    const audited = []
    const updated = await this.store.update(document => {
      for (const concept of targets) {
        const check = checkExplanationGuard(document, {
          targetConceptId: concept.id,
          plannedText: input.text ?? '',
        })
        if (!check.allowed && (
          check.undeclaredConceptIds.length > 0
          || check.blockingPrerequisiteIds.length > 0
        )) {
          addAuditEntry(document, {
            action: 'concept-guard-observed-violation',
            conceptId: concept.id,
            detail: check.violations.map(item => `${item.kind}:${item.name ?? item.conceptId}`).join('; ').slice(0, 1000),
          }, this._mergeOptions())
          audited.push({ conceptId: concept.id, check })
        }
      }
      return {
        result: { audited },
        changed: audited.length > 0,
      }
    })
    this.currentDocument = updated.document
    return updated.result
  }
}
