import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DeterministicAnalysis } from './analyzer';
import { DEFAULT_OPENCODE_VERSION, DEFAULT_PI_VERSION } from './config';
import { packReviewContext, type ContextRuntimeSummary } from './context-planner';
import { loadModelConfiguration } from './model';
import { ReviewExecutionError, runReview } from './review';
import {
  evaluateReviewCorpus,
  MAX_EVALUATION_CORPUS_BYTES,
  MAX_EVALUATION_THRESHOLD_BYTES,
  evaluationDiff,
  evaluationPullRequest,
  parseEvaluationCorpus,
  parseEvaluationThresholds,
  renderEvaluationJson,
  renderEvaluationMarkdown,
  type EvaluationRunner,
} from './review-evaluation';
import {
  createEvaluationOutputDirectory,
  SPECIALIST_EVALUATION_JSON_FILENAME,
  SPECIALIST_EVALUATION_MARKDOWN_FILENAME,
  writeEvaluationArtifacts,
} from './review-evaluation-artifacts';
import {
  evaluateSpecialistRecordings,
  MAX_SPECIALIST_EVALUATION_BYTES,
  parseSpecialistEvaluationRecordings,
  parseSpecialistEvaluationThresholds,
  renderSpecialistEvaluationJson,
  renderSpecialistEvaluationMarkdown,
} from './review-specialist-evaluation';
import { executeReviewStrategy } from './review-specialists';
import { selectReviewStrategy, type RequestedReviewStrategy } from './review-strategy';

const CORPUS_PATH = 'test/fixtures/review-evaluation/corpus.v1.json';
const THRESHOLDS_PATH = 'test/fixtures/review-evaluation/thresholds.v1.json';
const SPECIALISTS_PATH = 'test/fixtures/review-evaluation/specialists.v1.json';
const SPECIALIST_THRESHOLDS_PATH = 'test/fixtures/review-evaluation/specialist-thresholds.v1.json';

async function readFixedRegularFile(path: string, maximumBytes: number): Promise<string> {
  const absolute = resolve(path);
  const details = await lstat(absolute);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || details.size > maximumBytes) {
    throw new Error('Evaluation input must be a bounded checked-in regular file');
  }
  const bytes = await readFile(absolute);
  if (bytes.length > maximumBytes) throw new Error('Evaluation input exceeds its byte limit');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Evaluation input must be valid UTF-8');
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new Error('Live evaluation timeout must be an integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 30 || parsed > maximum) {
    throw new Error(`Live evaluation timeout must be between 30 and ${maximum}`);
  }
  return parsed;
}

function evaluationRuntime(analyzer: DeterministicAnalysis): ContextRuntimeSummary {
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

export async function main(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const allowed = new Set(['--check', '--live']);
  if (args.some((argument) => !allowed.has(argument)) || new Set(args).size !== args.length) {
    throw new Error('Accepted evaluation arguments are --check and --live');
  }
  const live = args.includes('--live');
  const check = args.includes('--check');
  if (live && environment.RUN_LLM_EVALUATION !== '1') {
    throw new Error('Live evaluation requires RUN_LLM_EVALUATION=1');
  }
  const corpus = parseEvaluationCorpus(await readFixedRegularFile(CORPUS_PATH, MAX_EVALUATION_CORPUS_BYTES));
  const absoluteThresholds = parseEvaluationThresholds(
    await readFixedRegularFile(THRESHOLDS_PATH, MAX_EVALUATION_THRESHOLD_BYTES),
  );
  const thresholds = check ? absoluteThresholds : undefined;
  let runner: EvaluationRunner | undefined;
  let backend: 'opencode' | 'pi' | null = null;
  let model: string | null = null;
  let secrets: readonly string[] = [];
  if (live) {
    const modelConfig = environment.REVIEW_EVALUATION_MODEL_CONFIG;
    if (!modelConfig) throw new Error('Live evaluation requires REVIEW_EVALUATION_MODEL_CONFIG');
    const loaded = loadModelConfiguration(modelConfig, environment.REVIEW_EVALUATION_MODEL_CREDENTIALS ?? '{}');
    const requestedBackend = environment.REVIEW_EVALUATION_BACKEND ?? 'opencode';
    if (requestedBackend !== 'opencode' && requestedBackend !== 'pi')
      throw new Error('Invalid live evaluation backend');
    const engine = environment.CONTAINER_ENGINE ?? 'podman';
    if (engine !== 'podman' && engine !== 'docker') throw new Error('Invalid live evaluation container engine');
    backend = requestedBackend;
    model = loaded.connection.modelId;
    secrets = loaded.credentialValues;
    const timeoutMs = parsePositiveInteger(environment.REVIEW_EVALUATION_TIMEOUT_SECONDS, 600, 900) * 1_000;
    const strategy = (environment.REVIEW_EVALUATION_STRATEGY ?? 'single-pass') as RequestedReviewStrategy;
    if (strategy !== 'single-pass' && strategy !== 'specialists' && strategy !== 'auto') {
      throw new Error('Invalid live evaluation strategy');
    }
    const specialistTokenBudget = parsePositiveInteger(
      environment.REVIEW_EVALUATION_SPECIALIST_TOKEN_BUDGET,
      300_000,
      2_000_000,
    );
    if (specialistTokenBudget < 20_000) throw new Error('Live specialist token budget must be at least 20000');
    runner = async ({ fixture, analyzer }) => {
      const reviewContext = packReviewContext(analyzer.contextItems, evaluationRuntime(analyzer));
      const diff = evaluationDiff(fixture);
      try {
        const executed = await executeReviewStrategy({
          plan: selectReviewStrategy({ requested: strategy, diff, analyzerCoverage: analyzer.summary.coverage }),
          backend: requestedBackend,
          containerEngine: engine,
          connection: loaded.connection,
          opencodeVersion: DEFAULT_OPENCODE_VERSION,
          piVersion: DEFAULT_PI_VERSION,
          customPrompt: 'Evaluate the supplied seeded change under the fixed review policy.',
          timeoutMs,
          specialistTokenBudget,
          pullRequest: evaluationPullRequest(fixture),
          diff,
          reviewContext,
          priorFindings: [],
          policy: { minimumConfidence: 0, maximumInlineComments: 10 },
          secrets,
          environment,
          assertFresh: async () => undefined,
          singleRunner: runReview,
        });
        return { status: 'valid', review: executed.review, latencyMs: 0 };
      } catch (error) {
        return {
          status:
            error instanceof ReviewExecutionError && error.kind === 'malformed-output'
              ? 'malformed-output'
              : 'execution-failure',
          latencyMs: 0,
        };
      }
    };
  }
  const report = await evaluateReviewCorpus({
    corpus,
    mode: live ? 'live' : 'recorded',
    runner,
    thresholds,
    backend,
    model,
    secrets,
  });
  const outputDirectory = await createEvaluationOutputDirectory(environment.REVIEW_EVALUATION_OUTPUT_DIR, environment);
  const artifacts = await writeEvaluationArtifacts({
    outputDirectory,
    json: renderEvaluationJson(report),
    markdown: renderEvaluationMarkdown(report),
    secrets,
  });
  const thresholdFailures = [...report.thresholdFailures];
  let specialistArtifactMessage = '';
  if (!live) {
    const recordings = parseSpecialistEvaluationRecordings(
      await readFixedRegularFile(SPECIALISTS_PATH, MAX_SPECIALIST_EVALUATION_BYTES),
      corpus,
    );
    const specialistThresholds = parseSpecialistEvaluationThresholds(
      await readFixedRegularFile(SPECIALIST_THRESHOLDS_PATH, MAX_EVALUATION_THRESHOLD_BYTES),
    );
    const specialistReport = await evaluateSpecialistRecordings({
      corpus,
      recordings,
      thresholds: specialistThresholds,
      baseline: report,
      absoluteThresholds,
    });
    thresholdFailures.push(...specialistReport.thresholdFailures);
    const specialistArtifacts = await writeEvaluationArtifacts({
      outputDirectory,
      json: renderSpecialistEvaluationJson(specialistReport),
      markdown: renderSpecialistEvaluationMarkdown(specialistReport),
      secrets,
      requireEmpty: false,
      filenames: {
        json: SPECIALIST_EVALUATION_JSON_FILENAME,
        markdown: SPECIALIST_EVALUATION_MARKDOWN_FILENAME,
      },
    });
    specialistArtifactMessage = `; specialist reports: ${specialistArtifacts.jsonPath} and ${specialistArtifacts.markdownPath}`;
  }
  console.log(`Evaluation reports: ${artifacts.jsonPath} and ${artifacts.markdownPath}${specialistArtifactMessage}`);
  if (check && thresholdFailures.length > 0) {
    console.error(`Evaluation thresholds failed: ${thresholdFailures.join(', ')}`);
    return 1;
  }
  return 0;
}
