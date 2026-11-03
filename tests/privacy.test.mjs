import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalJson,
  reasoningFacts,
  redact,
  redactHomePath,
  redactJson,
  toolFingerprint,
  visibleText,
} from '../src/redact.js'

test('shape-based redaction removes common credentials', () => {
  const samples = [
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'api_key=sk-live-abcdefghijklmnop',
    'https://user:password@example.test/health',
    'github token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456',
    '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
  ]
  for (const sample of samples) {
    const output = redact(sample)
    assert.doesNotMatch(output, /password|sk-live|ghp_|eyJhbGci|BEGIN PRIVATE KEY/)
    assert.match(output, /redacted/i)
  }
})

test('redactJson replaces secret-looking keys regardless of value shape', () => {
  const output = redactJson({
    apiKey: 'short',
    nested: { access_token: ['a', 'b'], note: 'Bearer secret-token-1234567890' },
    authorization: { scheme: 'Bearer', value: 'secret' },
    tokenUsage: { input: 12, output: 5 },
  })
  assert.equal(output.apiKey, '<redacted>')
  assert.deepEqual(output.nested.access_token, '<redacted>')
  assert.match(output.nested.note, /redacted/i)
  assert.equal(output.authorization, '<redacted>')
  assert.deepEqual(output.tokenUsage, { input: 12, output: 5 })
})

test('redaction bounds large values and handles cycles safely', () => {
  assert.match(redact('x'.repeat(100), 20), /chars omitted/)
  const value = { name: 'cycle' }
  value.self = value
  const output = redactJson(value)
  assert.equal(output.self, '<circular>')
})

test('visibleText ignores reasoning and image payloads', () => {
  const content = [
    { type: 'text', text: 'visible answer' },
    { type: 'reasoning', text: 'HIDDEN CHAIN OF THOUGHT MUST NOT PERSIST' },
    { type: 'image', data: 'base64-secret' },
  ]
  assert.equal(visibleText(content), 'visible answer')
  assert.deepEqual(reasoningFacts(content), { blocks: 1, chars: 40 })
})

test('canonical JSON and tool fingerprints are order-independent', () => {
  const a = { z: 1, a: { y: 2, x: [1, 2] } }
  const b = { a: { x: [1, 2], y: 2 }, z: 1 }
  assert.equal(canonicalJson(a), canonicalJson(b))
  assert.equal(toolFingerprint('shell', a), toolFingerprint('shell', b))
  assert.notEqual(toolFingerprint('shell', a), toolFingerprint('other', a))
})

test('home directory prefixes are hidden in diagnostic strings', () => {
  const home = process.env.HOME || process.env.USERPROFILE
  if (home) {
    const output = redactHomePath(`failed at ${home}${process.platform === 'win32' ? '\\secret' : '/secret'}`)
    assert.match(output, /<home>/)
  }
})
