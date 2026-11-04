import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply, Config, inject, name } from '../src/index.js'
import { makeSession, makeTempRoot, removeTempRoot } from './helpers.mjs'

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

test('plugin module exposes the Cordis plugin surface', () => {
  assert.equal(name, 'task-checkpoint-guard')
  assert.deepEqual(inject, ['agents', 'sessions'])
  assert.equal(typeof apply, 'function')
  assert.equal(Config['~standard'].version, 1)
  assert.equal(typeof Config['~standard'].validate, 'function')
})

test('package manifest, bundle patch, and published entry points agree', async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-task-checkpoint-guard')
  assert.equal(manifest.version, '0.2.0')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'src/index.js')
  assert.equal(manifest.exports['.'], './src/index.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.engines.node, '^22.19.0 || >=24.0.0')
  assert.match(manifest.engines.dsh, /0\.2\.1-rc\.3/)
  await readFile(path.join(projectRoot, manifest.main), 'utf8')
  const patch = await readFile(path.join(projectRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: task-checkpoint-guard/)
  assert.match(patch, /name: dsh-task-checkpoint-guard/)
})

test('source tree uses no DSH package imports, private source paths, or deprecated session readers', async () => {
  const sourceDirectory = path.join(projectRoot, 'src')
  async function listJsFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) files.push(...await listJsFiles(full))
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full)
    }
    return files
  }
  const files = await listJsFiles(sourceDirectory)
  assert.ok(files.some(file => file.includes(`${path.sep}memory-curation${path.sep}`)))
  assert.ok(files.some(file => file.includes(`${path.sep}concept-guard${path.sep}`)))
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    const label = path.relative(sourceDirectory, file)
    assert.doesNotMatch(text, /from ['"]@deepseek-ai\//, `${label} must not import a DSH package`)
    assert.doesNotMatch(text, /from ['"].*\/src\//, `${label} must not import private source paths`)
    assert.doesNotMatch(text, /snapshotEvents\s*\(/, `${label} must not use the deprecated snapshotEvents API`)
    assert.doesNotMatch(text, /C:[\\/]Users[\\/]/i)
    assert.doesNotMatch(text, /probeUrl\s*:\s*['"]https?:\/\//i)
    assert.doesNotMatch(text, /credentialRef\s*:\s*['"][A-Za-z0-9_]+['"]/)
  }
})

const checkout = process.env.DSH_CHECKOUT
test('loads through the real Cordis plugin loader when DSH_CHECKOUT is available', {
  skip: !checkout,
}, async () => {
  const root = await makeTempRoot()
  const session = makeSession('loader-session', 0)
  const contextEntry = await import(
    pathToFileURL(path.join(checkout, 'vendor', 'cordis', 'lib', 'index.js')).href
  )
  const { Context } = contextEntry
  const ctx = new Context()
  const providedAgents = {
    list: () => [],
    get: () => undefined,
  }
  const providedSessions = {
    list: () => [session],
  }
  let fiber
  try {
    ctx.provide('agents', providedAgents)
    ctx.provide('sessions', providedSessions)
    ctx.provide('dshHomePath', root)
    const plugin = await import('../src/index.js')
    fiber = ctx.plugin(plugin, {
      recoveryMode: 'off',
      persistDebounceMs: 0,
      reconstructFromSessionQuery: false,
    })
    await fiber
    assert.equal(ctx.registry.has(plugin), true)
  } finally {
    await fiber?.dispose?.()
    await removeTempRoot(root)
  }
})

test('real DSH ToolRuntime validates the memory tool JSON schemas and executes a canonical result', {
  skip: !checkout,
}, async () => {
  const root = await makeTempRoot('dsh-memory-toolruntime-')
  const contextEntry = await import(
    pathToFileURL(path.join(checkout, 'vendor', 'cordis', 'lib', 'index.js')).href
  )
  const toolsEntry = await import(
    pathToFileURL(path.join(checkout, 'packages', 'core', 'tools', 'lib', 'index.js')).href
  )
  const promptEntry = await import(
    pathToFileURL(path.join(checkout, 'packages', 'core', 'system-prompt', 'lib', 'index.js')).href
  )
  const { Context } = contextEntry
  const ctx = new Context()
  let fiber
  try {
    await ctx.plugin(promptEntry.default ?? promptEntry)
    await ctx.plugin(toolsEntry.default ?? toolsEntry)
    ctx.provide('agents', { list: () => [], get: () => undefined })
    ctx.provide('sessions', { list: () => [] })
    ctx.provide('dshHomePath', root)
    const plugin = await import('../src/index.js')
    fiber = ctx.plugin(plugin, {
      recoveryMode: 'off',
      persistDebounceMs: 0,
      reconstructFromSessionQuery: false,
      memoryEnabled: true,
      memoryRoot: path.join(root, 'memory'),
      memoryScopeId: 'toolruntime-user',
    })
    await fiber

    assert.deepEqual(
      ctx.tools.schemas().map(schema => schema.name).sort(),
      ['concept_graph', 'concept_status', 'memory_capture', 'memory_delete', 'memory_search', 'memory_update'],
    )
    const signal = new AbortController().signal
    const captured = await ctx.tools.execute({
      callId: 'memory-capture-1',
      name: 'memory_capture',
      arguments: {
        sourceKind: 'MODEL_INFERRED',
        items: [{
          content: '请解释偏导数，并解释链式法则。',
          topic: '偏导数',
          layer: 'L1',
          priority: 'HIGH',
          intent: 'question',
          relatedConcepts: ['偏导数'],
        }],
      },
      signal,
    })
    assert.equal(captured.isError, false)
    assert.equal(captured.value.ok, true)
    const searched = await ctx.tools.execute({
      callId: 'memory-search-1',
      name: 'memory_search',
      arguments: { query: '偏导数' },
      signal,
    })
    assert.equal(searched.isError, false)
    assert.equal(searched.value.ok, true)
    assert.ok(searched.value.records.some(record => record.content.includes('偏导数')))
  } finally {
    await fiber?.dispose?.()
    await removeTempRoot(root)
  }
})

test('real Cordis loader accepts the opt-in memory tools and prompt section', {
  skip: !checkout,
}, async () => {
  const root = await makeTempRoot('dsh-memory-loader-')
  const session = makeSession('memory-loader-session', 0)
  const contextEntry = await import(
    pathToFileURL(path.join(checkout, 'vendor', 'cordis', 'lib', 'index.js')).href
  )
  const { Context } = contextEntry
  const ctx = new Context()
  const toolNames = []
  const sections = new Map()
  const providedTools = {
    register(definition) {
      toolNames.push(definition.name)
      return () => {
        const index = toolNames.indexOf(definition.name)
        if (index >= 0) toolNames.splice(index, 1)
      }
    },
  }
  const providedSystemPrompt = {
    getSectionOrder: () => 9900,
    section(spec) {
      sections.set(spec.name, spec)
      return () => sections.delete(spec.name)
    },
  }
  let fiber
  try {
    ctx.provide('agents', { list: () => [], get: () => undefined })
    ctx.provide('sessions', { list: () => [session] })
    ctx.provide('dshHomePath', root)
    ctx.provide('tools', providedTools)
    ctx.provide('systemPrompt', providedSystemPrompt)
    const plugin = await import('../src/index.js')
    fiber = ctx.plugin(plugin, {
      recoveryMode: 'off',
      persistDebounceMs: 0,
      reconstructFromSessionQuery: false,
      memoryEnabled: true,
      memoryRoot: path.join(root, 'memory'),
      memoryScopeId: 'loader-user',
    })
    await fiber
    assert.deepEqual(
      toolNames.sort(),
      ['concept_graph', 'concept_status', 'memory_capture', 'memory_delete', 'memory_search', 'memory_update'],
    )
    assert.equal(sections.has('memory:curated'), true)
  } finally {
    await fiber?.dispose?.()
    await removeTempRoot(root)
  }
})
