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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSemanticFixtures } from './memory-semantic-fixtures.mjs'

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const baseUrl = process.env.DSH_EVAL_BASE_URL
const apiKey = process.env.DSH_EVAL_API_KEY
const model = process.env.DSH_EVAL_MODEL
const dryRun = process.argv.includes('--dry-run')
const rescoreIndex = process.argv.indexOf('--rescore')
const RUBRIC_VERSION = 2

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
    const prerequisiteSection = answer.search(/(?:必要前置|前置[一二1-9]?[:：]|先说明.{0,12}前置|先各给.{0,12}前置)/u)
    const targetSection = answer.search(/(?:正题[:：]|正式讲解|目标概念[:：])/u)
    const pass = partial >= 0
      && multivariate >= 0
      && prerequisiteSection >= 0
      && targetSection > prerequisiteSection
    return {
      pass,
      checks: [{
        name: 'separate-prerequisite-sections-before-formal-target',
        pass,
        observed: { partial, multivariate, prerequisiteSection, targetSection },
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
    const prerequisiteSection = answer.search(
      /(?:先说明前提|先单独讲|前置概念|前置一|必要前置)/u,
    )
    const targetSection = answer.search(
      /(?:^|\n)#{1,3}\s*(?:二|2)[\.、:]?\s*全微分|(?:^|\n)#{1,3}\s*正式讲解/u,
    )
    const separate = prerequisiteSection >= 0
      && targetSection > prerequisiteSection
      && partial >= 0
      && target >= 0
    return {
      pass: separate,
      checks: [{
        name: 'separate-unexplained-prerequisite',
        pass: separate,
        observed: { partial, target, prerequisiteSection, targetSection, separate },
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
      // Reasoning-capable providers may spend most of this budget internally
      // before emitting visible content. Keep the visible answer budget high
      // enough that an empty content string is treated as a failed sample, not
      // as a semantic result.
      max_tokens: 4096,
    }),
  })
  const body = await response.json().catch(async () => ({ raw: await response.text() }))
  if (!response.ok) {
    const error = new Error(`evaluation request failed with HTTP ${response.status}`)
    error.body = body
    throw error
  }
  const choice = body?.choices?.[0]
  const message = choice?.message ?? {}
  return {
    text: typeof message.content === 'string' ? message.content : '',
    meta: {
      finishReason: choice?.finish_reason ?? null,
      contentLength: typeof message.content === 'string' ? message.content.length : 0,
      // Never persist reasoning text. A length is enough to diagnose budget
      // exhaustion without retaining hidden chain-of-thought.
      reasoningContentLength: typeof message.reasoning_content === 'string'
        ? message.reasoning_content.length
        : 0,
      usage: body?.usage ?? null,
    },
  }
}

async function callModelWithRetry(messages) {
  let last
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = await callModel(messages)
    if (last.text.trim().length > 0) return last
    last.meta.attempt = attempt
  }
  return last
}

async function main() {
  if (rescoreIndex >= 0) {
    const inputPath = process.argv[rescoreIndex + 1]
    if (typeof inputPath !== 'string' || inputPath.length === 0) {
      throw new Error('usage: memory-semantic-eval.mjs --rescore <report.json>')
    }
    const report = JSON.parse(await readFile(inputPath, 'utf8'))
    if (report?.kind !== 'dsh-memory-semantic-pilot' || !Array.isArray(report.cases)) {
      throw new Error('input is not a dsh-memory-semantic-pilot report')
    }
    const fixtureById = new Map(buildSemanticFixtures().map(fixture => [fixture.id, fixture]))
    for (const item of report.cases) {
      const fixture = fixtureById.get(item.id)
      if (fixture === undefined) continue
      if (item.baseline?.text !== undefined) {
        item.baseline.evaluation = evaluate(fixture, item.baseline.text)
      }
      if (item.guarded?.text !== undefined) {
        item.guarded.evaluation = evaluate(fixture, item.guarded.text)
      }
    }
    report.rubricVersion = RUBRIC_VERSION
    report.rescoredAt = new Date().toISOString()
    report.summary = {
      baselinePasses: report.cases.filter(item => item.baseline?.evaluation?.pass === true).length,
      guardedPasses: report.cases.filter(item => item.guarded?.evaluation?.pass === true).length,
      totalCases: report.cases.length,
    }
    const outputDirectory = path.join(projectRoot, 'docs')
    await mkdir(outputDirectory, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const output = path.join(outputDirectory, `semantic-eval-rescored-${stamp}.json`)
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(
      `wrote ${output}\nbaseline rubric passes: ${report.summary.baselinePasses}/${report.summary.totalCases}\n`
      + `guarded rubric passes: ${report.summary.guardedPasses}/${report.summary.totalCases} (pilot only)\n`,
    )
    return
  }
  if (!dryRun && (!baseUrl || !apiKey || !model)) {
    throw new Error('set DSH_EVAL_BASE_URL, DSH_EVAL_API_KEY, and DSH_EVAL_MODEL; use --dry-run to inspect prompts')
  }
  const fixtures = buildSemanticFixtures()
  const report = {
    schemaVersion: 1,
    kind: 'dsh-memory-semantic-pilot',
    rubricVersion: RUBRIC_VERSION,
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
    const baseline = await callModelWithRetry(baselinePrompt)
    const guarded = await callModelWithRetry(guardedPrompt)
    report.cases.push({
      id: fixture.id,
      rubric: fixture.rubric,
      baseline: {
        text: baseline.text,
        meta: baseline.meta,
        evaluation: evaluate(fixture, baseline.text),
      },
      guarded: {
        text: guarded.text,
        meta: guarded.meta,
        evaluation: evaluate(fixture, guarded.text),
      },
    })
  }
  if (!dryRun) {
    report.summary = {
      baselinePasses: report.cases.filter(item => item.baseline?.evaluation?.pass === true).length,
      guardedPasses: report.cases.filter(item => item.guarded?.evaluation?.pass === true).length,
      totalCases: report.cases.length,
    }
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
