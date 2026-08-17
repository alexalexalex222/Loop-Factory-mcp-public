import { isSafeId } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const VNEXT_MODEL_SCHEMA = Object.freeze({
  EXTERNAL_RESEARCH_DISCOVERY: 'vnext-external-research-discovery-output-v1',
  RESEARCH: 'vnext-research-output-v1',
  HYPOTHESIS: 'vnext-hypothesis-output-v1',
  FALSIFICATION: 'vnext-falsification-output-v1',
  RERANKER: 'vnext-reranker-output-v1',
  CANDIDATE: 'vnext-candidate-output-v1',
  EVALUATOR: 'vnext-evaluator-output-v1',
  FEEDBACK: 'vnext-task-feedback-output-v1'
});

const SHA256 = /^[a-f0-9]{64}$/;
const STRATEGIES = new Set([
  'native',
  'reflective-pareto',
  'bounded-skill',
  'bank-recombination',
  'code-level-experimental'
]);

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...keys].sort());
}

function boundedText(value, maximum = 2000) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximum;
}

function stringArray(values, maximumItems = 64, maximumLength = 1000) {
  return Array.isArray(values)
    && values.length <= maximumItems
    && values.every((value) => boundedText(value, maximumLength))
    && new Set(values).size === values.length;
}

function idArray(values, maximumItems = 128) {
  return Array.isArray(values)
    && values.length <= maximumItems
    && values.every(isSafeId)
    && new Set(values).size === values.length;
}

function probability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function externalSourceValid(value) {
  if (!exactKeys(value, [
    'authorityClass', 'reason', 'sourceId', 'title', 'url'
  ])
      || !isSafeId(value.sourceId)
      || value.authorityClass !== 'primary'
      || !boundedText(value.title, 500)
      || !boundedText(value.reason, 1000)) return false;
  try {
    const url = new URL(value.url);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.hash;
  } catch {
    return false;
  }
}

function validateExternalResearchDiscovery(value) {
  return exactKeys(value, [
    'abstain', 'abstainReason', 'queries', 'schemaVersion',
    'searchSummary', 'sources', 'uncertainties'
  ])
    && value.schemaVersion === VNEXT_MODEL_SCHEMA.EXTERNAL_RESEARCH_DISCOVERY
    && typeof value.abstain === 'boolean'
    && (value.abstain
      ? boundedText(value.abstainReason, 1000)
      : value.abstainReason === null)
    && boundedText(value.searchSummary, 2000)
    && stringArray(value.queries, 32, 500)
    && value.queries.length > 0
    && stringArray(value.uncertainties, 64, 1000)
    && Array.isArray(value.sources)
    && value.sources.length <= 32
    && value.sources.every(externalSourceValid)
    && new Set(value.sources.map((source) => source.sourceId)).size
      === value.sources.length
    && new Set(value.sources.map((source) => source.url)).size
      === value.sources.length
    && (value.abstain ? value.sources.length === 0 : value.sources.length > 0);
}

function factValid(value) {
  return exactKeys(value, ['confidence', 'id', 'sourceIds', 'statement'])
    && isSafeId(value.id)
    && ['high', 'medium', 'low'].includes(value.confidence)
    && boundedText(value.statement, 2000)
    && idArray(value.sourceIds, 32);
}

function validateResearch(value) {
  return exactKeys(value, [
    'counterexamples',
    'facts',
    'schemaVersion',
    'uncertainties',
    'unansweredQuestions'
  ])
    && value.schemaVersion === VNEXT_MODEL_SCHEMA.RESEARCH
    && Array.isArray(value.facts)
    && value.facts.length <= 128
    && value.facts.every(factValid)
    && new Set(value.facts.map((fact) => fact.id)).size === value.facts.length
    && stringArray(value.counterexamples)
    && stringArray(value.uncertainties)
    && stringArray(value.unansweredQuestions);
}

function validateHypothesis(value) {
  return exactKeys(value, [
    'component',
    'controls',
    'evidenceIds',
    'falsifier',
    'mechanism',
    'prediction',
    'schemaVersion',
    'statement',
    'targetBehavior',
    'taskAgnostic'
  ])
    && value.schemaVersion === VNEXT_MODEL_SCHEMA.HYPOTHESIS
    && boundedText(value.component, 120)
    && boundedText(value.statement, 3000)
    && boundedText(value.mechanism, 3000)
    && boundedText(value.targetBehavior, 500)
    && boundedText(value.prediction, 1000)
    && boundedText(value.falsifier, 1000)
    && typeof value.taskAgnostic === 'boolean'
    && stringArray(value.controls, 32, 500)
    && idArray(value.evidenceIds);
}

function validateFalsification(value) {
  return exactKeys(value, [
    'confounds',
    'contradictions',
    'distinct',
    'evidenceIds',
    'falsifiers',
    'requiredControls',
    'schemaVersion',
    'smallerEdit',
    'summary',
    'verdict'
  ])
    && value.schemaVersion === VNEXT_MODEL_SCHEMA.FALSIFICATION
    && ['REJECT', 'REVISE', 'TEST'].includes(value.verdict)
    && boundedText(value.summary, 2000)
    && boundedText(value.smallerEdit, 2000)
    && typeof value.distinct === 'boolean'
    && stringArray(value.falsifiers)
    && stringArray(value.confounds)
    && stringArray(value.requiredControls)
    && stringArray(value.contradictions)
    && idArray(value.evidenceIds);
}

function rankingValid(value) {
  return exactKeys(value, [
    'applicability',
    'confidence',
    'contradictionRisk',
    'expectedBenefit',
    'reason',
    'recordId',
    'structuralSimilarity',
    'transferUncertainty'
  ])
    && isSafeId(value.recordId)
    && probability(value.applicability)
    && probability(value.structuralSimilarity)
    && probability(value.expectedBenefit)
    && probability(value.transferUncertainty)
    && probability(value.contradictionRisk)
    && probability(value.confidence)
    && boundedText(value.reason, 1000);
}

function validateReranker(value) {
  return exactKeys(value, [
    'abstain',
    'abstainReason',
    'rankings',
    'schemaVersion'
  ])
    && value.schemaVersion === VNEXT_MODEL_SCHEMA.RERANKER
    && typeof value.abstain === 'boolean'
    && (value.abstain
      ? boundedText(value.abstainReason, 1000)
      : value.abstainReason === null)
    && Array.isArray(value.rankings)
    && value.rankings.length <= 64
    && value.rankings.every(rankingValid)
    && new Set(value.rankings.map((row) => row.recordId)).size === value.rankings.length;
}

function operationValid(value) {
  return exactKeys(value, ['beforeSha256', 'op', 'target', 'value'])
    && ['add', 'delete', 'replace', 'recombine', 'emit'].includes(value.op)
    && boundedText(value.target, 500)
    && (value.beforeSha256 == null || SHA256.test(String(value.beforeSha256)))
    && (value.value == null || boundedText(value.value, 8000));
}

function validateCandidate(value) {
  return exactKeys(value, [
    'component',
    'evidenceIds',
    'falsifier',
    'operations',
    'prediction',
    'protectedSurfaceTouches',
    'rollback',
    'schemaVersion',
    'strategy',
    'targetBehavior',
    'taskAgnostic'
  ])
    && value.schemaVersion === VNEXT_MODEL_SCHEMA.CANDIDATE
    && STRATEGIES.has(value.strategy)
    && boundedText(value.component, 120)
    && boundedText(value.targetBehavior, 500)
    && boundedText(value.prediction, 1000)
    && boundedText(value.falsifier, 1000)
    && boundedText(value.rollback, 1000)
    && typeof value.taskAgnostic === 'boolean'
    && idArray(value.evidenceIds)
    && Array.isArray(value.operations)
    && value.operations.length > 0
    && value.operations.length <= 3
    && value.operations.every(operationValid)
    && Array.isArray(value.protectedSurfaceTouches)
    && value.protectedSurfaceTouches.length === 0;
}

function measurementValid(value) {
  return exactKeys(value, [
    'confidence',
    'dimension',
    'evidenceRefs',
    'score'
  ])
    && boundedText(value.dimension, 120)
    && Number.isFinite(value.score)
    && probability(value.confidence)
    && idArray(value.evidenceRefs, 64);
}

function validateEvaluator(value) {
  return exactKeys(value, [
    'measurements',
    'protocolViolations',
    'rubricSha256',
    'schemaVersion',
    'uncertainty'
  ])
    && value.schemaVersion === VNEXT_MODEL_SCHEMA.EVALUATOR
    && SHA256.test(String(value.rubricSha256 || ''))
    && probability(value.uncertainty)
    && idArray(value.protocolViolations, 32)
    && Array.isArray(value.measurements)
    && value.measurements.length > 0
    && value.measurements.length <= 64
    && value.measurements.every(measurementValid);
}

function validateFeedback(value) {
  return exactKeys(value, [
    'helped',
    'irrelevant',
    'missing',
    'obstructed',
    'rediscovered',
    'schemaVersion',
    'timing',
    'uncertainty'
  ])
    && value.schemaVersion === VNEXT_MODEL_SCHEMA.FEEDBACK
    && probability(value.uncertainty)
    && stringArray(value.helped)
    && stringArray(value.obstructed)
    && stringArray(value.timing)
    && stringArray(value.missing)
    && stringArray(value.irrelevant)
    && stringArray(value.rediscovered);
}

const VALIDATORS = new Map([
  [VNEXT_MODEL_SCHEMA.EXTERNAL_RESEARCH_DISCOVERY, validateExternalResearchDiscovery],
  [VNEXT_MODEL_SCHEMA.RESEARCH, validateResearch],
  [VNEXT_MODEL_SCHEMA.HYPOTHESIS, validateHypothesis],
  [VNEXT_MODEL_SCHEMA.FALSIFICATION, validateFalsification],
  [VNEXT_MODEL_SCHEMA.RERANKER, validateReranker],
  [VNEXT_MODEL_SCHEMA.CANDIDATE, validateCandidate],
  [VNEXT_MODEL_SCHEMA.EVALUATOR, validateEvaluator],
  [VNEXT_MODEL_SCHEMA.FEEDBACK, validateFeedback]
]);

export function validateVNextModelOutput(value, expectedSchemaVersion) {
  const validator = VALIDATORS.get(expectedSchemaVersion);
  if (!validator || !validator(value)) {
    return {
      status: 'REFUSED',
      code: 'VNEXT_MODEL_OUTPUT_INVALID',
      expectedSchemaVersion
    };
  }
  return { status: 'OK', output: structuredClone(value) };
}
