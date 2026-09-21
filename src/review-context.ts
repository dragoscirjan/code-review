import { createHash } from 'node:crypto';
import type { AnalyzerSummary } from './analyzer';
import type { CodeIndexer } from './config';
import {
  MAX_BASE_GUIDANCE_BYTES_PER_FILE,
  MAX_CONFIGURATION_CONTEXT_BYTES,
  MAX_CONFIGURATION_FILES,
  MAX_ISSUE_RESPONSE_BYTES,
  MAX_ISSUE_TITLE_BYTES,
  MAX_LINKED_ISSUES,
  extractAcceptanceCriteriaWithMetadata,
  extractContextAnchors,
  packReviewContext,
  planBaseConfigurationCandidates,
  planContextQueries,
  truncateUtf8,
  type ContextRuntimeSummary,
  type ContextSourceStatus,
  type ReviewContextBundle,
  type ReviewContextItem,
} from './context-planner';
import {
  extractExplicitSameRepositoryIssueNumbers,
  type GitHubClient,
  type GitHubIssueContext,
  type PullRequestContext,
  type PullRequestDiff,
} from './github';
import { runCodeIndexer } from './indexer';

export const OPTIONAL_CONTEXT_TIMEOUT_MS = 10_000;

function optionalContextReason(error: unknown): 'fetch-timeout' | 'fetch-error' {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    ? 'fetch-timeout'
    : 'fetch-error';
}

export interface LinkedIssueFingerprint {
  number: number;
  digest: string;
}

export interface BuildReviewContextInput {
  client: GitHubClient;
  pullRequest: PullRequestContext;
  diff: PullRequestDiff & Required<Pick<PullRequestDiff, 'parsed'>>;
  indexer: CodeIndexer;
  cacheKey: string;
  cacheTtlMs: number;
  analyzerItems?: readonly ReviewContextItem[];
  analyzerSummary?: AnalyzerSummary;
}

export interface BuiltReviewContext {
  bundle: ReviewContextBundle;
  cacheHit: boolean;
  linkedIssueFingerprints: LinkedIssueFingerprint[];
}

function digestIssue(issue: GitHubIssueContext): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        updatedAt: issue.updatedAt,
        isPullRequest: issue.isPullRequest,
      }),
    )
    .digest('hex');
}

function guidanceItem(
  sourceId: 'AGENTS.md' | 'CONTRIBUTING.md',
  revision: string,
  status: ContextSourceStatus,
  acquiredBytes: number,
  content?: string,
  reason?: string,
  blobSha?: string,
): ReviewContextItem {
  return {
    source: {
      source: 'base-guidance',
      sourceId,
      revision,
      status,
      acquiredBytes,
      includedBytes: 0,
      ...(reason ? { reason } : {}),
      ...(blobSha ? { blobSha } : {}),
    },
    ...(content === undefined ? {} : { content }),
  };
}

/** Collects exact-base guidance, explicit issue criteria, and bounded index results into one untrusted envelope. */
export async function buildReviewContext(input: BuildReviewContextInput): Promise<BuiltReviewContext> {
  const candidates: ReviewContextItem[] = [];
  const guidanceStatuses: { agents: ContextSourceStatus; contributing: ContextSourceStatus } = {
    agents: 'unavailable',
    contributing: 'unavailable',
  };
  for (const [path, key] of [
    ['AGENTS.md', 'agents'],
    ['CONTRIBUTING.md', 'contributing'],
  ] as const) {
    try {
      const result = await input.client.getRepositoryTextAtRevision(
        input.pullRequest,
        path,
        input.pullRequest.baseSha,
        MAX_BASE_GUIDANCE_BYTES_PER_FILE,
        AbortSignal.timeout(OPTIONAL_CONTEXT_TIMEOUT_MS),
      );
      const status: ContextSourceStatus =
        result.status === 'found' ? (result.truncated ? 'truncated' : 'included') : 'unavailable';
      guidanceStatuses[key] = status;
      candidates.push(
        guidanceItem(path, input.pullRequest.baseSha, status, result.bytes, result.text, result.reason, result.blobSha),
      );
    } catch (error) {
      guidanceStatuses[key] = 'unavailable';
      candidates.push(
        guidanceItem(path, input.pullRequest.baseSha, 'unavailable', 0, undefined, optionalContextReason(error)),
      );
    }
  }

  const configurationPlans = planBaseConfigurationCandidates(input.diff.parsed);
  let configurationIncluded = 0;
  let configurationUnavailable = 0;
  let configurationTruncated = 0;
  let configurationBytesRemaining = MAX_CONFIGURATION_CONTEXT_BYTES;
  const configurationSignal = AbortSignal.timeout(OPTIONAL_CONTEXT_TIMEOUT_MS);
  for (const plan of configurationPlans) {
    if (configurationIncluded >= MAX_CONFIGURATION_FILES || configurationBytesRemaining <= 0) break;
    try {
      const result = await input.client.getRepositoryTextAtRevision(
        input.pullRequest,
        plan.path,
        input.pullRequest.baseSha,
        configurationBytesRemaining,
        configurationSignal,
      );
      if (result.status !== 'found') {
        configurationUnavailable += 1;
        candidates.push({
          source: {
            source: 'base-configuration',
            sourceId: plan.path,
            revision: input.pullRequest.baseSha,
            status: 'unavailable',
            acquiredBytes: result.bytes,
            includedBytes: 0,
            reason: result.reason,
          },
        });
        continue;
      }
      const content = result.text ?? '';
      const includedBytes = Buffer.byteLength(content, 'utf8');
      configurationBytesRemaining -= includedBytes;
      configurationIncluded += 1;
      if (result.truncated) configurationTruncated += 1;
      candidates.push({
        source: {
          source: 'base-configuration',
          sourceId: plan.path,
          revision: input.pullRequest.baseSha,
          status: result.truncated ? 'truncated' : 'included',
          acquiredBytes: result.bytes,
          includedBytes: 0,
          ...(result.blobSha ? { blobSha: result.blobSha } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        },
        content,
      });
    } catch (error) {
      configurationUnavailable += 1;
      candidates.push({
        source: {
          source: 'base-configuration',
          sourceId: plan.path,
          revision: input.pullRequest.baseSha,
          status: 'unavailable',
          acquiredBytes: 0,
          includedBytes: 0,
          reason: optionalContextReason(error),
        },
      });
    }
  }

  const allIssueNumbers = extractExplicitSameRepositoryIssueNumbers(
    input.pullRequest,
    input.pullRequest.title,
    input.pullRequest.body,
    100,
  );
  const issueNumbers = allIssueNumbers.slice(0, MAX_LINKED_ISSUES);
  const linkedIssueFingerprints: LinkedIssueFingerprint[] = [];
  let issuesFetched = 0;
  let issuesUnavailable = allIssueNumbers.length - issueNumbers.length;
  for (const number of allIssueNumbers.slice(MAX_LINKED_ISSUES)) {
    candidates.push({
      source: {
        source: 'github-issue',
        sourceId: `issue:${number}`,
        status: 'unsupported',
        acquiredBytes: 0,
        includedBytes: 0,
        reason: 'reference-limit',
      },
    });
  }
  for (const number of issueNumbers) {
    try {
      const issue = await input.client.getIssueContext(
        input.pullRequest,
        number,
        MAX_ISSUE_RESPONSE_BYTES,
        AbortSignal.timeout(OPTIONAL_CONTEXT_TIMEOUT_MS),
      );
      linkedIssueFingerprints.push({ number, digest: digestIssue(issue) });
      const criteriaResult = issue.isPullRequest ? undefined : extractAcceptanceCriteriaWithMetadata(issue);
      if (!criteriaResult) {
        issuesUnavailable += 1;
        candidates.push({
          source: {
            source: 'github-issue',
            sourceId: `issue:${number}`,
            status: 'unavailable',
            acquiredBytes: Buffer.byteLength(issue.body, 'utf8'),
            includedBytes: 0,
            reason: issue.isPullRequest ? 'pull-request-reference' : 'acceptance-section-missing',
          },
        });
        continue;
      }
      issuesFetched += 1;
      const issueTitle = truncateUtf8(issue.title, MAX_ISSUE_TITLE_BYTES);
      const content = JSON.stringify({
        number: issue.number,
        title: issueTitle.value,
        acceptanceCriteria: criteriaResult.criteria,
        updatedAt: issue.updatedAt,
      });
      candidates.push({
        source: {
          source: 'github-issue',
          sourceId: `issue:${number}`,
          status: issueTitle.truncated || criteriaResult.truncated ? 'truncated' : 'included',
          acquiredBytes: Buffer.byteLength(issue.body, 'utf8'),
          includedBytes: 0,
        },
        content,
      });
    } catch (error) {
      issuesUnavailable += 1;
      candidates.push({
        source: {
          source: 'github-issue',
          sourceId: `issue:${number}`,
          status: 'unavailable',
          acquiredBytes: 0,
          includedBytes: 0,
          reason: optionalContextReason(error) === 'fetch-timeout' ? 'fetch-timeout' : 'not-found-or-forbidden',
        },
      });
    }
  }

  candidates.push(...(input.analyzerItems ?? []));

  const anchors = extractContextAnchors(input.diff.parsed);
  const queries = planContextQueries(anchors);
  let cacheHit = false;
  let queriesCompleted = 0;
  let queriesTimedOut = 0;
  let queryByteLimitHits = 0;
  let queryBudgetSkipped = 0;
  if (input.indexer === 'none') {
    candidates.push({
      source: {
        source: 'code-index',
        sourceId: 'indexer',
        status: 'disabled',
        acquiredBytes: 0,
        includedBytes: 0,
        reason: 'not-selected',
      },
    });
  } else {
    const result = await runCodeIndexer({
      indexer: input.indexer,
      cacheKey: input.cacheKey,
      cacheTtlMs: input.cacheTtlMs,
      github: input.client,
      pullRequest: input.pullRequest,
      queries,
    });
    cacheHit = result.cacheHit;
    for (const queryResult of result.results) {
      if (['included', 'empty', 'truncated'].includes(queryResult.status)) queriesCompleted += 1;
      if (queryResult.status === 'timed-out') queriesTimedOut += 1;
      if (queryResult.reason === 'query-output-limit') queryByteLimitHits += 1;
      if (queryResult.status === 'budget-exhausted') queryBudgetSkipped += 1;
      const content = queryResult.content
        ? JSON.stringify({
            anchor: queryResult.query.anchor.value,
            anchorKind: queryResult.query.anchor.kind,
            path: queryResult.query.anchor.path,
            language: queryResult.query.anchor.language,
            provenance: queryResult.query.anchor.provenance,
            result: queryResult.content,
          })
        : undefined;
      candidates.push({
        source: {
          source: 'code-index',
          sourceId: queryResult.query.id,
          revision: input.pullRequest.baseSha,
          indexer: result.indexer,
          indexerVersion: result.version,
          queryId: queryResult.query.id,
          queryKind: queryResult.query.kind,
          status: queryResult.status,
          acquiredBytes: queryResult.acquiredBytes,
          includedBytes: 0,
          ...(queryResult.reason ? { reason: queryResult.reason } : {}),
        },
        ...(content === undefined ? {} : { content }),
      });
    }
  }

  const runtime: ContextRuntimeSummary = {
    indexer: input.indexer,
    ...(input.analyzerSummary
      ? {
          deterministicAnalysis: {
            mode: input.analyzerSummary.mode,
            configStatus: input.analyzerSummary.configStatus,
            coverage: input.analyzerSummary.coverage,
            runCount: input.analyzerSummary.runCount,
            acceptedObservations: input.analyzerSummary.acceptedObservations,
            skippedFiles: input.analyzerSummary.skippedFiles,
            outOfScopeObservations: input.analyzerSummary.outOfScopeObservations,
            contextTruncated: input.analyzerSummary.contextTruncated,
            unavailableSourceCount: input.analyzerSummary.unavailableSourceCount,
          },
        }
      : {}),
    anchorsPlanned: anchors.length,
    queriesPlanned: input.indexer === 'none' ? 0 : queries.length,
    queriesCompleted,
    queriesTimedOut,
    queryByteLimitHits,
    queryBudgetSkipped,
    guidance: guidanceStatuses,
    configuration: {
      candidates: configurationPlans.length,
      included: configurationIncluded,
      unavailable: configurationUnavailable,
      truncated: configurationTruncated,
    },
    linkedIssues: {
      discovered: allIssueNumbers.length,
      fetched: issuesFetched,
      unavailable: issuesUnavailable,
    },
  };
  return { bundle: packReviewContext(candidates, runtime), cacheHit, linkedIssueFingerprints };
}

export async function assertLinkedIssuesFresh(
  client: GitHubClient,
  pullRequest: PullRequestContext,
  fingerprints: readonly LinkedIssueFingerprint[],
): Promise<void> {
  for (const expected of fingerprints) {
    let issue: GitHubIssueContext;
    try {
      issue = await client.getIssueContext(
        pullRequest,
        expected.number,
        MAX_ISSUE_RESPONSE_BYTES,
        AbortSignal.timeout(OPTIONAL_CONTEXT_TIMEOUT_MS),
      );
    } catch {
      throw new Error('Linked issue context changed during review');
    }
    if (digestIssue(issue) !== expected.digest) throw new Error('Linked issue context changed during review');
  }
}
