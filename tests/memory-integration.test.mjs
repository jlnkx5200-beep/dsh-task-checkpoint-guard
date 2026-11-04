import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../src/index.js'
import { loadCheckpoint } from '../src/storage.js'
import { memoryPath } from '../src/memory-curation/schema.js'
import {
  makeAgent,
  makeFakeContext,
  makeSession,
  makeTempRoot,
  removeTempRoot,
  textMessageEvent,
  waitFor,
} from './helpers.mjs'

async function makeHost() {
  const root = await makeTempRoot('dsh-memory-integration-')
  const memoryRoot = path.join(root, 'memory')
  const session = makeSession('memory-integration-session', 0)
  const agent = makeAgent(session)
  const ctx = makeFakeContext({ agents: [agent], sessions: [session], dshHomePath: root })
  return { root, memoryRoot, session, agent, ctx }
}

test('memory is disabled by default and registers no tools or prompt sections', async () => {
  const host = await makeHost()
  try {
    await apply(host.ctx, {
      checkpointRoot: host.root,
      persistDebounceMs: 0,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(host.ctx.tools.list().length, 0)
    assert.equal(host.ctx.systemPrompt.sections.size, 0)
  } finally {
    await host.ctx.dispose()
    await removeTempRoot(host.root)
  }
})

test('memory-enabled host without tool/prompt registries still checkpoints and captures locally', async () => {
  const root = await makeTempRoot('dsh-memory-optional-')
  const session = makeSession('optional-seam-session', 0)
  const agent = makeAgent(session)
  const ctx = makeFakeContext({
    agents: [agent],
    sessions: [session],
    tools: false,
    systemPrompt: false,
  })
  try {
    await apply(ctx, {
      checkpointRoot: root,
      memoryEnabled: true,
      memoryRoot: path.join(root, 'memory'),
      memoryScopeId: 'optional-seam',
      persistDebounceMs: 0,
      reconstructFromSessionQuery: false,
    })
    await ctx.emitSession(session, textMessageEvent(session.seq, '请解释偏导数。'))
    await waitFor(async () => {
      try {
        const parsed = JSON.parse(await readFile(memoryPath(path.join(root, 'memory'), 'optional-seam'), 'utf8'))
        return parsed.records.length >= 1
      } catch {
        return false
      }
    })
    const loadedCheckpoint = await waitFor(async () => {
      const loaded = await loadCheckpoint(root, session)
      return loaded?.state?.originalInstruction === '请解释偏导数。' ? loaded : undefined
    })
    assert.ok(loadedCheckpoint)
  } finally {
    await ctx.dispose()
    await removeTempRoot(root)
  }
})

test('enabled memory registers six tools, injects curated context, and preserves checkpoint schema', async () => {
  const host = await makeHost()
  try {
    await apply(host.ctx, {
      checkpointRoot: host.root,
      memoryEnabled: true,
      memoryRoot: host.memoryRoot,
      memoryScopeId: 'integration-user',
      persistDebounceMs: 0,
      reconstructFromSessionQuery: false,
    })
    await waitFor(() => host.ctx.tools.get('memory_capture') !== undefined)
    assert.deepEqual(
      host.ctx.tools.list().map(tool => tool.name).sort(),
      ['concept_graph', 'concept_status', 'memory_capture', 'memory_delete', 'memory_search', 'memory_update'],
    )

    await host.ctx.emitSession(host.session, textMessageEvent(
      host.session.seq,
      '请解释偏导数，并解释链式法则。',
    ))
    const memoryFile = memoryPath(host.memoryRoot, 'integration-user')
    await waitFor(async () => {
      try {
        const text = await readFile(memoryFile, 'utf8')
        return JSON.parse(text).records.length >= 2
      } catch {
        return false
      }
    })

    const assembly = host.ctx.systemPrompt.assemble({ agent: host.agent })
    const memorySection = assembly.sections.find(section => section.name === 'memory:curated')
    assert.ok(memorySection)
    assert.match(memorySection.text, /L1 core questions and concepts/)
    assert.match(memorySection.text, /偏导数/)
    assert.match(memorySection.text, /链式法则/)
    assert.match(memorySection.text, /Explanation guard/)

    const loadedCheckpoint = await loadCheckpoint(host.root, host.session)
    assert.ok(loadedCheckpoint)
    assert.equal(loadedCheckpoint.state.schemaVersion, 1)
    assert.equal('memory' in loadedCheckpoint.state, false)
    assert.doesNotMatch(JSON.stringify(loadedCheckpoint.state), /MEMORY CONTEXT/)
  } finally {
    await host.ctx.dispose()
    await removeTempRoot(host.root)
  }
})

test('memory tools enforce provenance, explicit user evidence, and layered search', async () => {
  const host = await makeHost()
  try {
    await apply(host.ctx, {
      checkpointRoot: host.root,
      memoryEnabled: true,
      memoryRoot: host.memoryRoot,
      memoryScopeId: 'tool-user',
      persistDebounceMs: 0,
      reconstructFromSessionQuery: false,
    })
    await waitFor(() => host.ctx.tools.get('memory_capture') !== undefined)
    await host.ctx.emitSession(host.session, textMessageEvent(
      host.session.seq,
      '请解释全微分，理解全微分需要先掌握偏导数。',
    ))
    await waitFor(async () => {
      try {
        const parsed = JSON.parse(await readFile(memoryPath(host.memoryRoot, 'tool-user'), 'utf8'))
        return parsed.concepts.length >= 2
      } catch {
        return false
      }
    })

    const inferred = await host.ctx.tools.execute({
      name: 'memory_capture',
      agent: host.agent,
      arguments: {
        sourceKind: 'USER_EXPLICIT',
        items: [{
          content: '用户已经掌握全微分',
          topic: '全微分掌握度',
          layer: 'L1',
          confidence: 'EXPLICIT',
          relatedConcepts: ['全微分'],
        }],
      },
    })
    assert.equal(inferred.value.ok, true)
    assert.equal(inferred.value.provenance, 'downgraded-unverified-user-claim')
    const capturedRecord = inferred.value.capturedIds[0]
    assert.ok(capturedRecord)
    const search = await host.ctx.tools.execute({
      name: 'memory_search',
      agent: host.agent,
      arguments: { query: '全微分掌握度', layers: ['L1'] },
    })
    const record = search.value.records.find(item => item.id === capturedRecord)
    assert.equal(record.confidence, 'INFERRED')

    const graph = await host.ctx.tools.execute({
      name: 'concept_graph',
      agent: host.agent,
      arguments: {},
    })
    const target = graph.value.concepts.find(concept => concept.name === '全微分')
    const partial = graph.value.concepts.find(concept => concept.name === '偏导数')
    assert.ok(target)
    assert.ok(partial)
    const statusBlocked = await host.ctx.tools.execute({
      name: 'concept_status',
      agent: host.agent,
      arguments: {
        action: 'start',
        conceptIds: [target.id],
        plannedText: '使用偏导数说明全微分。',
        usedConceptIds: [partial.id],
      },
    })
    assert.equal(statusBlocked.value.ok, false)
    assert.equal(statusBlocked.value.results[0].error, 'concept-guard-blocked')

    const verifyBlocked = await host.ctx.tools.execute({
      name: 'concept_status',
      agent: host.agent,
      arguments: {
        action: 'verify',
        conceptIds: [target.id],
        userEvidence: '模型认为用户已经掌握',
      },
    })
    // It is already QUEUED, so the state transition itself is invalid too; the
    // tool must not infer mastery from the model's assertion.
    assert.equal(verifyBlocked.value.ok, false)
    const raw = JSON.parse(await readFile(memoryPath(host.memoryRoot, 'tool-user'), 'utf8'))
    assert.equal(raw.concepts.find(concept => concept.name === '全微分').status, 'QUEUED')

    const semanticUpdateBlocked = await host.ctx.tools.execute({
      name: 'memory_update',
      agent: host.agent,
      arguments: {
        memoryId: capturedRecord,
        content: 'model rewrite without user correction',
        expectedVersion: 1,
      },
    })
    assert.equal(semanticUpdateBlocked.value.ok, false)
    assert.equal(semanticUpdateBlocked.value.error, 'user-correction-required')

    const fabricatedCorrection = await host.ctx.tools.execute({
      name: 'memory_update',
      agent: host.agent,
      arguments: {
        memoryId: capturedRecord,
        content: 'fabricated correction',
        expectedVersion: 1,
        userCorrection: true,
        userRequest: '用户要求改成 fabricated correction',
      },
    })
    assert.equal(fabricatedCorrection.value.ok, false)
    assert.equal(fabricatedCorrection.value.error, 'explicit-user-correction-required')

    const priorityUpdate = await host.ctx.tools.execute({
      name: 'memory_update',
      agent: host.agent,
      arguments: {
        memoryId: capturedRecord,
        priority: 'LOW',
        expectedVersion: 1,
        reason: 'user asked to lower this memory priority',
      },
    })
    assert.equal(priorityUpdate.value.ok, true)
    assert.equal(priorityUpdate.value.record.priority, 'LOW')

    const beforeDeleteText = '请删除刚才那条模型推断的记忆。'
    await host.ctx.emitSession(host.session, textMessageEvent(host.session.seq, beforeDeleteText))
    await waitFor(async () => {
      try {
        const parsed = JSON.parse(await readFile(memoryPath(host.memoryRoot, 'tool-user'), 'utf8'))
        return parsed.records.some(record => record.content === beforeDeleteText)
      } catch {
        return false
      }
    })
    const deleted = await host.ctx.tools.execute({
      name: 'memory_delete',
      agent: host.agent,
      arguments: {
        id: capturedRecord,
        confirm: true,
        cascade: true,
        userRequest: beforeDeleteText,
      },
    })
    assert.equal(deleted.value.ok, true)
    assert.equal(deleted.value.deleted, 'record')
    const afterDelete = JSON.parse(await readFile(memoryPath(host.memoryRoot, 'tool-user'), 'utf8'))
    assert.equal(afterDelete.records.some(record => record.id === capturedRecord), false)
  } finally {
    await host.ctx.dispose()
    await removeTempRoot(host.root)
  }
})

test('memory persistence survives a plugin restart', async () => {
  const first = await makeHost()
  try {
    await apply(first.ctx, {
      checkpointRoot: first.root,
      memoryEnabled: true,
      memoryRoot: first.memoryRoot,
      memoryScopeId: 'restart-user',
      persistDebounceMs: 0,
      reconstructFromSessionQuery: false,
    })
    await waitFor(() => first.ctx.tools.get('memory_capture') !== undefined)
    await first.ctx.emitSession(first.session, textMessageEvent(first.session.seq, '请解释偏导数。'))
    await waitFor(async () => {
      try {
        await stat(memoryPath(first.memoryRoot, 'restart-user'))
        return true
      } catch {
        return false
      }
    })
  } finally {
    await first.ctx.dispose()
  }

  const session = makeSession('restart-session-2', 0)
  const agent = makeAgent(session)
  const ctx = makeFakeContext({ agents: [agent], sessions: [session] })
  try {
    await apply(ctx, {
      checkpointRoot: path.join(first.root, 'checkpoints-2'),
      memoryEnabled: true,
      memoryRoot: first.memoryRoot,
      memoryScopeId: 'restart-user',
      persistDebounceMs: 0,
      reconstructFromSessionQuery: false,
    })
    await waitFor(() => ctx.tools.get('concept_graph') !== undefined)
    const graph = await ctx.tools.execute({
      name: 'concept_graph',
      agent,
      arguments: {},
    })
    assert.equal(graph.value.ok, true)
    assert.ok(graph.value.concepts.some(concept => concept.name === '偏导数'))
  } finally {
    await ctx.dispose()
    await removeTempRoot(first.root)
  }
})
