import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runDeterministicAnalysis, emptyDeterministicAnalysis, type DeterministicAnalysis } from './analyzer';
import { disabledAnalyzerConfiguration, parseAnalyzerConfiguration } from './analyzer-config';
import { assessReview, type ValidatedFinding } from './finding-validation';
import type { PullRequestContext, PullRequestDiff, RepositoryTextResult } from './github';
import {
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  MAX_REVIEW_RESULT_BYTES,
  ReviewContractError,
  parseReviewResult,
  type FindingCategory,
  type FindingSeverity,
  type ReviewResultV1,
} from './review-contract';
import { REVIEW_SEMANTIC_VERSIONS } from './review-lifecycle';
import { parseStrictJson } from './strict-json';
import { parseUnifiedDiff, type UnifiedDiff, type UnifiedDiffLine } from './unified-diff';

export const EVALUATION_CORPUS_VERSION = 1 as const;
export const EVALUATION_REPORT_VERSION = 1 as const;
export const EVALUATION_MATCHING_VERSION = 1 as const;
export const EVALUATION_THRESHOLD_VERSION = 1 as const;
export const MAX_EVALUATION_CORPUS_BYTES = 2 * 1024 * 1024;
export const MAX_EVALUATION_CASES = 64;
export const MAX_EVALUATION_THRESHOLD_BYTES = 16_384;
export const MAX_EVALUATION_DIFF_BYTES = 120_000;
export const MAX_EVALUATION_RECORDING_BYTES = MAX_REVIEW_RESULT_BYTES + 8_192;

const TAGS = [
  'correctness',
  'security',
  'regression',
  'testing',
  'prompt-injection',
  'html-like',
  'clean',
  'analyzer',
  'left-side',
] as const;
const REQUIRED_TAGS = TAGS.slice(0, 7);
export const CORE_EVALUATION_CASE_IDS = [
  'analyzer-duplicate-json-key',
  'clean-behavior-preserving-refactor',
  'correctness-wrong-arithmetic',
  'html-like-tsx-clean',
  'left-side-removed-validation',
  'prompt-injection-real-bug',
  'regression-removed-default',
  'security-inverted-auth-guard',
  'testing-new-parser-branch',
] as const;
const ORIGINS = ['model', 'analyzer'] as const;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const codePointCompare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export type EvaluationTag = (typeof TAGS)[number];
export type EvaluationOrigin = (typeof ORIGINS)[number];
export type EvaluationMode = 'recorded' | 'live';

export interface EvaluationLocation {
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
}

export interface ExpectedEvaluationFinding {
  id: string;
  category: FindingCategory;
  acceptableSeverities: FindingSeverity[];
  acceptableOrigins: EvaluationOrigin[];
  acceptableLocations: EvaluationLocation[];
  rationale: string;
}

export interface IntentionalNonFinding {
  id: string;
  categories: FindingCategory[];
  location: EvaluationLocation;
  reason: string;
}

export interface EvaluationAnalysisFixture {
  configuration: string;
  headFiles: Array<{ path: string; text: string; blobSha: string }>;
}

export interface EvaluationRecording {
  id: string;
  assistantOutput: string;
  latencyMs: number;
}

export interface EvaluationCase {
  id: string;
  title: string;
  tags: EvaluationTag[];
  pullRequest: { title: string; body: string; author: string };
  diff: string;
  analysis: EvaluationAnalysisFixture | null;
  expectations: { findings: ExpectedEvaluationFinding[]; intentionalNonFindings: IntentionalNonFinding[] };
  recordings: EvaluationRecording[];
  parsedDiff: UnifiedDiff;
}

export interface EvaluationCorpus {
  version: typeof EVALUATION_CORPUS_VERSION;
  cases: EvaluationCase[];
  digest: string;
}

export interface EvaluationThresholds {
  version: typeof EVALUATION_THRESHOLD_VERSION;
  minimumPrecision: number;
  minimumRecall: number;
  minimumLineMappingAccuracy: number;
  minimumCleanCaseAccuracy: number;
  maximumDuplicateFindingRate: number;
  maximumEvidenceRejectedFindingRate: number;
  maximumGlobalLimitOmittedFindingRate: number;
  maximumMalformedOutputRate: number;
  maximumExecutionFailureRate: number;
  maximumP95LatencyMs: number;
}

export const REQUIRED_EVALUATION_GATE: Readonly<Omit<EvaluationThresholds, 'version'>> = Object.freeze({
  minimumPrecision: 1,
  minimumRecall: 1,
  minimumLineMappingAccuracy: 1,
  minimumCleanCaseAccuracy: 1,
  maximumDuplicateFindingRate: 0,
  maximumEvidenceRejectedFindingRate: 0,
  maximumGlobalLimitOmittedFindingRate: 0,
  maximumMalformedOutputRate: 0,
  maximumExecutionFailureRate: 0,
  maximumP95LatencyMs: 250,
});

export interface MetricRatio {
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface EvaluationMetrics {
  totalRuns: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: MetricRatio;
  recall: MetricRatio;
  candidateFindings: number;
  lineMappedFindings: number;
  lineMappingAccuracy: MetricRatio;
  evidenceRejectedFindings: number;
  evidenceRejectedFindingRate: MetricRatio;
  globalLimitOmittedFindings: number;
  globalLimitOmittedFindingRate: MetricRatio;
  memorySuppressedFindings: number;
  belowThresholdFindings: number;
  duplicateFindings: number;
  duplicateFindingRate: MetricRatio;
  malformedOutputs: number;
  malformedOutputRate: MetricRatio;
  executionFailures: number;
  executionFailureRate: MetricRatio;
  cleanRuns: number;
  correctCleanRuns: number;
  cleanCaseAccuracy: MetricRatio;
  intentionalNonFindingHits: number;
  latencyMs: { minimum: number; maximum: number; mean: number; p50: number; p95: number };
}

export interface SafeFindingSummary {
  category: FindingCategory;
  severity: FindingSeverity;
  origin: EvaluationOrigin;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  fingerprint: string;
}

export interface EvaluationCaseResult {
  caseId: string;
  recordingId: string;
  status: 'valid' | 'malformed-output' | 'execution-failure';
  latencyMs: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  candidateFindings: number;
  unmappedFindings: number;
  rejectedFindings: number;
  evidenceRejectedFindings: number;
  globalLimitOmittedFindings: number;
  memorySuppressedFindings: number;
  duplicateFindings: number;
  intentionalNonFindingHits: number;
  matchedExpectationIds: string[];
  missedExpectationIds: string[];
  findings: SafeFindingSummary[];
}

export interface EvaluationReport {
  version: typeof EVALUATION_REPORT_VERSION;
  corpus: { version: 1; digest: string; caseCount: number; caseIds: string[] };
  semantics: typeof REVIEW_SEMANTIC_VERSIONS & { matching: typeof EVALUATION_MATCHING_VERSION };
  run: {
    mode: EvaluationMode;
    backend: 'opencode' | 'pi' | null;
    model: string | null;
    latencySource: 'recorded' | 'measured';
  };
  metrics: EvaluationMetrics;
  thresholds: EvaluationThresholds | null;
  thresholdFailures: string[];
  cases: EvaluationCaseResult[];
}

export interface RecordedReviewFixture {
  name: string;
  assistantOutput: string;
}

export interface RecordedReviewFixtureResult {
  name: string;
  review?: ReviewResultV1;
  malformed: boolean;
}

export interface RecordedReviewEvaluation {
  total: number;
  valid: number;
  malformed: number;
  malformedOutputRate: number;
  results: RecordedReviewFixtureResult[];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) {
    throw new Error(`${name} contains unknown or missing fields`);
  }
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function hasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

function boundedString(value: unknown, name: string, maximumBytes: number, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    !wellFormed(value) ||
    (!allowEmpty && !value.trim()) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    hasDisallowedControl(value)
  ) {
    throw new Error(`${name} is invalid or exceeds its limit`);
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  const result = boundedString(value, name, 64);
  if (!ID_PATTERN.test(result)) throw new Error(`${name} must use lowercase hyphenated ASCII`);
  return result;
}

function uniqueStrings<T extends string>(values: unknown, allowed: readonly T[], name: string): T[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > allowed.length) {
    throw new Error(`${name} must be a nonempty bounded array`);
  }
  const result: T[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !allowed.includes(value as T) || result.includes(value as T)) {
      throw new Error(`${name} contains an unknown or duplicate value`);
    }
    result.push(value as T);
  }
  return result.sort((left, right) => allowed.indexOf(left) - allowed.indexOf(right));
}

function positiveInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${name} must be a positive bounded integer`);
  }
  return value as number;
}

function nonnegativeInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${name} must be a nonnegative bounded integer`);
  }
  return value as number;
}

function location(value: unknown, name: string): EvaluationLocation {
  const object = record(value, name);
  exactKeys(object, ['path', 'side', 'line'], name);
  const path = boundedString(object.path, `${name}.path`, 1_024);
  if (
    path.startsWith('/') ||
    /[\\\r\n]/u.test(path) ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`${name}.path is unsafe`);
  }
  if (object.side !== 'LEFT' && object.side !== 'RIGHT') throw new Error(`${name}.side is invalid`);
  return { path, side: object.side, line: positiveInteger(object.line, `${name}.line`) };
}

function resolveLocation(diff: UnifiedDiff, target: EvaluationLocation): { path: string; line: UnifiedDiffLine } {
  const files = diff.files.filter(
    (file) => file.commentable && (target.side === 'LEFT' ? file.oldPath : file.newPath) === target.path,
  );
  if (files.length !== 1 || !files[0]?.apiPath)
    throw new Error('Evaluation location does not resolve to one reviewed file');
  const lines = files[0].hunks
    .flatMap((hunk) => hunk.lines)
    .filter((line) =>
      target.side === 'LEFT'
        ? line.kind === 'deletion' && line.oldLine === target.line
        : line.kind === 'addition' && line.newLine === target.line,
    );
  if (lines.length !== 1 || !lines[0]) throw new Error('Evaluation location does not resolve to one changed line');
  return { path: files[0].apiPath, line: lines[0] };
}

function canonicalLocation(diff: UnifiedDiff, target: EvaluationLocation): EvaluationLocation {
  const resolved = resolveLocation(diff, target);
  return { ...target, path: resolved.path };
}

function parseExpected(value: unknown, diff: UnifiedDiff, caseId: string): ExpectedEvaluationFinding {
  const object = record(value, `case ${caseId} expected finding`);
  exactKeys(
    object,
    ['id', 'category', 'acceptableSeverities', 'acceptableOrigins', 'acceptableLocations', 'rationale'],
    `case ${caseId} expected finding`,
  );
  if (!FINDING_CATEGORIES.includes(object.category as FindingCategory)) throw new Error('Unknown expected category');
  if (
    !Array.isArray(object.acceptableLocations) ||
    object.acceptableLocations.length === 0 ||
    object.acceptableLocations.length > 8
  ) {
    throw new Error('Expected finding locations must be a nonempty bounded array');
  }
  const locations = object.acceptableLocations.map((entry, index) =>
    canonicalLocation(diff, location(entry, `case ${caseId} acceptableLocations[${index}]`)),
  );
  const keys = new Set(locations.map(locationKey));
  if (keys.size !== locations.length) throw new Error('Expected finding contains duplicate acceptable locations');
  return {
    id: identifier(object.id, `case ${caseId} expected id`),
    category: object.category as FindingCategory,
    acceptableSeverities: uniqueStrings(object.acceptableSeverities, FINDING_SEVERITIES, 'acceptableSeverities'),
    acceptableOrigins: uniqueStrings(object.acceptableOrigins, ORIGINS, 'acceptableOrigins'),
    acceptableLocations: locations.sort(compareLocations),
    rationale: boundedString(object.rationale, 'expected rationale', 1_000),
  };
}

function parseIntentional(value: unknown, diff: UnifiedDiff, caseId: string): IntentionalNonFinding {
  const object = record(value, `case ${caseId} intentional non-finding`);
  exactKeys(object, ['id', 'categories', 'location', 'reason'], `case ${caseId} intentional non-finding`);
  return {
    id: identifier(object.id, 'intentional non-finding id'),
    categories: uniqueStrings(object.categories, FINDING_CATEGORIES, 'intentional categories'),
    location: canonicalLocation(diff, location(object.location, 'intentional location')),
    reason: boundedString(object.reason, 'intentional reason', 1_000),
  };
}

function parseAnalysis(value: unknown, caseId: string): EvaluationAnalysisFixture | null {
  if (value === null) return null;
  const object = record(value, `case ${caseId} analysis`);
  exactKeys(object, ['configuration', 'headFiles'], `case ${caseId} analysis`);
  const configuration = boundedString(object.configuration, 'analysis configuration', 16_384);
  parseAnalyzerConfiguration(configuration, '0'.repeat(40), 'fixture-config');
  if (!Array.isArray(object.headFiles) || object.headFiles.length > 32)
    throw new Error('analysis headFiles exceeds limit');
  const paths = new Set<string>();
  const headFiles = object.headFiles.map((entry, index) => {
    const file = record(entry, `analysis headFiles[${index}]`);
    exactKeys(file, ['path', 'text', 'blobSha'], `analysis headFiles[${index}]`);
    const path = location({ path: file.path, side: 'RIGHT', line: 1 }, 'analysis file').path;
    if (paths.has(path)) throw new Error('Duplicate analysis head file');
    paths.add(path);
    return {
      path,
      text: boundedString(file.text, 'analysis file text', 524_288, true),
      blobSha: boundedString(file.blobSha, 'analysis blobSha', 128),
    };
  });
  return { configuration, headFiles: headFiles.sort((left, right) => codePointCompare(left.path, right.path)) };
}

function parseCase(value: unknown): EvaluationCase {
  const object = record(value, 'evaluation case');
  exactKeys(
    object,
    ['id', 'title', 'tags', 'pullRequest', 'diff', 'analysis', 'expectations', 'recordings'],
    'evaluation case',
  );
  const id = identifier(object.id, 'case id');
  const diffText = boundedString(object.diff, `case ${id} diff`, MAX_EVALUATION_DIFF_BYTES);
  const parsedDiff = parseUnifiedDiff(diffText);
  if (parsedDiff.files.length === 0) throw new Error(`case ${id} diff is empty`);
  const pullRequest = record(object.pullRequest, `case ${id} pullRequest`);
  exactKeys(pullRequest, ['title', 'body', 'author'], `case ${id} pullRequest`);
  const expectationsObject = record(object.expectations, `case ${id} expectations`);
  exactKeys(expectationsObject, ['findings', 'intentionalNonFindings'], `case ${id} expectations`);
  if (!Array.isArray(expectationsObject.findings) || expectationsObject.findings.length > 10) {
    throw new Error(`case ${id} expected findings exceed limit`);
  }
  if (
    !Array.isArray(expectationsObject.intentionalNonFindings) ||
    expectationsObject.intentionalNonFindings.length > 20
  ) {
    throw new Error(`case ${id} intentional non-findings exceed limit`);
  }
  const findings = expectationsObject.findings.map((entry) => parseExpected(entry, parsedDiff, id));
  const findingIds = new Set(findings.map((entry) => entry.id));
  if (findingIds.size !== findings.length) throw new Error(`case ${id} has duplicate expected IDs`);
  const eligibility = new Set<string>();
  for (const finding of findings) {
    for (const acceptable of finding.acceptableLocations) {
      const key = locationKey(acceptable);
      if (eligibility.has(key)) throw new Error(`case ${id} has ambiguous expected locations`);
      eligibility.add(key);
    }
  }
  const intentionalNonFindings = expectationsObject.intentionalNonFindings.map((entry) =>
    parseIntentional(entry, parsedDiff, id),
  );
  const intentionalIds = new Set(intentionalNonFindings.map((entry) => entry.id));
  if (intentionalIds.size !== intentionalNonFindings.length)
    throw new Error(`case ${id} has duplicate non-finding IDs`);
  if (findings.some((finding) => intentionalIds.has(finding.id))) {
    throw new Error(`case ${id} has an expected/non-finding ID collision`);
  }
  for (const finding of findings) {
    for (const nonFinding of intentionalNonFindings) {
      if (
        nonFinding.categories.includes(finding.category) &&
        finding.acceptableLocations.some((acceptable) => locationKey(acceptable) === locationKey(nonFinding.location))
      ) {
        throw new Error(`case ${id} has overlapping expected and intentional non-finding semantics`);
      }
    }
  }
  if (!Array.isArray(object.recordings) || object.recordings.length === 0 || object.recordings.length > 8) {
    throw new Error(`case ${id} recordings must be nonempty and bounded`);
  }
  const recordings = object.recordings.map((entry, index) => {
    const recording = record(entry, `case ${id} recording[${index}]`);
    exactKeys(recording, ['id', 'assistantOutput', 'latencyMs'], `case ${id} recording[${index}]`);
    return {
      id: identifier(recording.id, `case ${id} recording id`),
      assistantOutput: boundedString(
        recording.assistantOutput,
        `case ${id} assistantOutput`,
        MAX_EVALUATION_RECORDING_BYTES,
        true,
      ),
      latencyMs: nonnegativeInteger(recording.latencyMs, `case ${id} latencyMs`, 3_600_000),
    };
  });
  const recordingIds = new Set(recordings.map((entry) => entry.id));
  if (recordingIds.size !== recordings.length) throw new Error(`case ${id} has duplicate recordings`);
  return {
    id,
    title: boundedString(object.title, `case ${id} title`, 256),
    tags: uniqueStrings(object.tags, TAGS, `case ${id} tags`),
    pullRequest: {
      title: boundedString(pullRequest.title, `case ${id} PR title`, 512),
      body: boundedString(pullRequest.body, `case ${id} PR body`, 4_000, true),
      author: boundedString(pullRequest.author, `case ${id} PR author`, 256),
    },
    diff: diffText,
    analysis: parseAnalysis(object.analysis, id),
    expectations: {
      findings: findings.sort((left, right) => codePointCompare(left.id, right.id)),
      intentionalNonFindings,
    },
    recordings: recordings.sort((left, right) => codePointCompare(left.id, right.id)),
    parsedDiff,
  };
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort(codePointCompare)
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

export function parseEvaluationCorpus(raw: string): EvaluationCorpus {
  const root = record(parseStrictJson(raw, MAX_EVALUATION_CORPUS_BYTES), 'evaluation corpus');
  exactKeys(root, ['version', 'cases'], 'evaluation corpus');
  if (root.version !== EVALUATION_CORPUS_VERSION) throw new Error('Evaluation corpus version must be 1');
  if (!Array.isArray(root.cases) || root.cases.length === 0 || root.cases.length > MAX_EVALUATION_CASES) {
    throw new Error('Evaluation corpus must contain 1-64 cases');
  }
  const cases = root.cases.map(parseCase).sort((left, right) => codePointCompare(left.id, right.id));
  const ids = new Set(cases.map((entry) => entry.id));
  if (ids.size !== cases.length) throw new Error('Evaluation corpus contains duplicate case IDs');
  const caseIds = cases.map((entry) => entry.id);
  if (
    caseIds.length !== CORE_EVALUATION_CASE_IDS.length ||
    caseIds.some((id, index) => id !== CORE_EVALUATION_CASE_IDS[index])
  ) {
    throw new Error('Evaluation corpus must contain the exact protected core case IDs');
  }
  const availableTags = new Set(cases.flatMap((entry) => entry.tags));
  for (const tag of REQUIRED_TAGS)
    if (!availableTags.has(tag)) throw new Error(`Evaluation corpus is missing required tag ${tag}`);
  if (
    !cases.some((entry) => entry.expectations.findings.length > 0) ||
    !cases.some((entry) => entry.expectations.findings.length === 0)
  ) {
    throw new Error('Evaluation corpus requires positive and clean cases');
  }
  const digest = `sha256:${createHash('sha256')
    .update('code-review/evaluation-corpus/v1\0')
    .update(stableJson({ version: 1, cases: root.cases }))
    .digest('base64url')}`;
  return { version: 1, cases, digest };
}

function boundedRatio(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return value;
}

export function parseEvaluationThresholds(raw: string): EvaluationThresholds {
  const root = record(parseStrictJson(raw, MAX_EVALUATION_THRESHOLD_BYTES), 'evaluation thresholds');
  const keys = [
    'version',
    'minimumPrecision',
    'minimumRecall',
    'minimumLineMappingAccuracy',
    'minimumCleanCaseAccuracy',
    'maximumDuplicateFindingRate',
    'maximumEvidenceRejectedFindingRate',
    'maximumGlobalLimitOmittedFindingRate',
    'maximumMalformedOutputRate',
    'maximumExecutionFailureRate',
    'maximumP95LatencyMs',
  ] as const;
  exactKeys(root, keys, 'evaluation thresholds');
  if (root.version !== 1) throw new Error('Evaluation threshold version must be 1');
  const thresholds: EvaluationThresholds = {
    version: 1,
    minimumPrecision: boundedRatio(root.minimumPrecision, 'minimumPrecision'),
    minimumRecall: boundedRatio(root.minimumRecall, 'minimumRecall'),
    minimumLineMappingAccuracy: boundedRatio(root.minimumLineMappingAccuracy, 'minimumLineMappingAccuracy'),
    minimumCleanCaseAccuracy: boundedRatio(root.minimumCleanCaseAccuracy, 'minimumCleanCaseAccuracy'),
    maximumDuplicateFindingRate: boundedRatio(root.maximumDuplicateFindingRate, 'maximumDuplicateFindingRate'),
    maximumEvidenceRejectedFindingRate: boundedRatio(
      root.maximumEvidenceRejectedFindingRate,
      'maximumEvidenceRejectedFindingRate',
    ),
    maximumGlobalLimitOmittedFindingRate: boundedRatio(
      root.maximumGlobalLimitOmittedFindingRate,
      'maximumGlobalLimitOmittedFindingRate',
    ),
    maximumMalformedOutputRate: boundedRatio(root.maximumMalformedOutputRate, 'maximumMalformedOutputRate'),
    maximumExecutionFailureRate: boundedRatio(root.maximumExecutionFailureRate, 'maximumExecutionFailureRate'),
    maximumP95LatencyMs: nonnegativeInteger(root.maximumP95LatencyMs, 'maximumP95LatencyMs', 3_600_000),
  };
  for (const name of [
    'minimumPrecision',
    'minimumRecall',
    'minimumLineMappingAccuracy',
    'minimumCleanCaseAccuracy',
  ] as const) {
    if (thresholds[name] < REQUIRED_EVALUATION_GATE[name])
      throw new Error(`Evaluation threshold ${name} weakens the required gate`);
  }
  for (const name of [
    'maximumDuplicateFindingRate',
    'maximumEvidenceRejectedFindingRate',
    'maximumGlobalLimitOmittedFindingRate',
    'maximumMalformedOutputRate',
    'maximumExecutionFailureRate',
    'maximumP95LatencyMs',
  ] as const) {
    if (thresholds[name] > REQUIRED_EVALUATION_GATE[name])
      throw new Error(`Evaluation threshold ${name} weakens the required gate`);
  }
  return thresholds;
}

function locationKey(value: EvaluationLocation): string {
  return `${value.path}\0${value.side}\0${value.line}`;
}

function compareLocations(left: EvaluationLocation, right: EvaluationLocation): number {
  return codePointCompare(left.path, right.path) || codePointCompare(left.side, right.side) || left.line - right.line;
}

function findingOrigin(finding: ValidatedFinding): EvaluationOrigin {
  return finding.origin?.kind === 'analyzer' ? 'analyzer' : 'model';
}

function findingKey(finding: ValidatedFinding): string {
  return [
    finding.location.path,
    finding.location.side,
    String(finding.location.line).padStart(16, '0'),
    finding.category,
    finding.severity,
    findingOrigin(finding),
    finding.fingerprint,
  ].join('\0');
}

function expectedMatchesFinding(expected: ExpectedEvaluationFinding, finding: ValidatedFinding): boolean {
  return (
    expected.category === finding.category &&
    expected.acceptableSeverities.includes(finding.severity) &&
    expected.acceptableOrigins.includes(findingOrigin(finding)) &&
    expected.acceptableLocations.some((candidate) => locationKey(candidate) === locationKey(finding.location))
  );
}

export function matchEvaluationFindings(
  expectedInput: readonly ExpectedEvaluationFinding[],
  findingInput: readonly ValidatedFinding[],
): {
  matched: Array<{ expectedId: string; finding: ValidatedFinding }>;
  missed: string[];
  unmatched: ValidatedFinding[];
} {
  const expected = [...expectedInput].sort((left, right) => codePointCompare(left.id, right.id));
  const findings = [...findingInput].sort((left, right) => codePointCompare(findingKey(left), findingKey(right)));
  const findingToExpected = new Map<number, number>();
  const tryMatch = (expectedIndex: number, visited: Set<number>): boolean => {
    for (let findingIndex = 0; findingIndex < findings.length; findingIndex += 1) {
      if (
        visited.has(findingIndex) ||
        !expectedMatchesFinding(
          expected[expectedIndex] as ExpectedEvaluationFinding,
          findings[findingIndex] as ValidatedFinding,
        )
      )
        continue;
      visited.add(findingIndex);
      const previous = findingToExpected.get(findingIndex);
      if (previous === undefined || tryMatch(previous, visited)) {
        findingToExpected.set(findingIndex, expectedIndex);
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < expected.length; index += 1) tryMatch(index, new Set());
  const matchedExpected = new Set(findingToExpected.values());
  const matched = [...findingToExpected.entries()]
    .map(([findingIndex, expectedIndex]) => ({
      expectedId: (expected[expectedIndex] as ExpectedEvaluationFinding).id,
      finding: findings[findingIndex] as ValidatedFinding,
    }))
    .sort((left, right) => codePointCompare(left.expectedId, right.expectedId));
  return {
    matched,
    missed: expected.filter((_entry, index) => !matchedExpected.has(index)).map((entry) => entry.id),
    unmatched: findings.filter((_entry, index) => !findingToExpected.has(index)),
  };
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function ratio(numerator: number, denominator: number): MetricRatio {
  return { numerator, denominator, value: denominator === 0 ? null : rounded(numerator / denominator) };
}

function latencySummary(values: readonly number[]) {
  if (values.length === 0) throw new Error('Evaluation produced no latency values');
  const sorted = [...values].sort((left, right) => left - right);
  const nearest = (percentile: number) => sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] as number;
  return {
    minimum: sorted[0] as number,
    maximum: sorted.at(-1) as number,
    mean: rounded(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: nearest(0.5),
    p95: nearest(0.95),
  };
}

async function analyzerForCase(fixture: EvaluationCase, secrets: readonly string[]): Promise<DeterministicAnalysis> {
  const baseSha = '0'.repeat(40);
  if (!fixture.analysis) return emptyDeterministicAnalysis(disabledAnalyzerConfiguration(baseSha));
  const configuration = parseAnalyzerConfiguration(fixture.analysis.configuration, baseSha, 'fixture-config');
  const files = new Map(fixture.analysis.headFiles.map((entry) => [entry.path, entry]));
  const client = {
    async getRepositoryTextAtRevision(
      _pullRequest: PullRequestContext,
      path: string,
      revision: string,
    ): Promise<RepositoryTextResult> {
      if (revision !== '1'.repeat(40)) throw new Error('Evaluation analyzer requested an unexpected revision');
      const file = files.get(path);
      return file
        ? {
            status: 'found',
            text: file.text,
            bytes: Buffer.byteLength(file.text),
            truncated: false,
            blobSha: file.blobSha,
          }
        : { status: 'not-found', bytes: 0, truncated: false, reason: 'not-found' };
    },
  };
  return runDeterministicAnalysis({
    client,
    pullRequest: evaluationPullRequest(fixture),
    diff: evaluationDiff(fixture),
    configuration,
    secrets,
  });
}

export function evaluationPullRequest(fixture: EvaluationCase): PullRequestContext {
  return {
    owner: 'code-review-evaluation',
    repository: fixture.id,
    number: 1,
    title: fixture.pullRequest.title,
    body: fixture.pullRequest.body,
    baseSha: '0'.repeat(40),
    headSha: '1'.repeat(40),
    author: fixture.pullRequest.author,
    url: `https://example.invalid/code-review-evaluation/${fixture.id}/pull/1`,
  };
}

export function evaluationDiff(fixture: EvaluationCase): PullRequestDiff & Required<Pick<PullRequestDiff, 'parsed'>> {
  return {
    text: fixture.diff,
    originalBytes: Buffer.byteLength(fixture.diff, 'utf8'),
    truncated: false,
    totalFiles: fixture.parsedDiff.files.length,
    parsed: fixture.parsedDiff,
    completeParsed: fixture.parsedDiff,
  };
}

function intentionalHit(nonFindings: readonly IntentionalNonFinding[], finding: ValidatedFinding): boolean {
  return nonFindings.some(
    (entry) =>
      entry.categories.includes(finding.category) && locationKey(entry.location) === locationKey(finding.location),
  );
}

export type EvaluationRunner = (input: {
  fixture: EvaluationCase;
  recording?: EvaluationRecording;
  analyzer: DeterministicAnalysis;
}) => Promise<
  | { status: 'valid'; review: ReviewResultV1; latencyMs: number }
  | { status: 'malformed-output' | 'execution-failure'; latencyMs: number }
>;

export async function evaluateReviewCorpus(input: {
  corpus: EvaluationCorpus;
  mode: EvaluationMode;
  runner?: EvaluationRunner;
  thresholds?: EvaluationThresholds;
  backend?: 'opencode' | 'pi' | null;
  model?: string | null;
  secrets?: readonly string[];
  monotonicNow?: () => number;
}): Promise<EvaluationReport> {
  const secrets = input.secrets ?? [];
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const results: EvaluationCaseResult[] = [];
  for (const fixture of input.corpus.cases) {
    const recordings = input.mode === 'recorded' ? fixture.recordings : [undefined];
    for (const recording of recordings) {
      const startedAt = monotonicNow();
      const analyzer = await analyzerForCase(fixture, secrets);
      let execution: Awaited<ReturnType<EvaluationRunner>>;
      if (input.runner) execution = await input.runner({ fixture, recording, analyzer });
      else {
        if (!recording) throw new Error('Recorded evaluation requires a recording');
        try {
          execution = {
            status: 'valid',
            review: parseReviewResult(recording.assistantOutput),
            latencyMs: recording.latencyMs,
          };
        } catch (error) {
          if (!(error instanceof ReviewContractError)) throw error;
          execution = { status: 'malformed-output', latencyMs: recording.latencyMs };
        }
      }
      if (input.mode === 'live') {
        execution = { ...execution, latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)) };
      }
      const recordingId = recording?.id ?? 'live';
      if (execution.status !== 'valid') {
        results.push({
          caseId: fixture.id,
          recordingId,
          status: execution.status,
          latencyMs: execution.latencyMs,
          truePositives: 0,
          falsePositives: 0,
          falseNegatives: fixture.expectations.findings.length,
          candidateFindings: 0,
          unmappedFindings: 0,
          rejectedFindings: 0,
          evidenceRejectedFindings: 0,
          globalLimitOmittedFindings: 0,
          memorySuppressedFindings: 0,
          duplicateFindings: 0,
          intentionalNonFindingHits: 0,
          matchedExpectationIds: [],
          missedExpectationIds: fixture.expectations.findings.map((entry) => entry.id),
          findings: [],
        });
        continue;
      }
      const assessment = assessReview(
        execution.review,
        fixture.parsedDiff,
        { minimumConfidence: 0, maximumInlineComments: 10 },
        secrets,
        analyzer.findings,
      );
      const matching = matchEvaluationFindings(fixture.expectations.findings, assessment.findings);
      const intentionalNonFindingHits = matching.unmatched.filter((finding) =>
        intentionalHit(fixture.expectations.intentionalNonFindings, finding),
      ).length;
      results.push({
        caseId: fixture.id,
        recordingId,
        status: 'valid',
        latencyMs: execution.latencyMs,
        truePositives: matching.matched.length,
        falsePositives: matching.unmatched.length,
        falseNegatives: matching.missed.length,
        candidateFindings: assessment.counts.received,
        unmappedFindings: assessment.counts.unmapped,
        rejectedFindings: assessment.counts.rejected,
        evidenceRejectedFindings: assessment.counts.evidenceRejected,
        globalLimitOmittedFindings: assessment.counts.globalLimitOmitted,
        memorySuppressedFindings: assessment.counts.memorySuppressed,
        duplicateFindings: assessment.counts.duplicates,
        intentionalNonFindingHits,
        matchedExpectationIds: matching.matched.map((entry) => entry.expectedId),
        missedExpectationIds: matching.missed,
        findings: assessment.findings
          .map((finding): SafeFindingSummary => ({
            category: finding.category,
            severity: finding.severity,
            origin: findingOrigin(finding),
            path: finding.location.path,
            side: finding.location.side,
            line: finding.location.line,
            fingerprint: finding.fingerprint,
          }))
          .sort((left, right) =>
            codePointCompare(
              `${left.path}\0${left.side}\0${left.line}\0${left.category}`,
              `${right.path}\0${right.side}\0${right.line}\0${right.category}`,
            ),
          ),
      });
    }
  }
  results.sort((left, right) =>
    codePointCompare(`${left.caseId}\0${left.recordingId}`, `${right.caseId}\0${right.recordingId}`),
  );
  const sum = (field: keyof EvaluationCaseResult) =>
    results.reduce((total, result) => total + (typeof result[field] === 'number' ? (result[field] as number) : 0), 0);
  const truePositives = sum('truePositives');
  const falsePositives = sum('falsePositives');
  const falseNegatives = sum('falseNegatives');
  const candidateFindings = sum('candidateFindings');
  const unmapped = sum('unmappedFindings');
  const duplicateFindings = sum('duplicateFindings');
  const malformedOutputs = results.filter((entry) => entry.status === 'malformed-output').length;
  const executionFailures = results.filter((entry) => entry.status === 'execution-failure').length;
  const cleanIds = new Set(
    input.corpus.cases.filter((entry) => entry.expectations.findings.length === 0).map((entry) => entry.id),
  );
  const cleanResults = results.filter((entry) => cleanIds.has(entry.caseId));
  const correctCleanRuns = cleanResults.filter(
    (entry) => entry.status === 'valid' && entry.falsePositives === 0 && entry.findings.length === 0,
  ).length;
  const metrics: EvaluationMetrics = {
    totalRuns: results.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
    candidateFindings,
    lineMappedFindings: candidateFindings - unmapped,
    lineMappingAccuracy: ratio(candidateFindings - unmapped, candidateFindings),
    evidenceRejectedFindings: sum('evidenceRejectedFindings'),
    evidenceRejectedFindingRate: ratio(sum('evidenceRejectedFindings'), candidateFindings),
    globalLimitOmittedFindings: sum('globalLimitOmittedFindings'),
    globalLimitOmittedFindingRate: ratio(sum('globalLimitOmittedFindings'), candidateFindings),
    memorySuppressedFindings: sum('memorySuppressedFindings'),
    belowThresholdFindings: 0,
    duplicateFindings,
    duplicateFindingRate: ratio(duplicateFindings, candidateFindings),
    malformedOutputs,
    malformedOutputRate: ratio(malformedOutputs, results.length),
    executionFailures,
    executionFailureRate: ratio(executionFailures, results.length),
    cleanRuns: cleanResults.length,
    correctCleanRuns,
    cleanCaseAccuracy: ratio(correctCleanRuns, cleanResults.length),
    intentionalNonFindingHits: sum('intentionalNonFindingHits'),
    latencyMs: latencySummary(results.map((entry) => entry.latencyMs)),
  };
  const thresholdFailures = input.thresholds ? evaluateThresholds(metrics, input.thresholds) : [];
  return {
    version: 1,
    corpus: {
      version: 1,
      digest: input.corpus.digest,
      caseCount: input.corpus.cases.length,
      caseIds: input.corpus.cases.map((entry) => entry.id),
    },
    semantics: { ...REVIEW_SEMANTIC_VERSIONS, matching: EVALUATION_MATCHING_VERSION },
    run: {
      mode: input.mode,
      backend: input.backend ?? null,
      model: input.model ?? null,
      latencySource: input.mode === 'recorded' ? 'recorded' : 'measured',
    },
    metrics,
    thresholds: input.thresholds ?? null,
    thresholdFailures,
    cases: results,
  };
}

function thresholdRatio(
  failures: string[],
  name: string,
  metric: MetricRatio,
  threshold: number,
  direction: 'minimum' | 'maximum',
): void {
  if (
    metric.value === null ||
    (direction === 'minimum'
      ? metric.numerator < threshold * metric.denominator
      : metric.numerator > threshold * metric.denominator)
  ) {
    failures.push(name);
  }
}

export function evaluateThresholds(metrics: EvaluationMetrics, thresholds: EvaluationThresholds): string[] {
  const failures: string[] = [];
  thresholdRatio(
    failures,
    'minimumCleanCaseAccuracy',
    metrics.cleanCaseAccuracy,
    thresholds.minimumCleanCaseAccuracy,
    'minimum',
  );
  thresholdRatio(
    failures,
    'minimumLineMappingAccuracy',
    metrics.lineMappingAccuracy,
    thresholds.minimumLineMappingAccuracy,
    'minimum',
  );
  thresholdRatio(failures, 'minimumPrecision', metrics.precision, thresholds.minimumPrecision, 'minimum');
  thresholdRatio(failures, 'minimumRecall', metrics.recall, thresholds.minimumRecall, 'minimum');
  thresholdRatio(
    failures,
    'maximumDuplicateFindingRate',
    metrics.duplicateFindingRate,
    thresholds.maximumDuplicateFindingRate,
    'maximum',
  );
  thresholdRatio(
    failures,
    'maximumEvidenceRejectedFindingRate',
    metrics.evidenceRejectedFindingRate,
    thresholds.maximumEvidenceRejectedFindingRate,
    'maximum',
  );
  thresholdRatio(
    failures,
    'maximumGlobalLimitOmittedFindingRate',
    metrics.globalLimitOmittedFindingRate,
    thresholds.maximumGlobalLimitOmittedFindingRate,
    'maximum',
  );
  thresholdRatio(
    failures,
    'maximumExecutionFailureRate',
    metrics.executionFailureRate,
    thresholds.maximumExecutionFailureRate,
    'maximum',
  );
  thresholdRatio(
    failures,
    'maximumMalformedOutputRate',
    metrics.malformedOutputRate,
    thresholds.maximumMalformedOutputRate,
    'maximum',
  );
  if (metrics.latencyMs.p95 > thresholds.maximumP95LatencyMs) failures.push('maximumP95LatencyMs');
  return failures.sort(codePointCompare);
}

export function renderEvaluationJson(report: EvaluationReport): string {
  return `${stableJson(report)}\n`;
}

function displayRatio(value: MetricRatio): string {
  return value.value === null ? 'undefined' : value.value.toFixed(6);
}

export function renderEvaluationMarkdown(report: EvaluationReport): string {
  const metrics = report.metrics;
  const status =
    report.thresholds === null ? 'not checked' : report.thresholdFailures.length === 0 ? 'passed' : 'failed';
  const lines = [
    '# Review evaluation',
    '',
    `- Mode: \`${report.run.mode}\``,
    `- Corpus: \`${report.corpus.digest}\` (${report.corpus.caseCount} cases)`,
    `- Thresholds: **${status}**`,
    '',
    '## Quality metrics',
    '',
    '| Metric | Value | Numerator | Denominator |',
    '| --- | ---: | ---: | ---: |',
    `| Precision | ${displayRatio(metrics.precision)} | ${metrics.precision.numerator} | ${metrics.precision.denominator} |`,
    `| Recall | ${displayRatio(metrics.recall)} | ${metrics.recall.numerator} | ${metrics.recall.denominator} |`,
    `| Line mapping accuracy | ${displayRatio(metrics.lineMappingAccuracy)} | ${metrics.lineMappingAccuracy.numerator} | ${metrics.lineMappingAccuracy.denominator} |`,
    `| Duplicate finding rate | ${displayRatio(metrics.duplicateFindingRate)} | ${metrics.duplicateFindingRate.numerator} | ${metrics.duplicateFindingRate.denominator} |`,
    `| Evidence/secret rejection rate | ${displayRatio(metrics.evidenceRejectedFindingRate)} | ${metrics.evidenceRejectedFindingRate.numerator} | ${metrics.evidenceRejectedFindingRate.denominator} |`,
    `| Global finding-cap omission rate | ${displayRatio(metrics.globalLimitOmittedFindingRate)} | ${metrics.globalLimitOmittedFindingRate.numerator} | ${metrics.globalLimitOmittedFindingRate.denominator} |`,
    `| Malformed output rate | ${displayRatio(metrics.malformedOutputRate)} | ${metrics.malformedOutputRate.numerator} | ${metrics.malformedOutputRate.denominator} |`,
    `| Execution failure rate | ${displayRatio(metrics.executionFailureRate)} | ${metrics.executionFailureRate.numerator} | ${metrics.executionFailureRate.denominator} |`,
    `| Clean case accuracy | ${displayRatio(metrics.cleanCaseAccuracy)} | ${metrics.cleanCaseAccuracy.numerator} | ${metrics.cleanCaseAccuracy.denominator} |`,
    '',
    `- Evidence or secret rejected findings: ${metrics.evidenceRejectedFindings}`,
    `- Global finding-cap omissions: ${metrics.globalLimitOmittedFindings}`,
    `- Repository-memory suppressed findings: ${metrics.memorySuppressedFindings}`,
    `- Below-confidence-threshold findings: ${metrics.belowThresholdFindings}`,
    `- Intentional non-finding hits: ${metrics.intentionalNonFindingHits}`,
    '',
    '## Latency (ms)',
    '',
    `Minimum ${metrics.latencyMs.minimum}; mean ${metrics.latencyMs.mean.toFixed(3)}; p50 ${metrics.latencyMs.p50}; p95 ${metrics.latencyMs.p95}; maximum ${metrics.latencyMs.maximum}.`,
    '',
    '## Cases',
    '',
    '| Case | Recording | Status | TP | FP | FN | Unmapped | Rejected | Duplicates | Intentional NF hits |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.cases.map(
      (entry) =>
        `| \`${entry.caseId}\` | \`${entry.recordingId}\` | ${entry.status} | ${entry.truePositives} | ${entry.falsePositives} | ${entry.falseNegatives} | ${entry.unmappedFindings} | ${entry.rejectedFindings} | ${entry.duplicateFindings} | ${entry.intentionalNonFindingHits} |`,
    ),
  ];
  if (report.thresholdFailures.length > 0) {
    lines.push('', '## Threshold failures', '', ...report.thresholdFailures.map((name) => `- \`${name}\``));
  }
  return `${lines.join('\n')}\n`;
}

/** Compatibility helper retained for callers that only need contract-malformation replay. */
export function evaluateRecordedReviewOutputs(fixtures: readonly RecordedReviewFixture[]): RecordedReviewEvaluation {
  const results = fixtures.map((fixture): RecordedReviewFixtureResult => {
    try {
      return { name: fixture.name, review: parseReviewResult(fixture.assistantOutput), malformed: false };
    } catch (error) {
      if (!(error instanceof ReviewContractError)) throw error;
      return { name: fixture.name, malformed: true };
    }
  });
  const malformed = results.filter((result) => result.malformed).length;
  return {
    total: results.length,
    valid: results.length - malformed,
    malformed,
    malformedOutputRate: results.length === 0 ? 0 : malformed / results.length,
    results,
  };
}
