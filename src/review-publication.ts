import { createHash } from 'node:crypto';
import { renderComment, renderInlineComment } from './comment';
import type { ReviewContextMetadata } from './context-planner';
import { assessReview, type ReviewAssessment, type ValidatedFinding } from './finding-validation';
import type {
  AuthenticatedActor,
  GitHubClient,
  GitHubInlineCommentInput,
  PullRequestContext,
  PullRequestDiff,
} from './github';
import { redactSecrets } from './model';
import type { ReviewBackend } from './review';
import type { ReviewResultV1 } from './review-contract';

export interface ExecuteAndPublishReviewInput {
  executeReview: () => Promise<ReviewResultV1>;
  assertFresh: () => Promise<void>;
  client: Pick<GitHubClient, 'createOrReuseInlineReview' | 'upsertManagedComment'>;
  pullRequest: PullRequestContext;
  diff: PullRequestDiff;
  actor: AuthenticatedActor;
  markers: readonly string[];
  backend: ReviewBackend;
  model: string;
  secrets: readonly string[];
  minimumConfidence: number;
  maximumInlineComments: number;
  contextMetadata?: ReviewContextMetadata;
}

function redactFinding(finding: ValidatedFinding, secrets: readonly string[]): ValidatedFinding {
  return {
    ...finding,
    explanation: redactSecrets(finding.explanation, secrets),
    fix: redactSecrets(finding.fix, secrets),
  };
}

function redactAssessment(assessment: ReviewAssessment, secrets: readonly string[]): ReviewAssessment {
  const findings = assessment.findings.map((finding) => redactFinding(finding, secrets));
  return {
    ...assessment,
    findings,
    inlineFindings: findings.slice(0, assessment.counts.inlineSelected),
  };
}

function inlineMarker(input: ExecuteAndPublishReviewInput, assessment: ReviewAssessment): string {
  const digest = createHash('sha256')
    .update(input.pullRequest.headSha)
    .update('\0')
    .update(input.backend)
    .update('\0')
    .update(
      JSON.stringify(
        assessment.inlineFindings.map((finding) => [
          finding.location.path,
          finding.location.side,
          finding.location.line,
          finding.category,
          finding.severity,
          finding.confidence,
          finding.evidence,
          finding.explanation,
          finding.fix,
        ]),
      ),
    )
    .digest('hex')
    .slice(0, 32);
  return `<!-- code-review-inline:${input.backend}:v1:${digest} -->`;
}

function assertPayloadsContainNoSecrets(payloads: readonly string[], secrets: readonly string[]): void {
  for (const secret of [...new Set(secrets)].filter(Boolean)) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (payloads.some((payload) => payload.includes(secret) || (escaped !== secret && payload.includes(escaped)))) {
      throw new Error('Publication payload contains forbidden secret data');
    }
  }
}

/** Validates and renders every payload before the first write, then uses one batch for all inline comments. */
export async function executeAndPublishReview(input: ExecuteAndPublishReviewInput) {
  const marker = input.markers[0];
  if (!marker) throw new Error('At least one managed-comment marker is required');
  await input.assertFresh();
  const review = await input.executeReview();
  if (!input.diff.parsed) throw new Error('Reviewed diff is missing its validated line map');
  const assessment = redactAssessment(
    assessReview(
      review,
      input.diff.parsed,
      {
        minimumConfidence: input.minimumConfidence,
        maximumInlineComments: input.maximumInlineComments,
      },
      input.secrets,
    ),
    input.secrets,
  );
  const reviewMarker = inlineMarker(input, assessment);
  const inlineComments: GitHubInlineCommentInput[] = assessment.inlineFindings.map((finding) => ({
    path: finding.location.path,
    side: finding.location.side,
    line: finding.location.line,
    body: renderInlineComment(finding, reviewMarker),
  }));
  const summaryBody = renderComment({
    assessment,
    backend: input.backend,
    model: input.model,
    headSha: input.pullRequest.headSha,
    actor: input.actor.login,
    diffTruncated: input.diff.truncated,
    originalDiffBytes: input.diff.originalBytes,
    contextMetadata: input.contextMetadata,
    marker,
  });
  assertPayloadsContainNoSecrets(
    [summaryBody, reviewMarker, ...inlineComments.flatMap((comment) => [comment.path, comment.body])],
    input.secrets,
  );

  await input.assertFresh();
  const inlineReview =
    inlineComments.length > 0
      ? await input.client.createOrReuseInlineReview(
          input.pullRequest,
          input.actor,
          input.pullRequest.headSha,
          reviewMarker,
          inlineComments,
        )
      : undefined;
  if (inlineReview) await input.assertFresh();
  const comment = await input.client.upsertManagedComment(input.pullRequest, input.actor, input.markers, summaryBody);
  return { comment, inlineReview, assessment };
}
