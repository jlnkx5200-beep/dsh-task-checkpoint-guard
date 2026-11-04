/**
 * Feasibility labels are independent from priority and confidence.
 *
 * An infeasible item is retained with a reason. It is never treated as deleted
 * and never promoted to READY without new evidence.
 */
import { FEASIBILITIES } from './schema.js'

const SET = new Set(FEASIBILITIES)

export function isFeasibility(value) {
  return SET.has(value)
}

const OUT_OF_SCOPE = /(?:超出|不在|不属于).{0,12}(?:范围|任务|主题)|(?:以后|之后|下次|暂时).{0,8}(?:再说|再讲|不管)|out[\s-]?of[\s-]?scope/i
const BLOCKED = /(?:无法|不能|没有办法|缺少|没有).{0,16}(?:权限|资料|工具|环境|依赖|依据)|blocked|cannot proceed/i
const UNCLEAR = /^(?:这个|那个|它|继续|然后|还有呢|再说|再讲)[？?。.!！\s]*$/i
const NEEDS_PREREQUISITE = /(?:先修|前置|基础|需要先|依赖|以.{1,30}为基础|before (?:this|that).{0,20}(?:learn|know))/i

/**
 * @param {object} input candidate data
 * @param {Array<object>} prerequisites resolved prerequisite concepts
 * @returns {{feasibility: string, reason: string|null}}
 */
export function assessFeasibility(input, prerequisites = []) {
  const content = String(input?.content ?? '').trim()
  if (content.length === 0 || content.length < 2 || UNCLEAR.test(content)) {
    return {
      feasibility: 'NEEDS_CLARIFICATION',
      reason: 'The captured item does not yet identify an actionable question or concept.',
    }
  }
  if (input?.outOfScope === true || OUT_OF_SCOPE.test(content)) {
    return {
      feasibility: 'OUT_OF_SCOPE',
      reason: 'The item is explicitly outside the current task scope; it is retained for later review.',
    }
  }
  if (input?.blocked === true || BLOCKED.test(content)) {
    return {
      feasibility: 'BLOCKED',
      reason: 'The item records a concrete missing capability, evidence, or environment condition.',
    }
  }
  const unresolved = prerequisites.filter(concept => (
    concept !== undefined
    && !['EXPLAINED', 'VERIFIED'].includes(concept.status)
  ))
  if (unresolved.length > 0 || input?.requiresPrerequisite === true || NEEDS_PREREQUISITE.test(content)) {
    return {
      feasibility: 'NEEDS_PREREQUISITE',
      reason: unresolved.length > 0
        ? `Requires prerequisite explanation: ${unresolved.map(concept => concept.name).join(', ')}`
        : 'A prerequisite was declared or implied but has not been resolved.',
    }
  }
  return { feasibility: 'READY', reason: null }
}

export function refreshFeasibility(record, prerequisites = []) {
  const result = assessFeasibility(record, prerequisites)
  record.feasibility = result.feasibility
  record.feasibilityReason = result.reason
  return record
}
