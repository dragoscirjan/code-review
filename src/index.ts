import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { emptyDeterministicAnalysis, runDeterministicAnalysis } from './analyzer';
import { loadAnalyzerConfiguration } from './analyzer-config';
import { getActionInput, loadActionConfig, managedCommentMarkers } from './config';
import { truncateUtf8 } from './context-planner';
import { GitHubClient, loadPullRequestEvent, selectManagedComment } from './github';
import { planIncrementalReview } from './incremental-review';
import { redactSecrets } from './model';
import { MAX_REVIEW_PR_AUTHOR_BYTES, MAX_REVIEW_PR_BODY_BYTES, MAX_REVIEW_PR_TITLE_BYTES, runReview } from './review';
import { assertLinkedIssuesFresh, buildReviewContext } from './review-context';
import {
  parseReviewState,
  reviewInputDigest,
  reviewPolicyDigest,
  stateIdentityMatches,
  stateScopeMatches,
  type ReviewStateV1,
} from './review-lifecycle';
import { executeAndPublishReview } from './review-publication';
import { acquireReviewedSnapshot, assertSnapshotFresh, SNAPSHOT_DIFF_TIMEOUT_MS } from './review-snapshot';

function workflowCommandValue(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

async function setOutput(name: string, value: string): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const delimiter = `code_review_${randomUUID()}`;
  await appendFile(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, 'utf8');
}

const secrets: string[] = [];

async function main(): Promise<void> {
  for (const name of ['github-token', 'model-credentials']) {
    const value = getActionInput(name, process.env);
    if (value) secrets.push(value);
  }
  const config = loadActionConfig();
  secrets.push(...config.modelCredentialValues);
  for (const secret of secrets) console.log(`::add-mask::${workflowCommandValue(secret)}`);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');

  const pullRequest = await loadPullRequestEvent(eventPath);
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const client = new GitHubClient(config.githubToken, apiUrl);
  console.log(
    `Reviewing ${pullRequest.owner}/${pullRequest.repository}#${pullRequest.number} at ${pullRequest.headSha.slice(0, 12)} with ${config.backend}`,
  );
  const snapshot = await acquireReviewedSnapshot(client, pullRequest, config.maxDiffBytes);
  const authoritativePullRequest = snapshot.pullRequest;
  const fullDiff = snapshot.diff;
  const actor = await client.getAuthenticatedActor();
  const analyzerConfiguration = await loadAnalyzerConfiguration({
    client,
    pullRequest: authoritativePullRequest,
    mode: config.deterministicAnalyzers,
  });
  const analyzer =
    analyzerConfiguration.analyzers.length === 0
      ? emptyDeterministicAnalysis(analyzerConfiguration)
      : await runDeterministicAnalysis({
          client,
          pullRequest: authoritativePullRequest,
          diff: fullDiff,
          configuration: analyzerConfiguration,
          secrets,
          assertFresh: () => assertSnapshotFresh(client, authoritativePullRequest, snapshot.revision),
        });
  console.log(
    `Fetched ${fullDiff.originalBytes} diff bytes${fullDiff.truncated ? `; safely limited to ${config.maxDiffBytes}` : ''}`,
  );

  const markers = managedCommentMarkers(config.backend);
  const managedSelection = selectManagedComment(await client.listComments(authoritativePullRequest), actor.id, markers);
  if (managedSelection.kind === 'ambiguous') throw new Error('Managed review comment ownership is ambiguous');
  const policyDigest = reviewPolicyDigest({
    backend: config.backend,
    model: config.connection.modelId,
    modelApi: config.connection.api,
    modelBaseUrl: config.connection.baseUrl,
    modelNetwork: config.connection.network,
    contextWindow: config.connection.contextWindow,
    maximumOutputTokens: config.connection.maxOutputTokens,
    containerEngine: config.containerEngine,
    customPrompt: config.prompt,
    minimumConfidence: config.minimumConfidence,
    maximumInlineComments: config.maxInlineComments,
    maximumDiffBytes: config.maxDiffBytes,
    indexer: config.codeIndexer,
    opencodeVersion: config.opencodeVersion,
    piVersion: config.piVersion,
    deterministicAnalyzerManifestDigest: analyzerConfiguration.manifestDigest,
  });
  if (config.codeIndexer !== 'none') {
    console.log(`Installing and running ${config.codeIndexer} against the exact base revision`);
  }
  const reviewContext = await buildReviewContext({
    client,
    pullRequest: authoritativePullRequest,
    diff: fullDiff,
    indexer: config.codeIndexer,
    cacheKey: config.codeIndexCacheKey,
    cacheTtlMs: config.codeIndexCacheTtlMs,
    analyzerItems: analyzer.contextItems,
    analyzerSummary: analyzer.summary,
  });
  const codeIndexCacheHit = reviewContext.cacheHit;
  console.log(
    `Prepared ${reviewContext.bundle.metadata.includedBytes} bounded review context bytes${codeIndexCacheHit ? ' from a fresh index cache' : ''}`,
  );
  const inputDigest = reviewInputDigest({
    policyDigest,
    pullRequest: {
      title: truncateUtf8(authoritativePullRequest.title, MAX_REVIEW_PR_TITLE_BYTES).value,
      body: truncateUtf8(authoritativePullRequest.body, MAX_REVIEW_PR_BODY_BYTES).value,
      author: truncateUtf8(authoritativePullRequest.author, MAX_REVIEW_PR_AUTHOR_BYTES).value,
    },
    contextDigest: reviewContext.bundle.digest,
    analyzerResultDigest: analyzer.report.resultDigest,
    linkedIssues: reviewContext.linkedIssueFingerprints,
  });

  let baselineState: ReviewStateV1 | undefined;
  let reuseAllowed = false;
  let fallbackReason =
    managedSelection.kind === 'none'
      ? 'no-managed-summary'
      : managedSelection.kind === 'legacy'
        ? 'legacy-summary'
        : 'invalid-state';
  if (managedSelection.kind === 'current') {
    const parsed = parseReviewState(managedSelection.comment.body, markers[0] as string);
    const expectedIdentity = {
      apiUrl,
      repository: `${authoritativePullRequest.owner}/${authoritativePullRequest.repository}`,
      pullRequest: authoritativePullRequest.number,
      backend: config.backend,
      actorId: actor.id,
      baseSha: authoritativePullRequest.baseSha,
    };
    if (parsed.kind === 'valid' && stateIdentityMatches(parsed.state, expectedIdentity)) {
      baselineState = parsed.state;
      reuseAllowed = stateScopeMatches(parsed.state, {
        ...expectedIdentity,
        policyDigest,
        reviewInputDigest: inputDigest,
      });
      fallbackReason = reuseAllowed ? 'compare-unavailable' : 'review-input-mismatch';
    } else {
      fallbackReason = parsed.kind === 'unsupported' ? 'unsupported-state-version' : 'invalid-or-mismatched-state';
    }
  }

  let compare;
  if (
    reuseAllowed &&
    baselineState?.coverageComplete &&
    baselineState.completedThroughHeadSha &&
    baselineState.completedThroughHeadSha !== authoritativePullRequest.headSha
  ) {
    try {
      await assertSnapshotFresh(client, authoritativePullRequest, snapshot.revision);
      compare = await client.getCompare(
        authoritativePullRequest,
        baselineState.completedThroughHeadSha,
        authoritativePullRequest.headSha,
        AbortSignal.timeout(SNAPSHOT_DIFF_TIMEOUT_MS),
      );
      await assertSnapshotFresh(client, authoritativePullRequest, snapshot.revision);
    } catch {
      fallbackReason = 'compare-unavailable-or-nonlinear';
    }
  }
  const incremental = planIncrementalReview({
    currentDiff: fullDiff,
    currentHeadSha: authoritativePullRequest.headSha,
    maximumDiffBytes: config.maxDiffBytes,
    prior: baselineState,
    compare,
    fallbackReason,
    reuseAllowed,
  });
  const diff = incremental.diff;

  const lease = managedSelection.kind === 'none' ? null : managedSelection.lease;
  const assertStateFresh = () => client.assertManagedCommentLease(authoritativePullRequest, actor, lease, markers);
  const publication = await executeAndPublishReview({
    executeReview: () =>
      incremental.mode === 'no-change'
        ? Promise.resolve({ version: 1 as const, outcome: 'clean' as const, findings: [] as [] })
        : runReview({
            backend: config.backend,
            containerEngine: config.containerEngine,
            connection: config.connection,
            opencodeVersion: config.opencodeVersion,
            piVersion: config.piVersion,
            customPrompt: config.prompt,
            timeoutMs: config.timeoutMs,
            pullRequest: authoritativePullRequest,
            diff,
            reviewContext: reviewContext.bundle,
            priorFindings: incremental.affected,
            secrets,
          }),
    assertFresh: async () => {
      await assertSnapshotFresh(client, authoritativePullRequest, snapshot.revision);
      await assertLinkedIssuesFresh(client, authoritativePullRequest, reviewContext.linkedIssueFingerprints);
    },
    assertStateFresh,
    client,
    pullRequest: authoritativePullRequest,
    diff,
    actor,
    markers,
    backend: config.backend,
    model: config.connection.modelId,
    secrets,
    minimumConfidence: config.minimumConfidence,
    maximumInlineComments: config.maxInlineComments,
    contextMetadata: reviewContext.bundle.metadata,
    analyzer: {
      findings: incremental.mode === 'no-change' ? [] : analyzer.findings,
      summary: analyzer.summary,
    },
    lifecycle: {
      apiUrl,
      policyDigest,
      reviewInputDigest: inputDigest,
      mode: incremental.mode,
      reason: incremental.reason,
      fromHeadSha: incremental.fromHeadSha,
      priorState: incremental.prior,
      carried: incremental.carried,
      affected: incremental.affected,
      lease,
    },
  });

  await setOutput('comment-url', publication.comment.html_url);
  await setOutput('review-url', publication.inlineReview?.html_url ?? '');
  await setOutput('inline-comment-count', String(publication.assessment.counts.inlineSelected));
  await setOutput('inline-history-suppressed-count', String(publication.assessment.counts.inlineHistorySuppressed));
  await setOutput('inline-limit-omitted-count', String(publication.assessment.counts.inlineLimitOmitted));
  await setOutput('diff-truncated', String(diff.truncated));
  await setOutput('context-truncated', String(reviewContext.bundle.metadata.truncated));
  await setOutput('context-unavailable-source-count', String(reviewContext.bundle.metadata.unavailableSourceCount));
  await setOutput('review-mode', incremental.mode);
  await setOutput('analyzer-coverage', analyzer.summary.coverage);
  await setOutput('analyzer-run-count', String(analyzer.summary.runCount));
  await setOutput('analyzer-observation-count', String(analyzer.summary.acceptedObservations));
  await setOutput('analyzer-skipped-file-count', String(analyzer.summary.skippedFiles));
  await setOutput('new-finding-count', String(publication.lifecycle.counts.new));
  await setOutput('unchanged-finding-count', String(publication.lifecycle.counts.unchanged));
  await setOutput('resolved-finding-count', String(publication.lifecycle.counts.resolved));
  await setOutput('superseded-finding-count', String(publication.lifecycle.counts.superseded));
  await setOutput('code-indexer', config.codeIndexer);
  await setOutput('code-index-cache-hit', String(codeIndexCacheHit));
  console.log(`Published review: ${publication.comment.html_url}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::${workflowCommandValue(redactSecrets(message, secrets))}`);
  process.exitCode = 1;
});
