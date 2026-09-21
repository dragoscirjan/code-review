import { createHash } from 'node:crypto';
import type { AnalyzerSummary } from './analyzer';
import type { AnalyzerFindingCandidate } from './analyzer-contract';
import { renderComment, renderInlineComment } from './comment';
import type { ReviewContextMetadata } from './context-planner';
import { assessReview, type ReviewAssessment, type ValidatedFinding } from './finding-validation';
import type {
  AuthenticatedActor,
  GitHubClient,
  GitHubInlineCommentInput,
  ManagedCommentLease,
  PullRequestContext,
  PullRequestDiff,
} from './github';
import { findingAnchorIsCovered, remapPriorFinding } from './incremental-review';
import { redactSecrets } from './model';
import type { ReviewBackend } from './review';
import type { ReviewResultV1 } from './review-contract';
import {
  MAX_REVIEW_STATE_FINDINGS,
  publicationDigest,
  reconcileFindingStates,
  serializeReviewState,
  type ReviewMode,
  type ReviewStateFinding,
  type ReviewStateV1,
} from './review-lifecycle';
import type { ExecutedReview, ReviewExecutionSummary } from './review-specialists';

export interface ExecuteAndPublishReviewInput {
  executeReview: () => Promise<ReviewResultV1 | ExecutedReview>;
  assertFresh: () => Promise<void>;
  assertStateFresh?: () => Promise<void>;
  client: Pick<GitHubClient, 'createOrReuseInlineReview' | 'upsertManagedComment'> &
    Partial<
      Pick<GitHubClient, 'listPullRequestReviewComments' | 'listPullRequestReviews' | 'assertManagedCommentLease'>
    >;
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
  analyzer?: { findings: readonly AnalyzerFindingCandidate[]; summary: AnalyzerSummary };
  lifecycle?: {
    apiUrl: string;
    policyDigest: string;
    reviewInputDigest: string;
    mode: ReviewMode;
    reason: string;
    fromHeadSha: string | null;
    priorState?: ReviewStateV1;
    carried: readonly ReviewStateFinding[];
    affected: readonly ReviewStateFinding[];
    lease: ManagedCommentLease | null;
  };
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

function inlineMarker(backend: ReviewBackend, fingerprint: string): string {
  return `<!-- code-review-inline:${backend}:v2:${fingerprint.replace(/^sha256:/u, '')} -->`;
}

function batchMarker(input: ExecuteAndPublishReviewInput, comments: readonly GitHubInlineCommentInput[]): string {
  const digest = createHash('sha256')
    .update('code-review/inline-operation/v2\0')
    .update(input.pullRequest.owner)
    .update('\0')
    .update(input.pullRequest.repository)
    .update('\0')
    .update(String(input.pullRequest.number))
    .update('\0')
    .update(input.pullRequest.headSha)
    .update('\0')
    .update(input.backend)
    .update('\0')
    .update(JSON.stringify(comments))
    .digest('base64url');
  return `<!-- code-review-inline-operation:${input.backend}:v2:${digest} -->`;
}

function assertPayloadsContainNoSecrets(payloads: readonly string[], secrets: readonly string[]): void {
  for (const secret of [...new Set(secrets)].filter(Boolean)) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (payloads.some((payload) => payload.includes(secret) || (escaped !== secret && payload.includes(escaped)))) {
      throw new Error('Publication payload contains forbidden secret data');
    }
  }
}

function assertLifecycleCoverage(input: ExecuteAndPublishReviewInput): void {
  const lifecycle = input.lifecycle;
  if (!lifecycle?.priorState) return;
  if (!input.diff.parsed || !input.diff.completeParsed) {
    throw new Error('Lifecycle review is missing an authoritative complete line map');
  }
  const priorActive = lifecycle.priorState.findings.filter(
    (finding) => finding.state === 'new' || finding.state === 'unchanged',
  );
  const carried = new Map(lifecycle.carried.map((finding) => [finding.fingerprint, finding]));
  const affected = new Map(lifecycle.affected.map((finding) => [finding.fingerprint, finding]));
  if (carried.size !== lifecycle.carried.length || affected.size !== lifecycle.affected.length) {
    throw new Error('Lifecycle finding coverage is ambiguous');
  }
  for (const prior of priorActive) {
    const planned = carried.get(prior.fingerprint) ?? affected.get(prior.fingerprint);
    if (!planned || (carried.has(prior.fingerprint) && affected.has(prior.fingerprint))) {
      throw new Error('Lifecycle coverage does not partition prior findings');
    }
    const remapped = remapPriorFinding(input.diff.completeParsed, prior)?.state;
    if (carried.has(prior.fingerprint)) {
      if (
        !remapped ||
        remapped.path !== planned.path ||
        remapped.side !== planned.side ||
        remapped.line !== planned.line ||
        remapped.anchorFingerprint !== planned.anchorFingerprint
      ) {
        throw new Error('Lifecycle review cannot uniquely remap a carried prior finding');
      }
      if (findingAnchorIsCovered(input.diff.parsed, remapped)) {
        throw new Error('A carried prior finding is unexpectedly inside reviewed coverage');
      }
    } else if (input.diff.truncated && (!remapped || !findingAnchorIsCovered(input.diff.parsed, remapped))) {
      throw new Error('Truncated lifecycle review cannot uniquely remap or cover an affected prior finding');
    }
  }
  if (carried.size + affected.size !== priorActive.length) {
    throw new Error('Lifecycle coverage contains an unknown prior finding');
  }
}

function historicalFingerprints(
  comments: readonly { body: string | null; user: { id: number } | null; in_reply_to_id?: number }[],
  actorId: number,
  backend: ReviewBackend,
): Set<string> {
  const pattern = new RegExp(`^<!-- code-review-inline:${backend}:v2:([A-Za-z0-9_-]{43}) -->$`, 'u');
  const fingerprints = new Set<string>();
  for (const comment of comments) {
    if (comment.user?.id !== actorId || comment.in_reply_to_id !== undefined || typeof comment.body !== 'string')
      continue;
    const match = pattern.exec(comment.body.trimEnd().split(/\r?\n/u).at(-1) ?? '');
    if (match?.[1]) fingerprints.add(`sha256:${match[1]}`);
  }
  return fingerprints;
}

function serializeBoundedState(
  initial: ReviewStateV1,
  priorCompletedThroughHeadSha: string | null,
): { state: ReviewStateV1; stateLine: string } {
  let state = initial;
  while (true) {
    try {
      return { state, stateLine: serializeReviewState(state) };
    } catch (error) {
      const tombstoneIndex = state.findings.findIndex(
        (finding) => finding.state === 'resolved' || finding.state === 'superseded',
      );
      if (tombstoneIndex >= 0) {
        state = { ...state, findings: state.findings.filter((_finding, index) => index !== tombstoneIndex) };
        continue;
      }
      const activeIndex = state.findings
        .map((finding) => finding.state === 'new' || finding.state === 'unchanged')
        .lastIndexOf(true);
      if (activeIndex < 0) throw error;
      const findings = state.findings.filter((_finding, index) => index !== activeIndex);
      const fingerprints = findings
        .filter((finding) => finding.state === 'new' || finding.state === 'unchanged')
        .map((finding) => finding.fingerprint);
      state = {
        ...state,
        coverageComplete: false,
        completedThroughHeadSha: priorCompletedThroughHeadSha,
        publicationDigest: publicationDigest({
          repository: state.repository,
          pullRequest: state.pullRequest,
          backend: state.backend,
          actorId: state.actorId,
          headSha: state.headSha,
          fingerprints,
        }),
        findings,
      };
    }
  }
}

/** Validates and renders every payload before the first write, then publishes one deduplicated inline batch. */
export async function executeAndPublishReview(input: ExecuteAndPublishReviewInput) {
  const marker = input.markers[0];
  if (!marker) throw new Error('At least one managed-comment marker is required');
  await input.assertFresh();
  await input.assertStateFresh?.();
  if (!input.diff.parsed) throw new Error('Reviewed diff is missing its validated line map');
  assertLifecycleCoverage(input);
  const executed = await input.executeReview();
  const review = 'review' in executed ? executed.review : executed;
  const executionSummary: ReviewExecutionSummary | undefined = 'review' in executed ? executed.summary : undefined;
  let assessment = redactAssessment(
    assessReview(
      review,
      input.diff.parsed,
      {
        minimumConfidence: input.minimumConfidence,
        maximumInlineComments: input.maximumInlineComments,
      },
      input.secrets,
      input.analyzer?.findings ?? [],
    ),
    input.secrets,
  );

  const lifecycle = input.lifecycle;
  const priorActive = lifecycle?.priorState?.findings ?? [];
  const carried = lifecycle?.carried ?? [];
  const reconciled = reconcileFindingStates(assessment.findings, priorActive, input.pullRequest.headSha, carried);
  const persistedActive = reconciled.active.slice(0, MAX_REVIEW_STATE_FINDINGS);
  const coverageComplete =
    !input.diff.truncated &&
    input.analyzer?.summary.coverage !== 'partial' &&
    persistedActive.length === reconciled.active.length;
  const completedThroughHeadSha = coverageComplete
    ? input.pullRequest.headSha
    : (lifecycle?.priorState?.completedThroughHeadSha ?? null);
  let state: ReviewStateV1 | undefined = lifecycle
    ? {
        version: 1,
        apiUrl: lifecycle.apiUrl,
        repository: `${input.pullRequest.owner}/${input.pullRequest.repository}`,
        pullRequest: input.pullRequest.number,
        backend: input.backend,
        actorId: input.actor.id,
        baseSha: input.pullRequest.baseSha,
        headSha: input.pullRequest.headSha,
        completedThroughHeadSha,
        generation: (lifecycle.priorState?.generation ?? 0) + 1,
        policyDigest: lifecycle.policyDigest,
        reviewInputDigest: lifecycle.reviewInputDigest,
        publicationDigest: publicationDigest({
          repository: `${input.pullRequest.owner}/${input.pullRequest.repository}`,
          pullRequest: input.pullRequest.number,
          backend: input.backend,
          actorId: input.actor.id,
          headSha: input.pullRequest.headSha,
          fingerprints: persistedActive.map((finding) => finding.fingerprint),
        }),
        inlineHistorySuppressed: 0,
        inlineLimitOmitted: 0,
        coverageComplete,
        mode: lifecycle.mode,
        fromHeadSha: lifecycle.fromHeadSha,
        findings: [...persistedActive, ...reconciled.tombstones].slice(0, MAX_REVIEW_STATE_FINDINGS),
      }
    : undefined;
  const reviewComments = input.client.listPullRequestReviewComments
    ? await input.client.listPullRequestReviewComments(input.pullRequest)
    : [];
  const published = historicalFingerprints(reviewComments, input.actor.id, input.backend);
  let suppressLegacyMigration = false;
  if (lifecycle?.mode === 'migration' && input.client.listPullRequestReviews) {
    const legacyPattern = new RegExp(`^<!-- code-review-inline:${input.backend}:v1:[0-9a-f]{32} -->$`, 'u');
    suppressLegacyMigration = (await input.client.listPullRequestReviews(input.pullRequest)).some(
      (existing) =>
        existing.user?.id === input.actor.id &&
        typeof existing.body === 'string' &&
        legacyPattern.test(existing.body.trimEnd().split(/\r?\n/u).at(-1) ?? ''),
    );
  }
  const eligible = suppressLegacyMigration
    ? []
    : assessment.findings.filter((finding) => !published.has(finding.fingerprint));
  const selected = eligible.slice(0, input.maximumInlineComments);
  const inlineHistorySuppressed = suppressLegacyMigration
    ? assessment.findings.length
    : assessment.findings.length - eligible.length;
  const inlineLimitOmitted = eligible.length - selected.length;
  assessment = {
    ...assessment,
    inlineFindings: selected,
    counts: {
      ...assessment.counts,
      inlineSelected: selected.length,
      inlineHistorySuppressed,
      inlineLimitOmitted,
      inlineOmitted: inlineHistorySuppressed + inlineLimitOmitted,
    },
  };
  let stateLine: string | undefined;
  if (state) {
    state = { ...state, inlineHistorySuppressed, inlineLimitOmitted };
    const serialized = serializeBoundedState(state, lifecycle?.priorState?.completedThroughHeadSha ?? null);
    state = serialized.state;
    stateLine = serialized.stateLine;
  }
  const inlineComments: GitHubInlineCommentInput[] = selected.map((finding) => ({
    path: finding.location.path,
    side: finding.location.side,
    line: finding.location.line,
    body: renderInlineComment(finding, inlineMarker(input.backend, finding.fingerprint)),
  }));
  const operationMarker = batchMarker(input, inlineComments);
  const summaryBody = renderComment({
    assessment,
    backend: input.backend,
    model: input.model,
    headSha: input.pullRequest.headSha,
    actor: input.actor.login,
    diffTruncated: input.diff.truncated,
    originalDiffBytes: input.diff.originalBytes,
    contextMetadata: input.contextMetadata,
    analyzerSummary: input.analyzer?.summary,
    executionSummary,
    ...(stateLine && lifecycle
      ? {
          lifecycle: {
            mode: lifecycle.mode,
            reason: lifecycle.reason,
            fromHeadSha: lifecycle.fromHeadSha,
            counts: reconciled.counts,
            active: reconciled.active,
            tombstones: reconciled.tombstones,
            stateLine,
          },
        }
      : {}),
    marker,
  });
  assertPayloadsContainNoSecrets(
    [
      summaryBody,
      operationMarker,
      stateLine ?? '',
      ...inlineComments.flatMap((comment) => [comment.path, comment.body]),
    ],
    input.secrets,
  );

  await input.assertFresh();
  await input.assertStateFresh?.();
  const inlineReview =
    inlineComments.length > 0
      ? await input.client.createOrReuseInlineReview(
          input.pullRequest,
          input.actor,
          input.pullRequest.headSha,
          operationMarker,
          inlineComments,
        )
      : undefined;
  if (inlineReview) {
    await input.assertFresh();
    await input.assertStateFresh?.();
  }
  const comment = await input.client.upsertManagedComment(
    input.pullRequest,
    input.actor,
    input.markers,
    summaryBody,
    lifecycle?.lease,
  );
  await input.assertFresh();
  return { comment, inlineReview, assessment, lifecycle: reconciled, state, executionSummary };
}
