/**
 * Public DSH tools for the optional memory subsystem.
 *
 * These are raw public tool definitions (JSON-Schema parameters + canonical JSON
 * output), so the plugin keeps its "no extra DSH package dependency" rule.
 */

const LAYERS = ['L0', 'L1', 'L2', 'L3']
const PRIORITIES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW']
const CONFIDENCES = ['EXPLICIT', 'VERIFIED', 'INFERRED', 'UNCERTAIN']
const FEASIBILITIES = ['READY', 'NEEDS_PREREQUISITE', 'NEEDS_CLARIFICATION', 'BLOCKED', 'OUT_OF_SCOPE']
const RELATION_TYPES = [
  'PREREQUISITE_OF',
  'PART_OF',
  'ELABORATES',
  'EXAMPLE_OF',
  'RELATED_TO',
  'CONFLICTS_WITH',
]

function output() {
  return {
    // The public ToolRuntime schema vocabulary has no generic "json" root.
    // Every memory tool returns a canonical object with tool-specific fields.
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

function definition(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: output(),
    execute,
  }
}

function stringArray(items = { type: 'string' }) {
  return { type: 'array', items }
}

const MEMORY_CAPTURE_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content: { type: 'string' },
    topic: { type: 'string' },
    layer: { type: 'string', enum: LAYERS },
    priority: { type: 'string', enum: PRIORITIES },
    confidence: { type: 'string', enum: CONFIDENCES },
    sourceKind: {
      type: 'string',
      enum: ['USER_EXPLICIT', 'VERIFIED_SOURCE', 'MODEL_INFERRED', 'TOOL_INFERRED', 'TEMPORARY_ASSUMPTION'],
    },
    intent: {
      type: 'string',
      enum: ['question', 'goal', 'constraint', 'statement', 'prerequisite', 'detail', 'correction', 'temporary_request', 'unclassified'],
    },
    temporalScope: { type: 'string', enum: ['long_term', 'task', 'temporary'] },
    feasibility: { type: 'string', enum: FEASIBILITIES },
    userOriginal: { type: 'string' },
    userOrder: { type: 'number' },
    relatedConcepts: stringArray(),
    prerequisiteConcepts: stringArray(),
    targetMemoryId: { type: 'string' },
    correctionOf: { type: 'string' },
    conflictWith: stringArray(),
  },
  required: ['content'],
}

const ADD_RELATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: RELATION_TYPES },
    fromConceptId: { type: 'string' },
    toConceptId: { type: 'string' },
    confidence: { type: 'string', enum: CONFIDENCES },
  },
  required: ['type', 'fromConceptId', 'toConceptId'],
}

/**
 * Register all six tools on the public registry. The caller owns disposal in
 * tests; Cordis attaches the returned disposers to the plugin in production.
 */
export function registerMemoryTools(tools, runtime, options = {}) {
  if (tools === undefined || typeof tools?.register !== 'function') return []
  const disposers = []
  const register = tool => {
    const dispose = tools.register(tool)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  register(definition(
    'memory_capture',
    'Record structured user information in the hierarchical local memory. '
      + 'The automatic session path already captures genuine human messages as EXPLICIT. '
      + 'A model-originated item defaults to INFERRED; claiming USER_EXPLICIT is accepted only when the text was observed in a recent human message. '
      + 'Use relatedConcepts for topic links and prerequisiteConcepts only for explicitly stated prerequisites. Never record hidden chain-of-thought.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {
          type: 'string',
          description: 'Natural-language material to classify. Use items for structured entries.',
        },
        items: {
          type: 'array',
          description: 'Structured memory entries. Each is independent and preserves its own user-order slot.',
          items: MEMORY_CAPTURE_ITEM,
        },
        sourceKind: {
          type: 'string',
          enum: ['USER_EXPLICIT', 'VERIFIED_SOURCE', 'MODEL_INFERRED', 'TOOL_INFERRED', 'TEMPORARY_ASSUMPTION'],
        },
      },
    },
    async (args, exec) => runtime.captureTool(args, exec),
  ))

  register(definition(
    'memory_search',
    'Search the layered local memory by semantics and concept relation. '
      + 'Use this when curated prompt context is absent, when details were omitted by the budget, '
      + 'or when the user explicitly asks to search memory. Results retain layer, confidence, feasibility, and source references.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search query; empty returns the highest-ranked records.' },
        layers: { ...stringArray({ type: 'string', enum: LAYERS }), description: 'Optional layer filter.' },
        conceptIds: { ...stringArray(), description: 'Optional concept-id filter.' },
        includeCompressed: { type: 'boolean', description: 'Include compressed low-priority details.' },
        limit: { type: 'number', description: 'Maximum records; defaults to 50.' },
      },
    },
    async args => runtime.search(args),
  ))

  register(definition(
    'concept_graph',
    'Read concept nodes and directed relations, including prerequisite closures, unresolved dependencies, and cycle diagnostics. '
      + 'This tool is read-only; use memory_capture or memory_update to add/update relations.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        conceptIds: { ...stringArray(), description: 'Optional concept ids to project.' },
        includeUnresolved: { type: 'boolean' },
      },
    },
    async args => runtime.graph(args),
  ))

  register(definition(
    'concept_status',
    'View or transition concept learning state. '
      + 'A concept cannot be marked INTRODUCED or EXPLAINED when necessary prerequisites are unexplained or when the plan uses an undeclared unready concept. '
      + 'VERIFIED requires explicit user evidence (USER_CONFIRMATION, USER_APPLICATION, or USER_FEEDBACK) and can never be inferred by the model. '
      + 'Actions: view, check, start, complete, verify, defer, block, reopen, queue.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['view', 'check', 'start', 'complete', 'verify', 'defer', 'block', 'reopen', 'queue'],
        },
        conceptIds: stringArray(),
        usedConceptIds: stringArray(),
        exemptConceptIds: stringArray(),
        plannedText: {
          type: 'string',
          description: 'Visible draft text to scan for undeclared unready concept names.',
        },
        userEvidence: {
          type: 'string',
          description: 'For verify only: the user statement or application proving mastery.',
        },
        evidenceKind: {
          type: 'string',
          enum: ['USER_CONFIRMATION', 'USER_APPLICATION', 'USER_FEEDBACK'],
        },
        explanationOrder: { type: 'number' },
        reason: { type: 'string' },
      },
    },
    async (args, exec) => runtime.conceptStatus(args, exec),
  ))

  register(definition(
    'memory_update',
    'Correct one memory record or add concept relations with optimistic version checking. '
      + 'Content corrections retain bounded history. L0 changes require userCorrection: true. '
      + 'Use expectedVersion to reject a stale overwrite.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        memoryId: { type: 'string' },
        expectedVersion: { type: 'number' },
        content: { type: 'string' },
        userOriginal: { type: 'string' },
        topic: { type: 'string' },
        layer: { type: 'string', enum: LAYERS },
        priority: { type: 'string', enum: PRIORITIES },
        confidence: { type: 'string', enum: CONFIDENCES },
        feasibility: { type: 'string', enum: FEASIBILITIES },
        relatedConceptIds: stringArray(),
        dependencyConceptIds: stringArray(),
        reason: { type: 'string' },
        userCorrection: { type: 'boolean' },
        userRequest: {
          type: 'string',
          description: 'For a semantic correction: the user request observed in a recent human message.',
        },
        allowCycleDiagnostic: { type: 'boolean' },
        addRelations: { type: 'array', items: ADD_RELATION },
      },
      required: ['memoryId', 'expectedVersion'],
    },
    async (args, exec) => runtime.memoryUpdate(args, exec),
  ))

  register(definition(
    'memory_delete',
    'Delete one memory record or concept and synchronize concept indexes, relations, and conflicts. '
      + 'This is destructive: confirm must be true only after the user explicitly requested deletion.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        confirm: { type: 'boolean' },
        cascade: { type: 'boolean', description: 'Remove concepts orphaned by a deleted record. Defaults true.' },
        userRequest: {
          type: 'string',
          description: 'The explicit user deletion request observed in a recent human message.',
        },
      },
      required: ['id', 'confirm'],
    },
    async (args, exec) => runtime.memoryDelete(args, exec),
  ))

  return disposers
}

export { LAYERS, PRIORITIES, CONFIDENCES, FEASIBILITIES, RELATION_TYPES }
