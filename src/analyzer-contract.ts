import { createHash } from 'node:crypto';
import {
  ANALYZER_CONTRACT_VERSION,
  ANALYZER_IDS,
  ANALYZER_RULES,
  ANALYZER_VERSIONS,
  type AnalyzerId,
  type AnalyzerRuleId,
  type EnabledAnalyzer,
} from './analyzer-config';
import type { ReviewFinding } from './review-contract';
import { parseStrictJson } from './strict-json';

export const MAX_ANALYZER_REPORT_BYTES = 65_536;
export const MAX_ANALYZER_OBSERVATIONS = 100;
export const MAX_ANALYZER_OUT_OF_SCOPE_OBSERVATIONS = 100;
export const MAX_ANALYZER_PATH_BYTES = 1_024;
export const MAX_ANALYZER_EVIDENCE_BYTES = 1_000;
export const MAX_ANALYZER_MESSAGE_BYTES = 512;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;

export interface AnalyzerObservationV1 {
  ruleId: AnalyzerRuleId;
  path: string;
  side: 'RIGHT';
  line: number;
  column: number;
  evidence: string;
  message: string;
  digest: string;
}

export interface AnalyzerRunV1 {
  analyzer: AnalyzerId;
  analyzerVersion: string;
  status: 'complete' | 'partial';
  enabledRules: AnalyzerRuleId[];
  eligibleFiles: number;
  analyzedFiles: number;
  skippedFiles: number;
  outOfScopeObservations: number;
  observations: AnalyzerObservationV1[];
}

export interface AnalyzerReportV1 {
  version: typeof ANALYZER_CONTRACT_VERSION;
  inputDigest: string;
  resultDigest: string;
  coverage: 'complete' | 'partial';
  runs: AnalyzerRunV1[];
}

export interface AnalyzerFindingCandidate extends ReviewFinding {
  origin: {
    kind: 'analyzer';
    analyzer: AnalyzerId;
    analyzerVersion: string;
    ruleId: AnalyzerRuleId;
    ruleRevision: number;
    observationDigest: string;
  };
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(domain).update('\0').update(JSON.stringify(value)).digest('base64url')}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nonnegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
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

function boundedText(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    isWellFormedUnicode(value) &&
    !hasDisallowedControl(value)
  );
}

export function isAnalyzerObservationPath(value: unknown): value is string {
  return (
    boundedText(value, MAX_ANALYZER_PATH_BYTES) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/[\0\r\n\p{Cf}]/u.test(value) &&
    value.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

export function isAnalyzerEvidence(value: unknown): value is string {
  return boundedText(value, MAX_ANALYZER_EVIDENCE_BYTES, true) && !/\r|\n/u.test(value);
}

export function isAnalyzerMessage(value: unknown): value is string {
  return boundedText(value, MAX_ANALYZER_MESSAGE_BYTES);
}

function canonicalObservation(value: AnalyzerObservationV1): Omit<AnalyzerObservationV1, 'digest'> {
  return {
    ruleId: value.ruleId,
    path: value.path,
    side: 'RIGHT',
    line: value.line,
    column: value.column,
    evidence: value.evidence,
    message: value.message,
  };
}

export function observationDigest(
  analyzer: AnalyzerId,
  analyzerVersion: string,
  value: Omit<AnalyzerObservationV1, 'digest'>,
): string {
  return digest('code-review/analyzer-observation/v1', { analyzer, analyzerVersion, ...value });
}

const RULE_ORDER: readonly AnalyzerRuleId[] = ['unresolved-conflict-marker', 'syntax-error', 'duplicate-property'];

function compareObservation(left: AnalyzerObservationV1, right: AnalyzerObservationV1): number {
  return (
    left.path.localeCompare(right.path, 'en') ||
    left.line - right.line ||
    left.column - right.column ||
    RULE_ORDER.indexOf(left.ruleId) - RULE_ORDER.indexOf(right.ruleId) ||
    left.digest.localeCompare(right.digest, 'en')
  );
}

function canonicalReport(report: Omit<AnalyzerReportV1, 'resultDigest'>) {
  return {
    version: ANALYZER_CONTRACT_VERSION,
    inputDigest: report.inputDigest,
    coverage: report.coverage,
    runs: report.runs.map((run) => ({
      ...run,
      enabledRules: [...run.enabledRules],
      observations: [...run.observations].sort(compareObservation),
    })),
  };
}

type AnalyzerReportInput = {
  inputDigest: string;
  coverage: 'complete' | 'partial';
  runs: AnalyzerRunV1[];
};

function unvalidatedAnalyzerReport(input: AnalyzerReportInput): AnalyzerReportV1 {
  const canonical = canonicalReport({ version: ANALYZER_CONTRACT_VERSION, ...input });
  return {
    ...canonical,
    resultDigest: digest('code-review/analyzer-report/v1', canonical),
  };
}

export function analyzerReportSerializedBytes(input: AnalyzerReportInput): number {
  return Buffer.byteLength(JSON.stringify(unvalidatedAnalyzerReport(input)), 'utf8');
}

export function createAnalyzerReport(input: AnalyzerReportInput): AnalyzerReportV1 {
  return parseAnalyzerReport(JSON.stringify(unvalidatedAnalyzerReport(input)));
}

export function parseAnalyzerReport(raw: string): AnalyzerReportV1 {
  return validateAnalyzerReport(parseStrictJson(raw, MAX_ANALYZER_REPORT_BYTES));
}

/** Revalidates the host-normalized analyzer contract before it can affect context or publication. */
export function validateAnalyzerReport(value: unknown): AnalyzerReportV1 {
  const root = record(value);
  if (!root || !exactKeys(root, ['version', 'inputDigest', 'resultDigest', 'coverage', 'runs'])) {
    throw new Error('Analyzer report has an invalid shape');
  }
  if (root.version !== ANALYZER_CONTRACT_VERSION) throw new Error('Analyzer report version is unsupported');
  if (!DIGEST_PATTERN.test(String(root.inputDigest)) || !DIGEST_PATTERN.test(String(root.resultDigest))) {
    throw new Error('Analyzer report contains an invalid digest');
  }
  if (root.coverage !== 'complete' && root.coverage !== 'partial') throw new Error('Analyzer coverage is invalid');
  if (!Array.isArray(root.runs) || root.runs.length > ANALYZER_IDS.length) {
    throw new Error('Analyzer report has too many runs');
  }
  const seenAnalyzers = new Set<AnalyzerId>();
  let priorAnalyzerIndex = -1;
  let observationCount = 0;
  const runs: AnalyzerRunV1[] = [];
  for (const rawRun of root.runs) {
    const run = record(rawRun);
    const keys = [
      'analyzer',
      'analyzerVersion',
      'status',
      'enabledRules',
      'eligibleFiles',
      'analyzedFiles',
      'skippedFiles',
      'outOfScopeObservations',
      'observations',
    ];
    if (!run || !exactKeys(run, keys) || !ANALYZER_IDS.includes(run.analyzer as AnalyzerId)) {
      throw new Error('Analyzer run has an invalid shape');
    }
    const analyzer = run.analyzer as AnalyzerId;
    const analyzerIndex = ANALYZER_IDS.indexOf(analyzer);
    if (
      seenAnalyzers.has(analyzer) ||
      analyzerIndex <= priorAnalyzerIndex ||
      run.analyzerVersion !== ANALYZER_VERSIONS[analyzer]
    ) {
      throw new Error('Analyzer run identity is invalid');
    }
    seenAnalyzers.add(analyzer);
    priorAnalyzerIndex = analyzerIndex;
    if (run.status !== 'complete' && run.status !== 'partial') throw new Error('Analyzer run status is invalid');
    if (!Array.isArray(run.enabledRules) || !Array.isArray(run.observations)) {
      throw new Error('Analyzer run arrays are invalid');
    }
    const allowedRules = ANALYZER_RULES[analyzer] as readonly string[];
    const enabledRules = run.enabledRules as unknown[];
    if (
      new Set(enabledRules).size !== enabledRules.length ||
      enabledRules.some((rule) => typeof rule !== 'string' || !allowedRules.includes(rule)) ||
      enabledRules.some(
        (rule, index) =>
          index > 0 && allowedRules.indexOf(String(enabledRules[index - 1])) >= allowedRules.indexOf(String(rule)),
      )
    ) {
      throw new Error('Analyzer run rules are invalid');
    }
    if (
      !nonnegativeInteger(run.eligibleFiles, 64) ||
      !nonnegativeInteger(run.analyzedFiles, 64) ||
      !nonnegativeInteger(run.skippedFiles, 64) ||
      !nonnegativeInteger(run.outOfScopeObservations, MAX_ANALYZER_OUT_OF_SCOPE_OBSERVATIONS) ||
      (run.analyzedFiles as number) + (run.skippedFiles as number) !== run.eligibleFiles
    ) {
      throw new Error('Analyzer run counts are invalid');
    }
    observationCount += run.observations.length;
    if (observationCount > MAX_ANALYZER_OBSERVATIONS) throw new Error('Analyzer report has too many observations');
    const observations: AnalyzerObservationV1[] = [];
    const seenDigests = new Set<string>();
    for (const rawObservation of run.observations) {
      const observation = record(rawObservation);
      if (
        !observation ||
        !exactKeys(observation, ['ruleId', 'path', 'side', 'line', 'column', 'evidence', 'message', 'digest']) ||
        typeof observation.ruleId !== 'string' ||
        !allowedRules.includes(observation.ruleId) ||
        !enabledRules.includes(observation.ruleId) ||
        !isAnalyzerObservationPath(observation.path) ||
        observation.side !== 'RIGHT' ||
        !nonnegativeInteger(observation.line) ||
        (observation.line as number) < 1 ||
        !nonnegativeInteger(observation.column) ||
        (observation.column as number) < 1 ||
        !isAnalyzerEvidence(observation.evidence) ||
        !isAnalyzerMessage(observation.message) ||
        !DIGEST_PATTERN.test(String(observation.digest))
      ) {
        throw new Error('Analyzer observation is invalid');
      }
      const normalized: AnalyzerObservationV1 = {
        ruleId: observation.ruleId as AnalyzerRuleId,
        path: observation.path,
        side: 'RIGHT',
        line: observation.line as number,
        column: observation.column as number,
        evidence: observation.evidence,
        message: observation.message,
        digest: observation.digest as string,
      };
      if (
        normalized.digest !==
          observationDigest(analyzer, run.analyzerVersion as string, canonicalObservation(normalized)) ||
        seenDigests.has(normalized.digest)
      ) {
        throw new Error('Analyzer observation digest is invalid or duplicated');
      }
      if (observations.length > 0 && compareObservation(observations[observations.length - 1]!, normalized) > 0) {
        throw new Error('Analyzer observations are not canonically ordered');
      }
      seenDigests.add(normalized.digest);
      observations.push(normalized);
    }
    runs.push({
      analyzer,
      analyzerVersion: run.analyzerVersion as string,
      status: run.status,
      enabledRules: enabledRules as AnalyzerRuleId[],
      eligibleFiles: run.eligibleFiles as number,
      analyzedFiles: run.analyzedFiles as number,
      skippedFiles: run.skippedFiles as number,
      outOfScopeObservations: run.outOfScopeObservations as number,
      observations,
    });
  }
  const expectedCoverage = runs.some((run) => run.status === 'partial') ? 'partial' : 'complete';
  if (root.coverage !== expectedCoverage) throw new Error('Analyzer coverage does not match its runs');
  const canonical = canonicalReport({
    version: ANALYZER_CONTRACT_VERSION,
    inputDigest: root.inputDigest as string,
    coverage: root.coverage,
    runs,
  });
  if (root.resultDigest !== digest('code-review/analyzer-report/v1', canonical)) {
    throw new Error('Analyzer report result digest is invalid');
  }
  const report: AnalyzerReportV1 = { ...canonical, resultDigest: root.resultDigest as string };
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_ANALYZER_REPORT_BYTES) {
    throw new Error('Analyzer report exceeds the size limit');
  }
  return report;
}

export function enabledAnalyzerRules(analyzers: readonly EnabledAnalyzer[], id: AnalyzerId): readonly AnalyzerRuleId[] {
  return analyzers.find((entry) => entry.id === id)?.rules ?? [];
}
