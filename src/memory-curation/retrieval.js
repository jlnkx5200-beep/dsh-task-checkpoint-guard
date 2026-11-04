/**
 * Layered, dependency-aware retrieval and bounded prompt context.
 *
 * The selector deliberately ranks L0/L1/L2 ahead of L3. Keyword overlap alone
 * is never sufficient for a detail to displace a goal or a prerequisite.
 */
import {
  planExplanationOrder,
  prerequisitesFor,
  relatedFor,
} from './dependency-graph.js'
import {
  CONFIDENCE_WEIGHT,
  LAYER_WEIGHT,
  PRIORITY_WEIGHT,
  compareByLayerAndPriority,
} from './hierarchy.js'

const LAYER_NAME = {
  L0: 'L0 goals and constraints',
  L1: 'L1 core questions and concepts',
  L2: 'L2 prerequisite knowledge',
  L3: 'L3 selected details and applications',
}

/** Tokenize Latin words plus CJK unigrams/bigrams without external packages. */
export function tokenize(value) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase()
  const tokens = new Set()
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_+-]{1,}/g)) tokens.add(match[0])
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    const sequence = match[0]
    for (let index = 0; index < sequence.length; index++) {
      tokens.add(sequence[index])
      if (index + 1 < sequence.length) tokens.add(sequence.slice(index, index + 2))
    }
  }
  return tokens
}

function overlapScore(queryTokens, value) {
  if (queryTokens.size === 0) return 0
  const valueTokens = tokenize(value)
  let overlap = 0
  for (const token of queryTokens) {
    if (valueTokens.has(token)) overlap += token.length > 1 ? 2 : 0.5
  }
  return Math.min(300, overlap * 8)
}

function recencyScore(updatedAt, newest) {
  if (!Number.isFinite(updatedAt) || newest <= 0) return 0
  return Math.max(0, Math.min(40, 40 - ((newest - updatedAt) / Math.max(1, newest)) * 40))
}

function textOfRecord(record) {
  return `${record.topic ?? ''} ${record.content ?? ''} ${record.userOriginal ?? ''}`
}

function conceptMatchesQuery(concept, queryTokens, rawQuery) {
  const normalized = String(rawQuery ?? '').toLowerCase()
  if (normalized.length > 0 && normalized.includes(String(concept.name).toLowerCase())) return true
  const names = [concept.name, ...(concept.aliases ?? [])]
  return names.some(name => overlapScore(queryTokens, name) > 0)
}

/**
 * Return target concept ids. Explicit ids win; otherwise a name/alias match is
 * used. If no concept matches, all L1 concepts remain eligible as current core
 * questions rather than forcing a keyword-only choice.
 */
export function selectTargetConcepts(document, query, explicitIds = []) {
  if (Array.isArray(explicitIds) && explicitIds.length > 0) {
    return [...new Set(explicitIds)].filter(id => document.concepts.some(concept => concept.id === id))
  }
  const tokens = tokenize(query)
  const matched = document.concepts.filter(concept => conceptMatchesQuery(concept, tokens, query))
  if (matched.length > 0) return matched.map(concept => concept.id)
  return document.concepts.filter(concept => concept.layer === 'L1').map(concept => concept.id)
}

export function prerequisiteClosure(document, targetIds) {
  const closure = new Set()
  const stack = [...targetIds]
  while (stack.length > 0) {
    const id = stack.pop()
    if (closure.has(id)) continue
    closure.add(id)
    for (const prerequisiteId of prerequisitesFor(id, document.relations)) {
      if (document.concepts.some(concept => concept.id === prerequisiteId)) stack.push(prerequisiteId)
    }
  }
  return [...closure]
}

function buildConceptStatusBlock(document, selectedConceptIds, plan) {
  const selected = new Set(selectedConceptIds)
  const concepts = document.concepts
    .filter(concept => selected.has(concept.id))
    .sort((left, right) => {
      const leftOrder = plan.ok
        ? (plan.order.find(item => item.conceptId === left.id)?.explanationOrder ?? Number.MAX_SAFE_INTEGER)
        : left.userOrder
      const rightOrder = plan.ok
        ? (plan.order.find(item => item.conceptId === right.id)?.explanationOrder ?? Number.MAX_SAFE_INTEGER)
        : right.userOrder
      return leftOrder - rightOrder || compareByLayerAndPriority(left, right)
    })
  return concepts.map(concept => {
    const prerequisites = (concept.prerequisiteIds ?? []).map(id => {
      const prerequisite = document.concepts.find(item => item.id === id)
      return prerequisite === undefined
        ? `${id}(missing)`
        : `${prerequisite.name}[${prerequisite.status}]`
    })
    return `- ${concept.name} [${concept.layer}/${concept.status}/${concept.feasibility}]`
      + ` userOrder=${concept.userOrder}`
      + ` prerequisites=${prerequisites.length > 0 ? prerequisites.join(', ') : 'none'}`
  })
}

function readinessFor(document, targetIds) {
  const blockers = []
  for (const id of targetIds) {
    const concept = document.concepts.find(item => item.id === id)
    if (concept === undefined) {
      blockers.push({ conceptId: id, name: '(unknown)', reason: 'unknown-concept' })
      continue
    }
    for (const prerequisiteId of prerequisitesFor(id, document.relations)) {
      const prerequisite = document.concepts.find(item => item.id === prerequisiteId)
      if (prerequisite === undefined) {
        blockers.push({ conceptId: concept.id, name: concept.name, prerequisiteId, reason: 'missing-prerequisite-node' })
      } else if (!['EXPLAINED', 'VERIFIED'].includes(prerequisite.status)) {
        blockers.push({
          conceptId: concept.id,
          name: concept.name,
          prerequisiteId,
          prerequisiteName: prerequisite.name,
          reason: 'prerequisite-not-explained',
        })
      }
    }
  }
  return blockers
}

function scoreRecord(record, context) {
  const layerWeight = LAYER_WEIGHT[record.layer] ?? 0
  const priorityWeight = PRIORITY_WEIGHT[record.priority] ?? 0
  const confidenceWeight = CONFIDENCE_WEIGHT[record.confidence] ?? 0
  const keyword = overlapScore(context.queryTokens, textOfRecord(record))
  const relatedSelected = (record.relatedConceptIds ?? []).some(id => context.selectedConceptIds.has(id))
  const dependencySelected = (record.dependencyConceptIds ?? []).some(id => context.selectedConceptIds.has(id))
  const conceptBoost = relatedSelected ? 220 : 0
  const dependencyBoost = dependencySelected ? 180 : 0
  const exactTopic = context.rawQuery.length > 0
    && String(record.topic ?? '').length > 0
    && context.rawQuery.toLowerCase().includes(String(record.topic).toLowerCase())
    ? 160
    : 0
  const userOrderBoost = record.userOrder > 0 ? Math.max(0, 12 - record.userOrder) : 0
  return layerWeight + priorityWeight + confidenceWeight + keyword
    + conceptBoost + dependencyBoost + exactTopic + recencyScore(record.updatedAt, context.newest)
    + userOrderBoost
}

function estimatedTokens(value) {
  const text = String(value ?? '')
  let cjk = 0
  let other = 0
  for (const character of text) {
    if (/\p{Script=Han}/u.test(character)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

function truncateToBudget(value, remainingChars, remainingTokens) {
  let text = String(value ?? '')
  if (remainingChars <= 0 || remainingTokens <= 0) return ''
  while (text.length > 0 && (text.length > remainingChars || estimatedTokens(text) > remainingTokens)) {
    text = text.slice(0, -1)
  }
  return text.trimEnd()
}

function formatRecord(record) {
  const status = [
    record.layer,
    record.priority,
    record.confidence,
    record.feasibility,
  ].join('/')
  const refs = record.sourceRefs?.length > 0 ? ` refs=${record.sourceRefs.join(',')}` : ''
  return `- [${record.id}] (${status}) ${record.topic ? `${record.topic}: ` : ''}${record.content}${refs}`
}

/**
 * Select a bounded context. It returns selected/omitted ids and a rendered text
 * block. `includeDetails: true` is for an explicit search/expand operation, not
 * for automatic prompt injection.
 */
export function retrieveContext(document, options = {}) {
  const query = String(options.query ?? '')
  const queryTokens = tokenize(query)
  const targetIds = selectTargetConcepts(document, query, options.conceptIds)
  const closureIds = prerequisiteClosure(document, targetIds)
  const selectedConceptIds = new Set([...targetIds, ...closureIds])
  const newest = Math.max(0, ...document.records.map(record => Number(record.updatedAt) || 0))
  const context = {
    queryTokens,
    rawQuery: query,
    selectedConceptIds,
    newest,
  }
  const selectedTargets = new Set(targetIds)
  const selectedPrerequisites = new Set(closureIds.filter(id => !selectedTargets.has(id)))
  const layers = Array.isArray(options.layers) && options.layers.length > 0
    ? new Set(options.layers)
    : null
  const includeDetails = options.includeDetails === true

  const ranked = []
  for (const record of document.records) {
    if (record.compressed && options.includeCompressed !== true) {
      // Compressed records remain searchable only when explicitly requested.
      continue
    }
    if (layers !== null && !layers.has(record.layer)) continue
    if (record.layer === 'L0') {
      ranked.push({ record, score: scoreRecord(record, context) + 10000, mandatory: true })
      continue
    }
    if (record.layer === 'L1') {
      const related = (record.relatedConceptIds ?? []).some(id => selectedConceptIds.has(id))
      const topicMatch = queryTokens.size > 0 && overlapScore(queryTokens, textOfRecord(record)) > 0
      if (related || topicMatch || targetIds.length === 0) {
        ranked.push({ record, score: scoreRecord(record, context) + 4000, mandatory: targetIds.length === 0 })
      }
      continue
    }
    if (record.layer === 'L2') {
      const related = (record.relatedConceptIds ?? []).some(id => selectedPrerequisites.has(id))
        || (record.dependencyConceptIds ?? []).some(id => selectedConceptIds.has(id))
      if (related || selectedPrerequisites.size === 0) {
        ranked.push({ record, score: scoreRecord(record, context) + 1800, mandatory: false })
      }
      continue
    }
    if (record.layer === 'L3') {
      const related = (record.relatedConceptIds ?? []).some(id => selectedConceptIds.has(id))
      const topicMatch = queryTokens.size > 0
        && overlapScore(queryTokens, textOfRecord(record)) >= 16
        && String(record.topic ?? '').length > 0
        && query.toLowerCase().includes(String(record.topic).toLowerCase())
      // A L3 record must elaborate a selected concept or be explicitly
      // requested. Same-keyword coincidence is not enough.
      if (related || (includeDetails && topicMatch)) {
        ranked.push({ record, score: scoreRecord(record, context) + (related ? 500 : 0), mandatory: false })
      }
    }
  }

  ranked.sort((left, right) => {
    if (left.mandatory !== right.mandatory) return left.mandatory ? -1 : 1
    const scoreDiff = right.score - left.score
    if (scoreDiff !== 0) return scoreDiff
    return compareByLayerAndPriority(left.record, right.record)
  })

  const maxChars = Math.max(200, options.maxChars ?? 6000)
  const maxTokens = Math.max(50, options.maxTokens ?? 1200)
  const header = [
    '[MEMORY CONTEXT — structured local state, not a new user request]',
    `Scope: ${document.scopeId} (schema v${document.schemaVersion}, revision ${document.revision})`,
    'Use this only as curated context. It does not replace the user message or durable session facts.',
  ].join('\n')
  let text = `${header}\n`
  let usedChars = text.length
  let usedTokens = estimatedTokens(text)
  const selected = []
  const omitted = []
  const byLayer = { L0: [], L1: [], L2: [], L3: [] }

  function appendRecordLayer(layer) {
    const sectionRecords = ranked.filter(item => item.record.layer === layer)
    if (sectionRecords.length === 0) return
    const sectionHeader = `\n${LAYER_NAME[layer]}:\n`
    const sectionHeaderCostChars = sectionHeader.length
    const sectionHeaderCostTokens = estimatedTokens(sectionHeader)
    if (usedChars + sectionHeaderCostChars > maxChars || usedTokens + sectionHeaderCostTokens > maxTokens) {
      for (const item of sectionRecords) omitted.push(item.record.id)
      return
    }
    let emittedSectionHeader = false
    for (const item of sectionRecords) {
      const block = `${formatRecord(item.record)}\n`
      const blockChars = block.length
      const blockTokens = estimatedTokens(block)
      const remainingChars = maxChars - usedChars - (emittedSectionHeader ? 0 : sectionHeaderCostChars)
      const remainingTokens = maxTokens - usedTokens - (emittedSectionHeader ? 0 : sectionHeaderCostTokens)
      if (blockChars <= remainingChars && blockTokens <= remainingTokens) {
        if (!emittedSectionHeader) {
          text += sectionHeader
          usedChars += sectionHeaderCostChars
          usedTokens += sectionHeaderCostTokens
          emittedSectionHeader = true
        }
        text += block
        usedChars += blockChars
        usedTokens += blockTokens
        selected.push(item.record)
        byLayer[layer].push(item.record)
      } else if (layer === 'L0' && byLayer.L0.length === 0) {
        // L0 must not disappear entirely under a tiny budget. Truncate one goal
        // and mark the fact explicitly.
        const prefix = `\n${sectionHeader}`
        const roomChars = Math.max(0, maxChars - usedChars - prefix.length - 20)
        const roomTokens = Math.max(0, maxTokens - usedTokens - estimatedTokens(prefix) - 5)
        const truncated = truncateToBudget(formatRecord(item.record), roomChars, roomTokens)
        if (truncated.length > 0) {
          if (!emittedSectionHeader) {
            text += prefix
            usedChars += prefix.length
            usedTokens += estimatedTokens(prefix)
            emittedSectionHeader = true
          }
          text += `${truncated}\n`
          selected.push(item.record)
          byLayer.L0.push(item.record)
        } else {
          omitted.push(item.record.id)
        }
      } else {
        omitted.push(item.record.id)
      }
    }
  }

  // Authority order: goals, core questions, prerequisite records. L3 details
  // are emitted only after the concept guard has taken its budget.
  appendRecordLayer('L0')
  appendRecordLayer('L1')
  appendRecordLayer('L2')

  const plan = planExplanationOrder(document.concepts, document.relations, targetIds)
  const conceptIds = [...selectedConceptIds]
  const statuses = buildConceptStatusBlock(document, conceptIds, plan)
  const blockers = readinessFor(document, targetIds)
  const conceptLabel = selectedPrerequisites.size > 0
    ? 'L2 prerequisite knowledge and concept preparation state'
    : 'Concept preparation state'
  const conceptSection = statuses.length > 0
    ? `\n${conceptLabel}:\n${statuses.join('\n')}\n`
    : ''
  const orderLine = plan.ok && plan.order.length > 0
    ? `Recommended explanation order: ${plan.order.map(item => `${item.explanationOrder}. ${item.name}${item.roles.includes('prerequisite') ? ' [separate prerequisite note]' : ''}`).join(' -> ')}`
    : plan.reason === 'cycle'
      ? 'Explanation order: BLOCKED — a prerequisite cycle was detected. Do not invent a topological order.'
      : 'Explanation order: preserve user order; no complete prerequisite order is available.'
  const guard = [
    '\nExplanation guard:',
    '- Explain only a READY concept whose necessary prerequisites are EXPLAINED or VERIFIED.',
    '- If a prerequisite is missing, say so and explain that prerequisite separately before returning to the target.',
    '- Do not use a queued or unmentioned concept as a default premise. Do not claim the user has mastered a concept because a model mentioned it.',
    '- Keep the user\'s requested order unless a real prerequisite edge requires a separate prerequisite section.',
    orderLine,
  ]
  if (blockers.length > 0) {
    guard.push(`- Blockers: ${blockers.map(item => (
      item.prerequisiteName
        ? `${item.name} needs ${item.prerequisiteName}`
        : `${item.name}: ${item.reason}`
    )).join('; ')}`)
  }
  const closing = '\n[END MEMORY CONTEXT — local curated state only]'
  const guardText = guard.join('\n')
  // Reserve half of the remaining context (bounded) for the guard before
  // admitting the concept block, so a long L2 list cannot hide the guard.
  const remainingForConceptAndGuard = Math.max(0, maxChars - usedChars - closing.length)
  const conceptReserveChars = Math.min(
    conceptSection.length,
    Math.max(0, Math.floor(remainingForConceptAndGuard * 0.5)),
  )
  const conceptBudgetChars = conceptReserveChars > 0
    ? conceptReserveChars
    : Math.max(0, remainingForConceptAndGuard - Math.min(guardText.length, 300))
  const conceptBudgetTokens = Math.max(0, maxTokens - usedTokens - estimatedTokens(closing) - 40)
  if (conceptSection.length > 0 && conceptBudgetChars > 0 && conceptBudgetTokens > 0) {
    const boundedConcept = truncateToBudget(conceptSection, conceptBudgetChars, conceptBudgetTokens)
    if (boundedConcept.length > 0) {
      text += boundedConcept
      usedChars += boundedConcept.length
      usedTokens += estimatedTokens(boundedConcept)
    }
  }
  const guardRoomChars = maxChars - usedChars - closing.length
  const guardRoomTokens = maxTokens - usedTokens - estimatedTokens(closing)
  if (guardText.length > 0 && guardRoomChars > 0 && guardRoomTokens > 0) {
    const boundedGuard = truncateToBudget(guardText, guardRoomChars, guardRoomTokens)
    text += `\n${boundedGuard}`
    usedChars += boundedGuard.length + 1
    usedTokens += estimatedTokens(boundedGuard) + 1
  }

  // Details are last. They can use only what remains after goals, core,
  // prerequisites, and the guard.
  appendRecordLayer('L3')

  if (text.length + closing.length <= maxChars && estimatedTokens(text) + estimatedTokens(closing) <= maxTokens) {
    text += closing
    usedChars += closing.length
    usedTokens += estimatedTokens(closing)
  }

  const selectedIds = new Set(selected.map(record => record.id))
  const allOmitted = document.records
    .filter(record => !selectedIds.has(record.id))
    .map(record => record.id)
  return {
    text,
    selected,
    omitted: [...new Set([...omitted, ...allOmitted])],
    byLayer,
    targetConceptIds: targetIds,
    prerequisiteConceptIds: [...selectedPrerequisites],
    plan,
    blockers,
    budget: {
      maxChars,
      maxTokens,
      usedChars,
      usedTokens,
      exhausted: selected.length < ranked.length || usedChars >= maxChars || usedTokens >= maxTokens,
    },
  }
}

/**
 * Explicit search is intentionally broader than automatic injection. It is the
 * model/user's escape hatch for details that did not fit the context budget.
 */
export function searchMemory(document, query, options = {}) {
  const queryTokens = tokenize(query)
  const filters = new Set(Array.isArray(options.layers) ? options.layers : [])
  const conceptIds = new Set(Array.isArray(options.conceptIds) ? options.conceptIds : [])
  const records = document.records
    .filter(record => filters.size === 0 || filters.has(record.layer))
    .filter(record => conceptIds.size === 0 || (
      [...(record.relatedConceptIds ?? []), ...(record.dependencyConceptIds ?? [])]
        .some(id => conceptIds.has(id))
    ))
    .filter(record => options.includeCompressed === true || !record.compressed)
    .map(record => ({
      record,
      score: overlapScore(queryTokens, textOfRecord(record))
        + (LAYER_WEIGHT[record.layer] ?? 0)
        + (PRIORITY_WEIGHT[record.priority] ?? 0),
    }))
    .filter(item => queryTokens.size === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score || compareByLayerAndPriority(left.record, right.record))
    .slice(0, Number.isSafeInteger(options.limit) ? options.limit : 50)
    .map(item => ({ ...item.record, score: item.score }))

  const concepts = document.concepts
    .filter(concept => filters.size === 0 || filters.has(concept.layer))
    .filter(concept => conceptIds.size === 0 || conceptIds.has(concept.id))
    .map(concept => ({
      ...concept,
      prerequisiteIds: prerequisitesFor(concept.id, document.relations),
      relatedConceptIds: relatedFor(concept.id, document.relations),
      score: overlapScore(queryTokens, `${concept.name} ${(concept.aliases ?? []).join(' ')}`)
        + (LAYER_WEIGHT[concept.layer] ?? 0),
    }))
    .filter(item => queryTokens.size === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score || left.userOrder - right.userOrder)

  return {
    ok: true,
    query,
    records,
    concepts,
    total: records.length + concepts.length,
    explicit: true,
  }
}

export { estimatedTokens }
