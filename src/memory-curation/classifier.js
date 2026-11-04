/**
 * Deterministic semantic classification for local capture.
 *
 * This is intentionally not a keyword-only bag: intent, temporal scope,
 * explicit enumeration, user hedging, and dependency phrasing are combined.
 * A model can supply richer structure through memory_capture, but the automatic
 * session-event path never spends an API call.
 */
import { assessFeasibility } from './feasibility.js'
import { redact } from '../redact.js'

const GENERIC_TAILS = new Set([
  '概念', '定义', '含义', '意义', '几何意义', '原理', '公式', '法则', '定理',
  '区别', '关系', '推导', '证明', '例题', '应用', '技巧', '步骤', '计算方法',
])
const CONCEPT_CHARS = /[\p{Script=Han}A-Za-z0-9_（）()·\-+\s]/u
const HEDGE = /(?:可能|也许|大概|或许|似乎|不确定|不太确定|可能吧|maybe|perhaps|not sure)/i
const CORRECTION = /(?:不是|而是|纠正|更正|改正|改一下|改成|改为|其实|准确地说|之前(?:说|写|讲)的.{0,20}(?:不|错|过时)|correction|correct that)/i
const LONG_TERM = /(?:长期|深入|系统|理论体系|一直|以后|今后|最终目标|学习方向|偏好|更注重|更看重|目标|希望|想要|打算|长期目标|long[\s-]?term|prefer|goal|objective)/i
const CONSTRAINT = /(?:必须|不允许|不得|不能|不要|只能|限制|约束|核心要求|不要改变|不能改变|must|never|only|constraint)/i
const STRONG_QUESTION = /^(?:请|麻烦|帮我|给我)?\s*(?:解释|说明|介绍|讲解|什么是|何为|如何|为什么|怎么|怎样)/u
const TEMPORARY = /(?:这道题|本题|这次|此刻|现在先|暂时|先直接|只需要|就给我|一次性|临时|for this (?:task|question)|right now)/i
const PREREQUISITE = /(?:先修|前置|基础|需要先|依赖|以.{1,40}为基础|prerequisite|before (?:this|that))/i
const DETAIL = /(?:证明|推导|例题|案例|应用|计算|技巧|步骤|公式|展开|supplementary|example|derivation|application)/i
const QUESTION = /(?:[?？]|什么是|何为|为什么|如何|怎么|怎样|解释|说明|介绍|讲解|区别|关系|概念|含义|意义|请讲讲|请说明|what|why|how)/i
const EXPLORATORY = /(?:顺便|可选|拓展|延伸|额外|好奇|也可以|optional|bonus|explore)/i
const OUT_OF_SCOPE = /(?:超出|不在|不属于).{0,12}(?:范围|任务|主题)|(?:以后|之后|下次|暂时).{0,8}(?:再说|再讲|不管)/i
const BLOCKED = /(?:无法|不能|没有办法|缺少|没有).{0,16}(?:权限|资料|工具|环境|依赖|依据)/i

const PREFIXES = /^(?:请|麻烦|帮我|给我|我想知道|我想了解|我想问|我想问一下|请问|问一下|解释一下|解释|说明一下|说明|介绍一下|介绍|讲解一下|讲解|告诉我|什么是|何为|如何理解|怎么理解)\s*/i

function truncate(value, max) {
  const text = String(value ?? '').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Keep all user-visible semantics while bounding one stored field. */
export function boundedText(value, max = 2000) {
  return redact(String(value ?? '').trim(), max)
}

export function hasHedge(text) {
  return HEDGE.test(String(text))
}

export function detectIntent(rawText) {
  const input = String(rawText ?? '')
  if (CORRECTION.test(input)) return 'correction'
  if (TEMPORARY.test(input) && !LONG_TERM.test(input)) return 'temporary_request'
  if (LONG_TERM.test(input)) return 'goal'
  if (CONSTRAINT.test(input)) return 'constraint'
  if (STRONG_QUESTION.test(input)) return 'question'
  if (PREREQUISITE.test(input)) return 'prerequisite'
  if (DETAIL.test(input) && !QUESTION.test(input)) return 'detail'
  if (QUESTION.test(input)) return 'question'
  return 'statement'
}

export function temporalScopeFor(intent, text) {
  if (intent === 'goal' || intent === 'constraint') return 'long_term'
  if (intent === 'temporary_request') return 'temporary'
  if (TEMPORARY.test(String(text ?? ''))) return 'temporary'
  return 'task'
}

export function layerForIntent(intent, concepts = []) {
  if (intent === 'goal' || intent === 'constraint') return 'L0'
  if (intent === 'prerequisite') return 'L2'
  if (intent === 'detail' || intent === 'temporary_request') return 'L3'
  if (intent === 'question' || concepts.length > 0) return 'L1'
  return 'L3'
}

export function priorityForIntent(intent, layer, text) {
  if (layer === 'L0') return 'CRITICAL'
  if (intent === 'question' || intent === 'temporary_request' || intent === 'correction') return 'HIGH'
  if (layer === 'L1') return 'HIGH'
  if (EXPLORATORY.test(String(text ?? ''))) return 'LOW'
  return 'NORMAL'
}

export function confidenceForUserText(text) {
  return hasHedge(text) ? 'UNCERTAIN' : 'EXPLICIT'
}

/** Stable topic hints for preference/goal statements without a concept name. */
export function inferTopic(content) {
  const input = String(content ?? '')
  if (/(?:学习|偏好|更注重|更看重|喜欢|倾向).{0,20}(?:理论|推导|例题|技巧|刷题|应用|证明)/u.test(input)
    || /(?:理论|推导|例题|技巧|刷题|应用|证明).{0,20}(?:学习|偏好|更喜欢)/u.test(input)) {
    return '学习偏好'
  }
  if (/(?:目标|希望|想要|计划|最终目的|学习方向|深入理解)/u.test(input)) return '长期目标'
  if (/(?:约束|必须|不允许|不得|不能|不要|只能)/u.test(input)) return '核心约束'
  if (/(?:这道题|本题|这次|当前任务|临时)/u.test(input)) return '当前任务细节'
  return truncate(input, 80)
}

/**
 * Split a human message at durable semantic boundaries: paragraphs, numbered
 * or bulleted items, sentence terminators, and explicit "explain A, then B"
 * connectors. The result is conservative; no text is intentionally dropped.
 */
export function splitUserMessage(rawText) {
  const input = String(rawText ?? '').replace(/\r\n?/g, '\n').trim()
  if (input.length === 0) return []
  const fragments = []
  const lines = input.split('\n')
  let paragraph = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const text = paragraph.join('\n').trim()
    paragraph = []
    if (text.length === 0) return
    for (const sentence of text.split(/(?<=[。！？!?；;])|\n{2,}/u)) {
      const trimmed = sentence.trim()
      if (trimmed.length === 0) continue
      const parts = trimmed.split(/(?:[，,]\s*)?(?:以及|还有|同时|另外|然后|并且|并(?=\s*(?:请|解释|说明|介绍|讲|给)))\s*/u)
      for (const part of parts) {
        const candidate = part.trim()
        if (candidate.length > 0) fragments.push(candidate)
      }
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      flushParagraph()
      continue
    }
    if (/^(?:\d+[.)、]|[-*•])\s+/.test(trimmed)) {
      flushParagraph()
      fragments.push(trimmed.replace(/^(?:\d+[.)、]|[-*•])\s+/, '').trim())
    } else {
      paragraph.push(trimmed)
    }
  }
  flushParagraph()
  return fragments.filter(Boolean)
}

const DESCRIPTOR_SUFFIX =
  /(?:的)?(?:概念|定义|含义|意义|几何意义|原理|推导|证明|例题|应用|区别|关系|技巧|步骤|方法|计算方法)(?:与(?:概念|定义|含义|意义|几何意义|原理|推导|证明|例题|应用|区别|关系|技巧|步骤|方法|计算方法))*$/u

function stripDescriptorSuffix(value) {
  let current = String(value ?? '').trim()
  let previous
  do {
    previous = current
    current = current.replace(DESCRIPTOR_SUFFIX, '').trim()
  } while (current !== previous)
  return current
}

function cleanConcept(raw) {
  let value = String(raw ?? '')
    .replace(PREFIXES, '')
    .replace(/^(?:关于|对于|有关)\s*/u, '')
    .replace(/^(?:的|之)\s*/u, '')
    .replace(/[。！？!?；;，,：:\s]+$/u, '')
    .trim()
  value = stripDescriptorSuffix(value)
  if (value.length < 2 || value.length > 60) return null
  if (GENERIC_TAILS.has(value)) return null
  if (!CONCEPT_CHARS.test(value)) return null
  // Reject sentence predicates that a greedy suffix regex can otherwise
  // swallow as one enormous "concept".
  if (/(?:需要|先|掌握|理解|解释|说明|介绍|学习|研究|如何|为什么|什么|然后|以及|并且|还是|就是|称为|叫做)/u.test(value)) {
    return null
  }
  if (/^(?:这个|那个|它|这些|那些|上述|上述问题|问题|内容|东西|方面)$/u.test(value)) return null
  if (/^(?:请|麻烦|帮我|给我|解释|说明|介绍|讲解|什么|如何|为什么|怎么)/u.test(value)) return null
  return value
}

/** Split an explicit concept list without guessing relationships. */
export function splitConceptList(raw) {
  const value = String(raw ?? '').trim()
  if (value.length === 0) return []
  const parts = value.split(/\s*(?:、|以及|和|与|,|，)\s*/u)
  const result = []
  for (const part of parts) {
    const cleaned = cleanConcept(part)
    if (cleaned !== null) result.push(cleaned)
  }
  return [...new Set(result)]
}

/**
 * Extract concept mentions from one fragment.
 *
 * Known concepts (from the existing graph) are recognized through their names
 * and aliases first. Unknown phrases must be anchored by a question/definition
 * marker, a concept suffix, or an explicit list. Co-occurrence alone does not
 * establish a dependency.
 */
export function extractConceptCandidates(rawText, knownConcepts = []) {
  const input = String(rawText ?? '').trim()
  if (input.length === 0) return []
  const found = []
  const add = value => {
    const cleaned = cleanConcept(value)
    if (cleaned !== null && !found.includes(cleaned)) found.push(cleaned)
  }

  for (const concept of knownConcepts) {
    const names = [concept?.name, ...(Array.isArray(concept?.aliases) ? concept.aliases : [])]
    for (const name of names) {
      if (typeof name !== 'string' || name.trim().length === 0) continue
      if (input.toLowerCase().includes(name.toLowerCase())) add(concept.name)
    }
  }

  const questionPatterns = [
    /(?:什么是|何为|如何理解|怎么理解|解释(?:一下)?|说明(?:一下)?|介绍(?:一下)?|讲解(?:一下)?|说说|讲讲)\s*([^。！？!?；;，,：:]{2,80})/gu,
  ]
  for (const pattern of questionPatterns) {
    for (const match of input.matchAll(pattern)) {
      const phrase = stripDescriptorSuffix(match[1]?.trim() ?? '')
      if (phrase.length === 0) continue
      const list = splitConceptList(phrase)
      if (list.length > 1) {
        for (const item of list) add(item)
      } else {
        add(phrase)
      }
    }
  }
  // A study/understand verb is a concept anchor only at the start of the
  // fragment. Matching it anywhere would turn dependency prose into a concept.
  const studyAnchor = input.match(/^(?:了解|学习|理解|掌握|研究)\s*([^。！？!?；;，,：:]{2,80})/u)
  if (studyAnchor) {
    for (const item of splitConceptList(stripDescriptorSuffix(studyAnchor[1].trim()))) add(item)
  }

  const suffixPattern = /([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_·（）()+\-]{1,28}(?:导数|微分|积分|函数|法则|定理|公式|矩阵|向量|方程|分布|变换|空间|级数))/gu
  for (const match of input.matchAll(suffixPattern)) add(match[1])

  if (found.length === 0) {
    const stripped = input.replace(PREFIXES, '').trim()
    const words = splitConceptList(stripped)
    if (words.length > 1) {
      for (const word of words) add(word)
    } else if (stripped.length <= 40 && /(?:概念|定义|法则|定理|函数|导数|微分)/u.test(stripped)) {
      add(stripped)
    }
  }

  return found.slice(0, 12)
}

/**
 * Extract only explicitly phrased prerequisite relationships. A missing or
 * uncertain phrase yields no edge; co-occurrence is never enough.
 */
export function extractDependencyHints(rawText) {
  const input = String(rawText ?? '').trim()
  const hints = []
  const primaryClause = input.split(/[，,。！？!?；;]/u)[0] ?? ''
  const primaryTargets = extractConceptCandidates(primaryClause)
  const cleanDependencyTarget = raw => {
    let value = String(raw ?? '')
      .replace(/^(?:理解|学习|掌握|解释|研究)\s*/u, '')
      .replace(/需\s*$/u, '')
      .trim()
    if (value.length < 2 || /^(?:它|这个|那个|该概念|上述概念|其)$/u.test(value)) {
      return primaryTargets[0] === undefined ? [] : [primaryTargets[0]]
    }
    return splitConceptList(value)
  }
  const add = (fromText, toText) => {
    const from = splitConceptList(fromText)
    const to = cleanDependencyTarget(toText)
    if (from.length === 0 || to.length === 0) return
    for (const toName of to) {
      for (const fromName of from) {
        if (fromName === toName) continue
        hints.push({ from: fromName, to: toName, evidence: truncate(input, 300), confidence: 'EXPLICIT' })
      }
    }
  }

  let match = input.match(/(?:理解|学习|掌握|解释|研究)?\s*([^，。！？!?；;]{2,50}?)\s*(?:需要|(?<!需)要)(?:先)?(?:理解|学习|掌握|具备|有)?\s*([^。！？!?；;]{2,80})/u)
  if (match) add(match[2], match[1])

  match = input.match(/先(?:理解|学习|掌握|解释)\s*([^，。！？!?；;]{2,40})[，,]\s*(?:再|然后)(?:解释|学习|理解|掌握)?\s*([^。！？!?；;]{2,40})/u)
  if (match) add(match[1], match[2])

  match = input.match(/([^，。！？!?；;]{2,40})是(?:理解|学习|掌握)?\s*([^，。！？!?；;]{2,40})的(?:先修|前置|基础)/u)
  if (match) add(match[1], match[2])

  match = input.match(/([^，。！？!?；;]{2,40})依赖(?:于)?\s*([^，。！？!?；;]{2,40})/u)
  if (match) add(match[2], match[1])

  const seen = new Set()
  return hints.filter(hint => {
    const key = `${hint.from}\u0000${hint.to}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function isOutOfScopeCandidate(text) {
  return OUT_OF_SCOPE.test(String(text ?? ''))
}

export function isBlockedCandidate(text) {
  return BLOCKED.test(String(text ?? ''))
}

/**
 * Convert one fragment into a classification envelope used by capture.js.
 */
export function classifyFragment(rawText, options = {}) {
  const content = boundedText(rawText, options.maxChars ?? 2000)
  const knownConcepts = Array.isArray(options.knownConcepts) ? options.knownConcepts : []
  const conceptNames = extractConceptCandidates(content, knownConcepts)
  const intent = options.intent ?? detectIntent(content)
  const layer = options.layer ?? layerForIntent(intent, conceptNames)
  const confidence = options.confidence ?? confidenceForUserText(content)
  const priority = options.priority ?? priorityForIntent(intent, layer, content)
  const temporalScope = temporalScopeFor(intent, content)
  const feasibility = assessFeasibility({
    content,
    outOfScope: isOutOfScopeCandidate(content),
    blocked: isBlockedCandidate(content),
    requiresPrerequisite: intent === 'prerequisite',
  })
  return {
    content,
    userOriginal: content,
    concepts: conceptNames.map(name => ({
      name,
      layer: layer === 'L2' ? 'L2' : 'L1',
      priority: layer === 'L0' ? 'HIGH' : priority,
      confidence,
      status: intent === 'question' || intent === 'prerequisite' ? 'QUEUED' : 'CAPTURED',
    })),
    dependencyHints: extractDependencyHints(content),
    layer,
    topic: conceptNames[0] ?? inferTopic(content),
    intent,
    temporalScope,
    priority,
    confidence,
    feasibility: feasibility.feasibility,
    feasibilityReason: feasibility.reason,
  }
}
