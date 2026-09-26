import { createHash } from 'node:crypto';
import {
  packReviewContext,
  serializeReviewContext,
  type ContextRuntimeSummary,
  type ReviewContextBundle,
  type ReviewContextItem,
} from './context-planner';
import type { PullRequestDiff } from './github';
import type { FindingCategory } from './review-contract';
import type { ReviewStateFinding } from './review-lifecycle';
import { splitDiffShards } from './review-shards';
import type { PreparedReviewDiff } from './unified-diff';

export const REVIEW_STRATEGY_VERSION = 3 as const;
export const REVIEW_SELECTOR_VERSION = 2 as const;
export const ROLE_CONTEXT_PROJECTION_VERSION = 1 as const;
/** Historical role-set version; kept for state-compat digests. Roles no longer run as passes. */
export const SPECIALIST_ROLE_SET_VERSION = 1 as const;
export const SHARD_STRATEGY_VERSION = 1 as const;
export const MAX_FINDINGS_PER_SHARD = 3;
export const MAX_RAW_SHARD_FINDINGS = 24;
export const MAX_ARBITER_CANDIDATES = 10;
export const MAX_SHARD_CONTEXT_BYTES = 20_000;
export const MAX_ARBITER_CONTEXT_BYTES = 12_000;
export const MAX_ARBITER_PROMPT_BYTES = 100_000;
export const SHARD_REQUEST_OVERHEAD_TOKENS = 1_024;
export const SPECIALIST_MAX_OUTPUT_TOKENS = 4_096;
export const ARBITER_MAX_OUTPUT_TOKENS = 2_048;
export const REASONING_SPECIALIST_MAX_OUTPUT_TOKENS = 65_536;
export const REASONING_ARBITER_MAX_OUTPUT_TOKENS = 32_768;

/** Fixed review dimensions a sharded prompt covers in one pass. */
export const SHARD_REVIEW_DIMENSIONS = ['correctness', 'security', 'testing', 'compatibility'] as const;
export type SpecialistRole = (typeof SHARD_REVIEW_DIMENSIONS)[number];
export type RequestedReviewStrategy = 'single-pass' | 'specialists' | 'auto';
export type SelectedReviewStrategy = 'single-pass' | 'sharded';
export type ReviewStrategyReason =
  | 'forced-single-pass'
  | 'forced-sharded'
  | 'diff-truncated'
  | 'many-files'
  | 'many-changed-lines'
  | 'large-model-diff'
  | 'partial-analyzer-coverage'
  | 'sensitive-surface'
  | 'low-risk'
  /** The auto plan was escalated to sharded, but the deterministic shard split yields one shard. */
  | 'single-shard-plan';

export interface ReviewStrategyPlan {
  version: typeof REVIEW_STRATEGY_VERSION;
  requested: RequestedReviewStrategy;
  selected: SelectedReviewStrategy;
  reasons: ReviewStrategyReason[];
}

export const ROLE_CATEGORY: Readonly<Record<SpecialistRole, FindingCategory>> = Object.freeze({
  correctness: 'correctness',
  security: 'security',
  testing: 'testing',
  compatibility: 'regression',
});

const reasonOrder: readonly ReviewStrategyReason[] = [
  'diff-truncated',
  'many-files',
  'many-changed-lines',
  'large-model-diff',
  'partial-analyzer-coverage',
  'sensitive-surface',
];

const SENSITIVE_PATH_SEGMENTS = new Set([
  '.github',
  'action',
  'actions',
  'api',
  'apis',
  'auth',
  'authentication',
  'authorization',
  'config',
  'configs',
  'configuration',
  'credential',
  'credentials',
  'crypto',
  'migration',
  'migrations',
  'permission',
  'permissions',
  'route',
  'routes',
  'schema',
  'schemas',
  'secret',
  'secrets',
  'security',
  'session',
  'sessions',
  'token',
  'tokens',
  'workflow',
  'workflows',
]);
const SENSITIVE_FILENAMES = new Set([
  'action.yml',
  'action.yaml',
  'dockerfile',
  'containerfile',
  'compose.yml',
  'compose.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'deno.json',
  'deno.jsonc',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'gemfile',
  'gemfile.lock',
  'composer.json',
  'composer.lock',
]);

const CONTAINERFILE_BACKUP_SUFFIXES = new Set([
  'bak',
  'backup',
  'copy',
  'old',
  'orig',
  'original',
  'save',
  'saved',
  'swp',
  'temp',
  'tmp',
]);

function isSensitiveFilename(name: string): boolean {
  if (SENSITIVE_FILENAMES.has(name)) return true;
  const match = /^(?:dockerfile|containerfile)\.([a-z0-9][a-z0-9-]{0,31})$/u.exec(name);
  return match !== null && !CONTAINERFILE_BACKUP_SUFFIXES.has(match[1] as string);
}

function sensitivePath(path: string): boolean {
  const segments = path.toLowerCase().split('/').filter(Boolean);
  if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment))) return true;
  const name = segments.at(-1) ?? '';
  if (isSensitiveFilename(name)) return true;
  if (/^requirements(?:[._-][a-z0-9-]+)?\.txt$/u.test(name)) return true;
  return name
    .split(/[._-]+/u)
    .filter(Boolean)
    .some((token) => SENSITIVE_PATH_SEGMENTS.has(token) || token === 'interface');
}

/**
 * Deterministic shard-plan size for the exact diff the executor would split. Selection and
 * execution use the same split function and caps, so a sharded selection can never observe a
 * different shard count than the executor recomputes from the same full diff.
 */
function plannedShardCount(diff: PullRequestDiff): number {
  const parsed = diff.completeParsed ?? diff.parsed;
  if (!parsed) throw new Error('Review strategy selection requires an authoritative parsed diff');
  const prepared: PreparedReviewDiff = {
    text: diff.text,
    originalBytes: diff.originalBytes,
    truncated: diff.truncated,
    totalFiles: diff.totalFiles ?? 0,
    parsed,
    completeParsed: parsed,
  };
  const { shards, leftoverShard } = splitDiffShards(prepared);
  return shards.length + (leftoverShard ? 1 : 0);
}

export function selectReviewStrategy(input: {
  requested: RequestedReviewStrategy;
  diff: PullRequestDiff;
  analyzerCoverage: 'complete' | 'partial';
}): ReviewStrategyPlan {
  if (input.requested === 'single-pass') {
    return {
      version: REVIEW_STRATEGY_VERSION,
      requested: input.requested,
      selected: 'single-pass',
      reasons: ['forced-single-pass'],
    };
  }
  if (input.requested === 'specialists') {
    return {
      version: REVIEW_STRATEGY_VERSION,
      requested: input.requested,
      selected: 'sharded',
      reasons: ['forced-sharded'],
    };
  }
  const parsed = input.diff.completeParsed ?? input.diff.parsed;
  if (!parsed) throw new Error('Review strategy selection requires an authoritative parsed diff');
  const commentable = parsed.files.filter((file) => file.commentable);
  const changedLines = commentable.reduce(
    (count, file) =>
      count +
      file.hunks.reduce(
        (fileCount, hunk) =>
          fileCount + hunk.lines.filter((line) => line.kind === 'addition' || line.kind === 'deletion').length,
        0,
      ),
    0,
  );
  const reasons = new Set<ReviewStrategyReason>();
  if (input.diff.truncated) reasons.add('diff-truncated');
  if (commentable.length > 2) reasons.add('many-files');
  if (changedLines > 80) reasons.add('many-changed-lines');
  if (Buffer.byteLength(input.diff.text, 'utf8') > 24 * 1_024) reasons.add('large-model-diff');
  if (input.analyzerCoverage === 'partial') reasons.add('partial-analyzer-coverage');
  if (
    parsed.files.some((file) =>
      [file.oldPath, file.newPath].some((path) => typeof path === 'string' && sensitivePath(path)),
    )
  ) {
    reasons.add('sensitive-surface');
  }
  const ordered = reasonOrder.filter((reason) => reasons.has(reason));
  if (ordered.length === 0) {
    return {
      version: REVIEW_STRATEGY_VERSION,
      requested: input.requested,
      selected: 'single-pass',
      reasons: ['low-risk'],
    };
  }
  // Degenerate single-shard guard: a sharded plan over one shard only adds shard overhead and
  // turns one malformed response into a fully degraded run, so it executes as a single pass.
  if (plannedShardCount(input.diff) <= 1) {
    return {
      version: REVIEW_STRATEGY_VERSION,
      requested: input.requested,
      selected: 'single-pass',
      reasons: [...ordered, 'single-shard-plan'],
    };
  }
  return { version: REVIEW_STRATEGY_VERSION, requested: input.requested, selected: 'sharded', reasons: ordered };
}

function runtimeFromBundle(bundle: ReviewContextBundle): ContextRuntimeSummary {
  const metadata = bundle.metadata;
  return {
    indexer: metadata.indexer,
    ...(metadata.deterministicAnalysis ? { deterministicAnalysis: metadata.deterministicAnalysis } : {}),
    anchorsPlanned: metadata.anchorsPlanned,
    queriesPlanned: metadata.queriesPlanned,
    queriesCompleted: metadata.queriesCompleted,
    queriesTimedOut: metadata.queriesTimedOut,
    queryByteLimitHits: metadata.queryByteLimitHits,
    queryBudgetSkipped: metadata.queryBudgetSkipped,
    guidance: metadata.guidance,
    configuration: metadata.configuration,
    linkedIssues: metadata.linkedIssues,
  };
}

function sharedContextItem(item: ReviewContextItem): boolean {
  return ['base-guidance', 'base-configuration', 'github-issue', 'deterministic-analysis'].includes(item.source.source);
}

/**
 * Projects the shard review context: shared trust-boundary context plus every code-index query
 * kind, capped at the shard context ceiling. One shard prompt covers all review dimensions, so it
 * keeps the union of the former per-role query sets instead of a per-role subset.
 */
export function projectReviewContextForShard(bundle: ReviewContextBundle): ReviewContextBundle {
  const items = bundle.items.filter(
    (item) => sharedContextItem(item) || (item.source.source === 'code-index' && item.source.queryKind !== undefined),
  );
  return packReviewContext(items, runtimeFromBundle(bundle), MAX_SHARD_CONTEXT_BYTES);
}

export function projectArbiterContext(bundle: ReviewContextBundle): ReviewContextBundle {
  return packReviewContext(
    bundle.items.filter(sharedContextItem),
    runtimeFromBundle(bundle),
    MAX_ARBITER_CONTEXT_BYTES,
  );
}

export function priorFindingsForShard(findings: readonly ReviewStateFinding[]): ReviewStateFinding[] {
  return findings.slice(0, MAX_FINDINGS_PER_SHARD);
}

export function shardOutputTokens(maximumOutputTokens: number, reasoning = false): number {
  const limit = reasoning ? REASONING_SPECIALIST_MAX_OUTPUT_TOKENS : SPECIALIST_MAX_OUTPUT_TOKENS;
  return Math.min(maximumOutputTokens, limit);
}

export function arbiterOutputTokens(maximumOutputTokens: number, reasoning = false): number {
  const limit = reasoning ? REASONING_ARBITER_MAX_OUTPUT_TOKENS : ARBITER_MAX_OUTPUT_TOKENS;
  return Math.min(maximumOutputTokens, limit);
}

export function reserveShardTokens(input: {
  prompts: readonly string[];
  maximumOutputTokens: number;
  reasoning?: boolean;
}): number {
  const shardOutput = shardOutputTokens(input.maximumOutputTokens, input.reasoning);
  return (
    input.prompts.reduce(
      (total, prompt) => total + Buffer.byteLength(prompt, 'utf8') + SHARD_REQUEST_OVERHEAD_TOKENS + shardOutput,
      0,
    ) +
    MAX_ARBITER_PROMPT_BYTES +
    SHARD_REQUEST_OVERHEAD_TOKENS +
    arbiterOutputTokens(input.maximumOutputTokens, input.reasoning)
  );
}

export function reviewStrategyPlanDigest(plan: ReviewStrategyPlan): string {
  return `sha256:${createHash('sha256').update('code-review/execution-plan/v1\0').update(JSON.stringify(plan)).digest('base64url')}`;
}

export function serializedContextBytes(bundle: ReviewContextBundle): number {
  return Buffer.byteLength(serializeReviewContext(bundle), 'utf8');
}
