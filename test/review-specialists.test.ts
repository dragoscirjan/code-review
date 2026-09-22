import assert from 'node:assert/strict';
import { test } from 'vitest';
import { packReviewContext, type ContextRuntimeSummary } from '../src/context-planner';
import type { PullRequestContext } from '../src/github';
import type { ModelConnection } from '../src/model';
import type { StructuredBackendRequest } from '../src/review';
import { executeReviewStrategy, type StructuredBackendRunner } from '../src/review-specialists';
import { selectReviewStrategy } from '../src/review-strategy';
import { prepareReviewedDiff } from '../src/unified-diff';

const runtime: ContextRuntimeSummary = {
  indexer: 'none',
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
const context = packReviewContext([], runtime);
const diff = prepareReviewedDiff(
  [
    'diff --git a/src/value.ts b/src/value.ts',
    '--- a/src/value.ts',
    '+++ b/src/value.ts',
    '@@ -1 +1 @@',
    '-safe();',
    '+unsafe();',
  ].join('\n'),
  10_000,
);
const pullRequest: PullRequestContext = {
  owner: 'owner',
  repository: 'repo',
  number: 1,
  title: 'Change',
  body: '',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  author: 'author',
  url: 'https://example.test/pull/1',
};
const connection: ModelConnection = {
  api: 'openai-completions',
  baseUrl: 'https://models.example.test/v1',
  network: 'remote',
  modelId: 'provider/model',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};
const specialistPlan = selectReviewStrategy({ requested: 'specialists', diff, analyzerCoverage: 'complete' });

function finding(category: 'correctness' | 'security' | 'testing' | 'regression') {
  return {
    version: 1,
    outcome: 'findings',
    findings: [
      {
        category,
        severity: 'high',
        confidence: 1,
        location: { path: 'src/value.ts', side: 'RIGHT', line: 1 },
        evidence: 'unsafe();',
        explanation: `${category} problem.`,
        fix: 'Use safe behavior.',
      },
    ],
  };
}

function request(overrides: Partial<Parameters<typeof executeReviewStrategy>[0]> = {}) {
  return {
    plan: specialistPlan,
    backend: 'opencode' as const,
    containerEngine: 'podman' as const,
    connection,
    opencodeVersion: '1.18.31',
    piVersion: '0.85.1',
    customPrompt: 'Review carefully.',
    pullRequest,
    diff,
    reviewContext: context,
    priorFindings: [],
    policy: { minimumConfidence: 0, maximumInlineComments: 10 },
    secrets: ['synthetic-secret'],
    assertFresh: async () => undefined,
    timeoutMs: 60_000,
    specialistTokenBudget: 2_000_000,
    ...overrides,
  };
}

function runnerFrom(
  outputs: readonly string[],
  calls: StructuredBackendRequest<unknown>[] = [],
): StructuredBackendRunner {
  let index = 0;
  return async <T>(backendRequest: StructuredBackendRequest<T>): Promise<T> => {
    calls.push(backendRequest as StructuredBackendRequest<unknown>);
    const output = outputs[index++];
    if (output === undefined) throw new Error('Unexpected backend call');
    return backendRequest.parseAssistantText(output);
  };
}

const clean = JSON.stringify({ version: 1, outcome: 'clean', findings: [] });

test('runs fixed roles sequentially, validates candidates, and applies a reject-only arbiter', async () => {
  const calls: StructuredBackendRequest<unknown>[] = [];
  let active = 0;
  let maximumActive = 0;
  const outputs = [JSON.stringify(finding('correctness')), clean, clean, clean];
  let index = 0;
  const runner: StructuredBackendRunner = async <T>(backendRequest: StructuredBackendRequest<T>) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    calls.push(backendRequest as StructuredBackendRequest<unknown>);
    await Promise.resolve();
    const output = index < outputs.length ? outputs[index] : '{"version":1,"rejectedCandidateIds":[]}';
    index += 1;
    const parsed = backendRequest.parseAssistantText(output as string);
    active -= 1;
    return parsed;
  };
  let fresh = 0;
  const result = await executeReviewStrategy(
    request({ structuredRunner: runner, assertFresh: async () => void (fresh += 1) }),
  );
  assert.equal(maximumActive, 1);
  assert.equal(calls.length, 5);
  assert.deepEqual(
    calls.slice(0, 4).map((call) => call.connection.maxOutputTokens),
    [4096, 4096, 4096, 4096],
  );
  assert.equal(calls[4]?.connection.maxOutputTokens, 2048);
  assert.match(calls[0]?.prompt ?? '', /correctness specialist/u);
  assert.match(calls[1]?.prompt ?? '', /security specialist/u);
  assert.doesNotMatch(calls[1]?.prompt ?? '', /correctness problem/u);
  assert.equal(fresh, 10);
  assert.equal(result.summary.rolesCompleted, 4);
  assert.equal(result.summary.validatedCandidateCount, 1);
  assert.equal(result.summary.arbiterRan, true);
  assert.equal(result.review.findings.length, 1);
});

test('reserves enough completion space for reasoning specialists and arbiter output', async () => {
  const calls: StructuredBackendRequest<unknown>[] = [];
  const result = await executeReviewStrategy(
    request({
      connection: {
        ...connection,
        reasoning: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 943_718,
      },
      structuredRunner: runnerFrom(
        [JSON.stringify(finding('correctness')), clean, clean, clean, '{"version":1,"rejectedCandidateIds":[]}'],
        calls,
      ),
    }),
  );
  assert.deepEqual(
    calls.slice(0, 4).map((call) => call.connection.maxOutputTokens),
    [65_536, 65_536, 65_536, 65_536],
  );
  assert.equal(calls[4]?.connection.maxOutputTokens, 32_768);
  assert.ok(result.summary.reservedTokens < 2_000_000);
});

test('skips arbitration only when no candidate survives validation', async () => {
  const calls: StructuredBackendRequest<unknown>[] = [];
  const result = await executeReviewStrategy(
    request({ structuredRunner: runnerFrom([clean, clean, clean, clean], calls) }),
  );
  assert.equal(calls.length, 4);
  assert.equal(result.summary.arbiterRan, false);
  assert.equal(result.review.outcome, 'clean');
});

test('fails closed on role breach, candidate flood, malformed arbiter, secrets, and budget exhaustion', async () => {
  const wrongCategory = runnerFrom([JSON.stringify(finding('security'))]);
  await assert.rejects(
    executeReviewStrategy(request({ structuredRunner: wrongCategory })),
    /outside its fixed category/u,
  );

  const flooded = {
    ...finding('correctness'),
    findings: Array.from({ length: 4 }, () => finding('correctness').findings[0]),
  };
  await assert.rejects(
    executeReviewStrategy(request({ structuredRunner: runnerFrom([JSON.stringify(flooded)]) })),
    /exceeded its finding limit/u,
  );

  await assert.rejects(
    executeReviewStrategy(
      request({
        structuredRunner: runnerFrom([JSON.stringify(finding('correctness')), clean, clean, clean, 'not json']),
      }),
    ),
    /strict JSON/u,
  );

  const contaminated = finding('correctness');
  contaminated.findings[0]!.explanation = 'synthetic-secret';
  await assert.rejects(
    executeReviewStrategy(request({ structuredRunner: runnerFrom([JSON.stringify(contaminated)]) })),
    /forbidden secret/u,
  );

  const calls: StructuredBackendRequest<unknown>[] = [];
  await assert.rejects(
    executeReviewStrategy(request({ specialistTokenBudget: 20_000, structuredRunner: runnerFrom([], calls) })),
    /token reservation/u,
  );
  assert.equal(calls.length, 0);
});

test('the aggregate deadline is shared and checked between phases', async () => {
  const times = [0, 0, 1, 61_000];
  let index = 0;
  const calls: StructuredBackendRequest<unknown>[] = [];
  await assert.rejects(
    executeReviewStrategy(
      request({
        structuredRunner: runnerFrom([clean], calls),
        now: () => times[Math.min(index++, times.length - 1)] as number,
      }),
    ),
    /deadline expired/u,
  );
  assert.equal(calls.length, 1);
});

test('terminal freshness overruns fail the no-candidate, post-arbiter, and single-pass paths', async () => {
  const terminalOverrun = async (outputs: readonly string[], expireAtCheck: number, plan = specialistPlan) => {
    let time = 0;
    let freshnessChecks = 0;
    const calls: StructuredBackendRequest<unknown>[] = [];
    const execution = executeReviewStrategy(
      request({
        plan,
        structuredRunner: runnerFrom(outputs, calls),
        singleRunner: async () => ({ version: 1, outcome: 'clean', findings: [] }),
        now: () => time,
        assertFresh: async () => {
          freshnessChecks += 1;
          if (freshnessChecks === expireAtCheck) time = 60_001;
        },
      }),
    );
    await assert.rejects(execution, /deadline expired/u);
    return { calls, freshnessChecks };
  };

  const noCandidate = await terminalOverrun([clean, clean, clean, clean], 8);
  assert.equal(noCandidate.calls.length, 4);
  assert.equal(noCandidate.freshnessChecks, 8);

  const postArbiter = await terminalOverrun(
    [JSON.stringify(finding('correctness')), clean, clean, clean, '{"version":1,"rejectedCandidateIds":[]}'],
    10,
  );
  assert.equal(postArbiter.calls.length, 5);
  assert.equal(postArbiter.freshnessChecks, 10);

  const singlePlan = selectReviewStrategy({ requested: 'single-pass', diff, analyzerCoverage: 'complete' });
  const singlePass = await terminalOverrun([], 2, singlePlan);
  assert.equal(singlePass.calls.length, 0);
  assert.equal(singlePass.freshnessChecks, 2);
});

test('freshness failure between required phases prevents later backend calls', async () => {
  const calls: StructuredBackendRequest<unknown>[] = [];
  let checks = 0;
  await assert.rejects(
    executeReviewStrategy(
      request({
        structuredRunner: runnerFrom([clean, clean, clean, clean], calls),
        assertFresh: async () => {
          checks += 1;
          if (checks === 4) throw new Error('stale snapshot');
        },
      }),
    ),
    /stale snapshot/u,
  );
  assert.equal(calls.length, 2);
});

test('candidate ordering and arbiter input are independent of reviewer array order', async () => {
  const first = finding('correctness').findings[0]!;
  const second = {
    ...first,
    location: { ...first.location, side: 'LEFT' as const },
    evidence: 'safe();',
    explanation: 'Removed safety.',
  };
  const review = (findings: unknown[]) => JSON.stringify({ version: 1, outcome: 'findings', findings });
  const arbiterPrompt = async (findings: unknown[]) => {
    const calls: StructuredBackendRequest<unknown>[] = [];
    await executeReviewStrategy(
      request({
        structuredRunner: runnerFrom(
          [review(findings), clean, clean, clean, '{"version":1,"rejectedCandidateIds":[]}'],
          calls,
        ),
      }),
    );
    return calls[4]?.prompt;
  };
  const normalizeBoundaries = (prompt: string | undefined) =>
    prompt?.replace(/<\/?CODE_REVIEW_UNTRUSTED_[A-Z_]+_[^>]+>/gu, '<BOUNDARY>');
  assert.equal(
    normalizeBoundaries(await arbiterPrompt([first, second])),
    normalizeBoundaries(await arbiterPrompt([second, first])),
  );
});

test('same-anchor candidates collapse by publication priority before arbitration', async () => {
  const lowerPriority = finding('correctness');
  lowerPriority.findings[0]!.severity = 'high';
  const higherPriority = finding('security');
  higherPriority.findings[0]!.severity = 'critical';
  const result = await executeReviewStrategy(
    request({
      structuredRunner: runnerFrom([
        JSON.stringify(lowerPriority),
        JSON.stringify(higherPriority),
        clean,
        clean,
        '{"version":1,"rejectedCandidateIds":[]}',
      ]),
    }),
  );
  assert.equal(result.review.findings.length, 1);
  assert.equal(result.review.findings[0]?.category, 'security');
  assert.equal(result.summary.preArbiterOmittedCount, 1);
});

test('recorded overflow evaluation is deterministic, priority-aware, and reserves a candidate for every role', async () => {
  const overflowDiff = prepareReviewedDiff(
    [
      'diff --git a/src/overflow.ts b/src/overflow.ts',
      '--- /dev/null',
      '+++ b/src/overflow.ts',
      '@@ -0,0 +1,12 @@',
      ...Array.from({ length: 12 }, (_, index) => `+value${index + 1}();`),
    ].join('\n'),
    20_000,
  );
  const categories = ['correctness', 'security', 'testing', 'regression'] as const;
  const severities = [
    ['low', 'low', 'low'],
    ['medium', 'medium', 'medium'],
    ['low', 'low', 'low'],
    ['critical', 'high', 'high'],
  ] as const;
  const output = (roleIndex: number, reverse: boolean) => {
    const findings = Array.from({ length: 3 }, (_, candidateIndex) => {
      const line = roleIndex * 3 + candidateIndex + 1;
      return {
        category: categories[roleIndex],
        severity: severities[roleIndex]?.[candidateIndex],
        confidence: 1,
        location: { path: 'src/overflow.ts', side: 'RIGHT', line },
        evidence: `value${line}();`,
        explanation: `Problem at ${line}.`,
        fix: `Fix ${line}.`,
      };
    });
    return JSON.stringify({ version: 1, outcome: 'findings', findings: reverse ? findings.reverse() : findings });
  };
  const execute = async (reverse: boolean) =>
    executeReviewStrategy(
      request({
        diff: overflowDiff,
        plan: selectReviewStrategy({ requested: 'specialists', diff: overflowDiff, analyzerCoverage: 'complete' }),
        structuredRunner: runnerFrom([
          output(0, reverse),
          output(1, reverse),
          output(2, reverse),
          output(3, reverse),
          '{"version":1,"rejectedCandidateIds":[]}',
        ]),
      }),
    );
  const first = await execute(false);
  const reordered = await execute(true);
  const selectedLines = first.review.findings.map((item) => item.location.line).sort((a, b) => a - b);
  assert.equal(first.review.findings.length, 10);
  assert.equal(first.summary.preArbiterOmittedCount, 2);
  assert.deepEqual(new Set(first.review.findings.map((item) => item.category)), new Set(categories));
  assert.ok(selectedLines.includes(10) && selectedLines.includes(11) && selectedLines.includes(12));
  assert.deepEqual(reordered.review, first.review);
  assert.deepEqual(reordered.summary, first.summary);
});

test('arbiter prompt exposes only the immutable security policy and reject-only v1 schema', async () => {
  const calls: StructuredBackendRequest<unknown>[] = [];
  await executeReviewStrategy(
    request({
      structuredRunner: runnerFrom(
        [JSON.stringify(finding('correctness')), clean, clean, clean, '{"version":1,"rejectedCandidateIds":[]}'],
        calls,
      ),
    }),
  );
  const prompt = calls[4]?.prompt ?? '';
  assert.match(prompt, /Reject-only arbiter v1 policy/u);
  assert.match(prompt, /"rejectedCandidateIds"/u);
  assert.doesNotMatch(prompt, /A clean review|root object has exactly|"outcome"|1 to 10 findings/u);
});

test('single-pass remains the default selected execution for a low-risk auto plan', async () => {
  const plan = selectReviewStrategy({ requested: 'auto', diff, analyzerCoverage: 'complete' });
  let calls = 0;
  const result = await executeReviewStrategy(
    request({
      plan,
      singleRunner: async () => {
        calls += 1;
        return { version: 1, outcome: 'clean', findings: [] };
      },
    }),
  );
  assert.equal(plan.selected, 'single-pass');
  assert.equal(calls, 1);
  assert.equal(result.summary.rolesCompleted, 0);
});
