import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { getActionInput, loadActionConfig, managedCommentMarkers } from './config';
import { GitHubClient, loadPullRequestEvent } from './github';
import { redactSecrets } from './model';
import { runReview } from './review';
import { assertLinkedIssuesFresh, buildReviewContext } from './review-context';
import { executeAndPublishReview } from './review-publication';
import { acquireReviewedSnapshot, assertSnapshotFresh } from './review-snapshot';

function workflowCommandValue(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

async function setOutput(name: string, value: string): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
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
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is required');
  }

  const pullRequest = await loadPullRequestEvent(eventPath);
  const client = new GitHubClient(config.githubToken, process.env.GITHUB_API_URL ?? 'https://api.github.com');

  console.log(
    `Reviewing ${pullRequest.owner}/${pullRequest.repository}#${pullRequest.number} at ${pullRequest.headSha.slice(0, 12)} with ${config.backend}`,
  );
  const snapshot = await acquireReviewedSnapshot(client, pullRequest, config.maxDiffBytes);
  const authoritativePullRequest = snapshot.pullRequest;
  const diff = snapshot.diff;
  const actor = await client.getAuthenticatedActor();
  console.log(
    `Fetched ${diff.originalBytes} diff bytes${diff.truncated ? `; safely limited to ${config.maxDiffBytes}` : ''}`,
  );

  if (config.codeIndexer !== 'none') {
    console.log(`Installing and running ${config.codeIndexer} against the exact base revision`);
  }
  const reviewContext = await buildReviewContext({
    client,
    pullRequest: authoritativePullRequest,
    diff,
    indexer: config.codeIndexer,
    cacheKey: config.codeIndexCacheKey,
    cacheTtlMs: config.codeIndexCacheTtlMs,
  });
  const codeIndexCacheHit = reviewContext.cacheHit;
  console.log(
    `Prepared ${reviewContext.bundle.metadata.includedBytes} bounded review context bytes${codeIndexCacheHit ? ' from a fresh index cache' : ''}`,
  );

  const markers = managedCommentMarkers(config.backend);
  const publication = await executeAndPublishReview({
    executeReview: () =>
      runReview({
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
        secrets,
      }),
    assertFresh: async () => {
      await assertSnapshotFresh(client, authoritativePullRequest, snapshot.revision);
      await assertLinkedIssuesFresh(client, authoritativePullRequest, reviewContext.linkedIssueFingerprints);
    },
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
  });

  await setOutput('comment-url', publication.comment.html_url);
  await setOutput('review-url', publication.inlineReview?.html_url ?? '');
  await setOutput('inline-comment-count', String(publication.assessment.counts.inlineSelected));
  await setOutput('diff-truncated', String(diff.truncated));
  await setOutput('context-truncated', String(reviewContext.bundle.metadata.truncated));
  await setOutput('context-unavailable-source-count', String(reviewContext.bundle.metadata.unavailableSourceCount));
  await setOutput('code-indexer', config.codeIndexer);
  await setOutput('code-index-cache-hit', String(codeIndexCacheHit));
  console.log(`Published review: ${publication.comment.html_url}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::${workflowCommandValue(redactSecrets(message, secrets))}`);
  process.exitCode = 1;
});
