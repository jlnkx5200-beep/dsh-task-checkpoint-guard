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
  assert.equal(manifest.version, '0.1.0')
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
  const files = await readdir(sourceDirectory)
  for (const file of files.filter(item => item.endsWith('.js'))) {
    const text = await readFile(path.join(sourceDirectory, file), 'utf8')
    assert.doesNotMatch(text, /from ['"]@deepseek-ai\//, `${file} must not import a DSH package`)
    assert.doesNotMatch(text, /from ['"].*\/src\//, `${file} must not import private source paths`)
    assert.doesNotMatch(text, /snapshotEvents\s*\(/, `${file} must not use the deprecated snapshotEvents API`)
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
