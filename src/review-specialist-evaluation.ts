import type { DeterministicAnalysis } from './analyzer';
import { packReviewContext, type ContextRuntimeSummary } from './context-planner';
import type { ModelConnection } from './model';
import type { StructuredBackendRequest } from './review';
import { parseReviewResult } from './review-contract';
import {
  evaluateReviewCorpus,
  stableJson,
  type EvaluationCorpus,
  type EvaluationReport,
  type EvaluationRunner,
  type EvaluationThresholds,
} from './review-evaluation';
import { executeReviewStrategy, type ReviewExecutionSummary, type StructuredBackendRunner } from './review-specialists';
import { selectReviewStrategy, type SelectedReviewStrategy, type SpecialistRole } from './review-strategy';
import { parseStrictJson } from './strict-json';

export const SPECIALIST_EVALUATION_VERSION = 1 as const;
export const MAX_SPECIALIST_EVALUATION_BYTES = 1_048_576;
const roles = ['correctness', 'security', 'testing', 'compatibility'] as const;

interface RecordedStep {
  assistantOutput: string;
  latencyMs: number;
}

export interface SpecialistEvaluationCase {
  caseId: string;
  expectedAuto: SelectedReviewStrategy;
  roles: Record<SpecialistRole, RecordedStep>;
  arbiter: RecordedStep | null;
}

/**
 * Decodes the recorded expected auto route. 'specialists' is the retired fixture-era name of the
 * sharded route and stays accepted so the recorded corpus remains replayable without a fixture
 * regeneration that would break corpus-digest stability guarantees.
 */
function expectedRoute(value: unknown): SelectedReviewStrategy | null {
  if (value === 'single-pass' || value === 'sharded') return value;
  if (value === 'specialists') return 'sharded';
  return null;
}

export interface SpecialistEvaluationRecordings {
  version: 1;
  corpusDigest: string;
  cases: SpecialistEvaluationCase[];
}

export interface SpecialistEvaluationThresholds {
  version: 1;
  minimumPrecisionDelta: number;
  minimumRecallDelta: number;
  minimumLineMappingAccuracyDelta: number;
  minimumCleanCaseAccuracyDelta: number;
  maximumP95LatencyMultiplier: number;
  maximumP95LatencyMs: number;
  maximumReservedTokens: number;
}

export interface SpecialistEvaluationCaseSummary {
  caseId: string;
  selected: SelectedReviewStrategy;
  reasons: string[];
  rolesCompleted: number;
  validatedCandidates: number;
  arbiterRejected: number;
  reservedTokens: number;
}

export interface SpecialistEvaluationReport {
  version: 1;
  corpusDigest: string;
  baseline: EvaluationReport;
  specialists: EvaluationReport;
  auto: EvaluationReport;
  thresholdFailures: string[];
  specialistCases: SpecialistEvaluationCaseSummary[];
  autoCases: SpecialistEvaluationCaseSummary[];
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${name} contains unknown or missing fields`);
  }
}

function step(value: unknown, name: string): RecordedStep {
  const item = object(value, name);
  exactKeys(item, ['assistantOutput', 'latencyMs'], name);
  if (typeof item.assistantOutput !== 'string' || Buffer.byteLength(item.assistantOutput, 'utf8') > 60_000) {
    throw new Error(`${name} assistant output is invalid`);
  }
  if (!Number.isSafeInteger(item.latencyMs) || (item.latencyMs as number) < 0 || (item.latencyMs as number) > 900_000) {
    throw new Error(`${name} latency is invalid`);
  }
  return { assistantOutput: item.assistantOutput, latencyMs: item.latencyMs as number };
}

export function parseSpecialistEvaluationRecordings(
  raw: string,
  corpus: EvaluationCorpus,
): SpecialistEvaluationRecordings {
  const root = object(parseStrictJson(raw, MAX_SPECIALIST_EVALUATION_BYTES, 10), 'specialist recordings');
  exactKeys(root, ['version', 'corpusDigest', 'cases'], 'specialist recordings');
  if (root.version !== 1 || root.corpusDigest !== corpus.digest || !Array.isArray(root.cases)) {
    throw new Error('Specialist recordings version, corpus digest, or cases are invalid');
  }
  const cases = root.cases.map((rawCase, index): SpecialistEvaluationCase => {
    const item = object(rawCase, `specialist case ${index}`);
    exactKeys(item, ['caseId', 'expectedAuto', 'roles', 'arbiter'], `specialist case ${index}`);
    const route = typeof item.caseId === 'string' ? expectedRoute(item.expectedAuto) : null;
    if (typeof item.caseId !== 'string' || route === null) {
      throw new Error('Specialist case identity or expected route is invalid');
    }
    const roleObject = object(item.roles, `specialist case ${item.caseId} roles`);
    exactKeys(roleObject, roles, `specialist case ${item.caseId} roles`);
    const parsedRoles = Object.fromEntries(
      roles.map((role) => [role, step(roleObject[role], `specialist case ${item.caseId} ${role}`)]),
    ) as Record<SpecialistRole, RecordedStep>;
    return {
      caseId: item.caseId,
      expectedAuto: route,
      roles: parsedRoles,
      arbiter: item.arbiter === null ? null : step(item.arbiter, `specialist case ${item.caseId} arbiter`),
    };
  });
  cases.sort((left, right) => (left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0));
  const expected = corpus.cases.map((item) => item.id);
  if (
    cases.length !== expected.length ||
    new Set(cases.map((item) => item.caseId)).size !== cases.length ||
    cases.some((item, index) => item.caseId !== expected[index])
  ) {
    throw new Error('Specialist recordings must contain exactly the protected corpus cases');
  }
  return { version: 1, corpusDigest: corpus.digest, cases };
}

function finite(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside its allowed range`);
  }
  return value;
}

export function parseSpecialistEvaluationThresholds(raw: string): SpecialistEvaluationThresholds {
  const root = object(parseStrictJson(raw, 16_384, 4), 'specialist thresholds');
  const keys = [
    'version',
    'minimumPrecisionDelta',
    'minimumRecallDelta',
    'minimumLineMappingAccuracyDelta',
    'minimumCleanCaseAccuracyDelta',
    'maximumP95LatencyMultiplier',
    'maximumP95LatencyMs',
    'maximumReservedTokens',
  ];
  exactKeys(root, keys, 'specialist thresholds');
  if (root.version !== 1) throw new Error('Specialist threshold version must be 1');
  return {
    version: 1,
    minimumPrecisionDelta: finite(root.minimumPrecisionDelta, 'minimumPrecisionDelta', 0, 1),
    minimumRecallDelta: finite(root.minimumRecallDelta, 'minimumRecallDelta', 0, 1),
    minimumLineMappingAccuracyDelta: finite(
      root.minimumLineMappingAccuracyDelta,
      'minimumLineMappingAccuracyDelta',
      0,
      1,
    ),
    minimumCleanCaseAccuracyDelta: finite(root.minimumCleanCaseAccuracyDelta, 'minimumCleanCaseAccuracyDelta', 0, 1),
    maximumP95LatencyMultiplier: finite(root.maximumP95LatencyMultiplier, 'maximumP95LatencyMultiplier', 1, 5),
    maximumP95LatencyMs: finite(root.maximumP95LatencyMs, 'maximumP95LatencyMs', 1, 1_250),
    maximumReservedTokens: finite(root.maximumReservedTokens, 'maximumReservedTokens', 20_000, 300_000),
  };
}

function runtime(analyzer: DeterministicAnalysis): ContextRuntimeSummary {
  return {
    indexer: 'none',
    deterministicAnalysis: {
      mode: analyzer.summary.mode,
      configStatus: analyzer.summary.configStatus,
      coverage: analyzer.summary.coverage,
      runCount: analyzer.summary.runCount,
      acceptedObservations: analyzer.summary.acceptedObservations,
      skippedFiles: analyzer.summary.skippedFiles,
      outOfScopeObservations: analyzer.summary.outOfScopeObservations,
      contextTruncated: analyzer.summary.contextTruncated,
      unavailableSourceCount: analyzer.summary.unavailableSourceCount,
    },
    anchorsPlanned: 0,
    queriesPlanned: 0,
    queriesCompleted: 0,
    queriesTimedOut: 0,
    queryByteLimitHits: 0,
    queryBudgetSkipped: 0,
    guidance: { agents: 'disabled', contributing: 'disabled' },
    configuration: { candidates: 0, included: 0, unavailable: 0, truncated: 0 },
    linkedIssues: { discovered: 0, fetched: 0, unavailable: 0 },
  };
}

const evaluationConnection: ModelConnection = {
  api: 'openai-completions',
  baseUrl: 'https://example.invalid/v1',
  network: 'remote',
  modelId: 'recorded/specialists',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

function ratioValue(value: { value: number | null }): number {
  return value.value ?? 0;
}

function compareReports(
  baseline: EvaluationReport,
  candidate: EvaluationReport,
  thresholds: SpecialistEvaluationThresholds,
  label: string,
): string[] {
  const failures: string[] = [];
  for (const [name, delta, actual, previous] of [
    [
      'precision',
      thresholds.minimumPrecisionDelta,
      ratioValue(candidate.metrics.precision),
      ratioValue(baseline.metrics.precision),
    ],
    [
      'recall',
      thresholds.minimumRecallDelta,
      ratioValue(candidate.metrics.recall),
      ratioValue(baseline.metrics.recall),
    ],
    [
      'line-mapping-accuracy',
      thresholds.minimumLineMappingAccuracyDelta,
      ratioValue(candidate.metrics.lineMappingAccuracy),
      ratioValue(baseline.metrics.lineMappingAccuracy),
    ],
    [
      'clean-case-accuracy',
      thresholds.minimumCleanCaseAccuracyDelta,
      ratioValue(candidate.metrics.cleanCaseAccuracy),
      ratioValue(baseline.metrics.cleanCaseAccuracy),
    ],
  ] as const) {
    if (actual - previous < delta) failures.push(`${label}-${name}`);
  }
  for (const field of [
    'falsePositives',
    'falseNegatives',
    'intentionalNonFindingHits',
    'malformedOutputs',
    'executionFailures',
    'evidenceRejectedFindings',
    'globalLimitOmittedFindings',
  ] as const) {
    if (candidate.metrics[field] > baseline.metrics[field]) failures.push(`${label}-${field}`);
  }
  const baselineByCase = new Map(baseline.cases.map((item) => [item.caseId, new Set(item.matchedExpectationIds)]));
  for (const item of candidate.cases) {
    const matches = new Set(item.matchedExpectationIds);
    if ([...(baselineByCase.get(item.caseId) ?? [])].some((id) => !matches.has(id))) {
      failures.push(`${label}-${item.caseId}-expectations`);
    }
  }
  if (
    candidate.metrics.latencyMs.p95 > thresholds.maximumP95LatencyMs ||
    candidate.metrics.latencyMs.p95 > baseline.metrics.latencyMs.p95 * thresholds.maximumP95LatencyMultiplier
  ) {
    failures.push(`${label}-p95-latency`);
  }
  failures.push(...candidate.thresholdFailures.map((failure) => `${label}-absolute-${failure}`));
  return failures;
}

export async function evaluateSpecialistRecordings(input: {
  corpus: EvaluationCorpus;
  recordings: SpecialistEvaluationRecordings;
  thresholds: SpecialistEvaluationThresholds;
  baseline: EvaluationReport;
  absoluteThresholds: EvaluationThresholds;
}): Promise<SpecialistEvaluationReport> {
  const byCase = new Map(input.recordings.cases.map((item) => [item.caseId, item]));
  const specialistSummaries = new Map<string, SpecialistEvaluationCaseSummary>();
  const autoSummaries = new Map<string, SpecialistEvaluationCaseSummary>();
  const createRunner =
    (mode: 'specialists' | 'auto'): EvaluationRunner =>
    async ({ fixture, recording, analyzer }) => {
      const recorded = byCase.get(fixture.id);
      if (!recorded || !recording) return { status: 'execution-failure' as const, latencyMs: 0 };
      const diff = {
        text: fixture.diff,
        originalBytes: Buffer.byteLength(fixture.diff, 'utf8'),
        truncated: false,
        totalFiles: fixture.parsedDiff.files.length,
        parsed: fixture.parsedDiff,
        completeParsed: fixture.parsedDiff,
      };
      const requested = mode === 'specialists' ? 'specialists' : 'auto';
      const plan = selectReviewStrategy({ requested, diff, analyzerCoverage: analyzer.summary.coverage });
      if (mode === 'auto' && plan.selected !== recorded.expectedAuto) {
        return { status: 'execution-failure' as const, latencyMs: 0 };
      }
      let shardOutput: string | null = null;
      let call = 0;
      const structuredRunner: StructuredBackendRunner = async <T>(request: StructuredBackendRequest<T>) => {
        call += 1;
        if (shardOutput === null) {
          // The recorded per-role outputs are synthesized into one all-dimension shard output:
          // recorded role passes were category-exclusive, so the finding union preserves every
          // candidate and, because each recorded role equals its category, candidate digests and
          // therefore recorded arbiter rejection IDs stay byte-identical.
          const findings = roles.flatMap((role) => {
            const parsed = parseReviewResult(recorded.roles[role].assistantOutput);
            return parsed.findings;
          });
          shardOutput = JSON.stringify({ version: 1, outcome: findings.length === 0 ? 'clean' : 'findings', findings });
        }
        const output = call === 1 ? shardOutput : recorded.arbiter?.assistantOutput;
        if (output === undefined) throw new Error('Recorded review phase is missing');
        return request.parseAssistantText(output);
      };
      try {
        const executed = await executeReviewStrategy({
          plan,
          backend: 'opencode',
          containerEngine: 'podman',
          connection: evaluationConnection,
          opencodeVersion: '1.18.31',
          piVersion: '0.85.1',
          pullRequest: {
            owner: 'code-review-evaluation',
            repository: fixture.id,
            number: 1,
            title: fixture.pullRequest.title,
            body: fixture.pullRequest.body,
            baseSha: '0'.repeat(40),
            headSha: '1'.repeat(40),
            author: fixture.pullRequest.author,
            url: `https://example.invalid/${fixture.id}`,
          },
          diff,
          reviewContext: packReviewContext(analyzer.contextItems, runtime(analyzer)),
          priorFindings: [],
          policy: { minimumConfidence: 0, maximumInlineComments: 10 },
          secrets: [],
          assertFresh: async () => undefined,
          timeoutMs: 60_000,
          specialistTokenBudget: input.thresholds.maximumReservedTokens,
          structuredRunner,
          singleRunner: async () => parseReviewResult(recording.assistantOutput),
        });
        const latencyMs =
          plan.selected === 'single-pass'
            ? recording.latencyMs
            : roles.reduce((total, role) => total + recorded.roles[role].latencyMs, 0) +
              (recorded.arbiter?.latencyMs ?? 0);
        (mode === 'auto' ? autoSummaries : specialistSummaries).set(fixture.id, summary(fixture.id, executed.summary));
        return { status: 'valid' as const, review: executed.review, latencyMs };
      } catch {
        return { status: 'execution-failure' as const, latencyMs: 0 };
      }
    };
  const specialists = await evaluateReviewCorpus({
    corpus: input.corpus,
    mode: 'recorded',
    runner: createRunner('specialists'),
    thresholds: input.absoluteThresholds,
  });
  const auto = await evaluateReviewCorpus({
    corpus: input.corpus,
    mode: 'recorded',
    runner: createRunner('auto'),
    thresholds: input.absoluteThresholds,
  });
  const maximumReserved = Math.max(
    0,
    ...[...specialistSummaries.values(), ...autoSummaries.values()].map((item) => item.reservedTokens),
  );
  const thresholdFailures = [
    ...compareReports(input.baseline, specialists, input.thresholds, 'specialists'),
    ...compareReports(input.baseline, auto, input.thresholds, 'auto'),
    ...(maximumReserved > input.thresholds.maximumReservedTokens ? ['auto-reserved-tokens'] : []),
  ];
  return {
    version: 1,
    corpusDigest: input.corpus.digest,
    baseline: input.baseline,
    specialists,
    auto,
    thresholdFailures,
    specialistCases: [...specialistSummaries.values()].sort((left, right) =>
      left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0,
    ),
    autoCases: [...autoSummaries.values()].sort((left, right) =>
      left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0,
    ),
  };
}

function summary(caseId: string, value: ReviewExecutionSummary): SpecialistEvaluationCaseSummary {
  return {
    caseId,
    selected: value.plan.selected,
    reasons: value.plan.reasons,
    rolesCompleted: value.rolesCompleted,
    validatedCandidates: value.validatedCandidateCount,
    arbiterRejected: value.arbiterRejectedCount,
    reservedTokens: value.reservedTokens,
  };
}

export function renderSpecialistEvaluationJson(report: SpecialistEvaluationReport): string {
  return `${stableJson(report)}\n`;
}

export function renderSpecialistEvaluationMarkdown(report: SpecialistEvaluationReport): string {
  const lines = [
    '# Specialist review evaluation',
    '',
    `- Corpus digest: \`${report.corpusDigest}\``,
    `- Gate: ${report.thresholdFailures.length === 0 ? 'pass' : 'fail'}`,
    `- Specialist precision: ${ratioValue(report.specialists.metrics.precision).toFixed(4)}`,
    `- Specialist recall: ${ratioValue(report.specialists.metrics.recall).toFixed(4)}`,
    `- Auto precision: ${ratioValue(report.auto.metrics.precision).toFixed(4)}`,
    `- Auto recall: ${ratioValue(report.auto.metrics.recall).toFixed(4)}`,
    `- Auto p95 latency: ${report.auto.metrics.latencyMs.p95} ms`,
    '',
    '| Mode | Case | Selected | Reasons | Shards | Candidates | Merge rejected | Reserved tokens |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...[
      ...report.specialistCases.map((item) => ({ mode: 'specialists', item })),
      ...report.autoCases.map((item) => ({ mode: 'auto', item })),
    ].map(
      ({ mode, item }) =>
        `| ${mode} | ${item.caseId} | ${item.selected} | ${item.reasons.join(', ')} | ${item.rolesCompleted} | ${item.validatedCandidates} | ${item.arbiterRejected} | ${item.reservedTokens} |`,
    ),
    '',
  ];
  if (report.thresholdFailures.length > 0) {
    lines.push('## Threshold failures', '', ...report.thresholdFailures.map((failure) => `- ${failure}`), '');
  }
  return `${lines.join('\n')}\n`;
}
