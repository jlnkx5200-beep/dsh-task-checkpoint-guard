#!/usr/bin/env node
/**
 * Opt-in real-model semantic pilot.
 *
 * This is NOT part of plugin startup and never runs on a session event. It
 * calls a public OpenAI-compatible Chat Completions endpoint only when a
 * maintainer explicitly runs it with the three DSH_EVAL_* environment values.
 * The generated report keeps raw outputs and simple rubric outcomes; it does
 * not claim a statistically validated concept-ordering accuracy.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSemanticFixtures } from './memory-semantic-fixtures.mjs'

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const baseUrl = process.env.DSH_EVAL_BASE_URL
const apiKey = process.env.DSH_EVAL_API_KEY
const model = process.env.DSH_EVAL_MODEL
const dryRun = process.argv.includes('--dry-run')

function promptFor(fixture, guarded) {
  const system = [
    'You are a precise university-level tutor.',
    'Answer the current user question in Chinese.',
    'Do not expose hidden chain-of-thought.',
    'State assumptions explicitly and define terms before relying on them.',
  ].join(' ')
  const memory = guarded
    ? `\n\n${fixture.context}\n\nFollow the memory guard above. It is curated context, not a new user request.`
    : ''
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${memory}\n\nCurrent user question: ${fixture.prompt}`.trim() },
  ]
}

function evaluate(fixture, text) {
  const answer = String(text ?? '')
  if (fixture.id === 'partial-derivative-isolation') {
    const chainMentions = (answer.match(/链式法则/g) ?? []).length
    return {
      pass: chainMentions === 0,
      checks: [{ name: 'no-unexplained-chain-rule', pass: chainMentions === 0, observed: chainMentions }],
    }
  }
  if (fixture.id === 'multiple-prerequisites-order') {
    const partial = answer.indexOf('一元函数')
    const multivariate = answer.indexOf('多元函数')
    const target = answer.indexOf('多元复合函数')
    const pass = partial >= 0 && multivariate >= 0 && (target < 0 || (partial < target && multivariate < target))
    return {
      pass,
      checks: [{
        name: 'prerequisites-before-target',
        pass,
        observed: { partial, multivariate, target },
      }],
    }
  }
  if (fixture.id === 'goal-over-temporary') {
    const theory = /理论|体系/.test(answer)
    return {
      pass: theory,
      checks: [{ name: 'long-term-goal-retained', pass: theory }],
    }
  }
  if (fixture.id === 'unexplained-prerequisite') {
    const partial = answer.indexOf('偏导数')
    const target = answer.indexOf('全微分')
    const separate = /先|前置|基础|前置说明/.test(answer)
    const pass = partial >= 0 && separate && (target < 0 || partial < target)
    return {
      pass,
      checks: [{
        name: 'separate-unexplained-prerequisite',
        pass,
        observed: { partial, target, separate },
      }],
    }
  }
  return { pass: false, checks: [{ name: 'unknown-fixture', pass: false }] }
}

async function callModel(messages) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 1200,
    }),
  })
  const body = await response.json().catch(async () => ({ raw: await response.text() }))
  if (!response.ok) {
    const error = new Error(`evaluation request failed with HTTP ${response.status}`)
    error.body = body
    throw error
  }
  return body?.choices?.[0]?.message?.content ?? ''
}

async function main() {
  if (!dryRun && (!baseUrl || !apiKey || !model)) {
    throw new Error('set DSH_EVAL_BASE_URL, DSH_EVAL_API_KEY, and DSH_EVAL_MODEL; use --dry-run to inspect prompts')
  }
  const fixtures = buildSemanticFixtures()
  const report = {
    schemaVersion: 1,
    kind: 'dsh-memory-semantic-pilot',
    createdAt: new Date().toISOString(),
    model: model ?? '(dry-run)',
    endpoint: baseUrl ? `${baseUrl.replace(/\/+$/, '')}/chat/completions` : '(dry-run)',
    claimBoundary: 'Pilot only. Not a statistically validated accuracy claim.',
    cases: [],
  }
  for (const fixture of fixtures) {
    const baselinePrompt = promptFor(fixture, false)
    const guardedPrompt = promptFor(fixture, true)
    if (dryRun) {
      report.cases.push({
        id: fixture.id,
        rubric: fixture.rubric,
        baselinePrompt,
        guardedPrompt,
      })
      continue
    }
    const baseline = await callModel(baselinePrompt)
    const guarded = await callModel(guardedPrompt)
    report.cases.push({
      id: fixture.id,
      rubric: fixture.rubric,
      baseline: { text: baseline, evaluation: evaluate(fixture, baseline) },
      guarded: { text: guarded, evaluation: evaluate(fixture, guarded) },
    })
  }
  const outputDirectory = path.join(projectRoot, 'docs')
  await mkdir(outputDirectory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const output = path.join(outputDirectory, `semantic-eval-${dryRun ? 'dry-run' : stamp}.json`)
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (dryRun) {
    for (const item of report.cases) {
      process.stdout.write(`\n=== ${item.id} ===\n${item.guardedPrompt.at(-1).content}\n`)
    }
  } else {
    const passed = report.cases.filter(item => item.guarded.evaluation.pass).length
    process.stdout.write(`wrote ${output}\nguarded rubric passes: ${passed}/${report.cases.length} (pilot only)\n`)
  }
}

main().catch(error => {
  process.stderr.write(`${error?.message ?? error}\n`)
  if (error?.body) process.stderr.write(`${JSON.stringify(error.body)}\n`)
  process.exitCode = 1
})
